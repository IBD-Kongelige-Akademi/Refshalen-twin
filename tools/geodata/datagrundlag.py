"""datagrundlag.dk (MapCentia's open mirror of the Danish basic data) for build_city.py: no account, public S3 bucket.

Every dataset has a `latest.json` naming the current snapshot's files; nothing here hard-codes a snapshot path:

    https://datagrundlag.s3.eu-west-1.amazonaws.com/filer/dk/schema=<source>/relation=<table>/latest.json

Geometry tables are read from their FlatGeobuf with a bbox (the file has a spatial index, so only the box is downloaded),
tables without geometry (BBR) from their GeoParquet with DuckDB, filtered to one kommune. Results are cached as JSON under
data/raw/city/ (`dg_<source>_<table>.json`), and every snapshot date read is recorded in data/raw/city/dg_snapshots.json
(the coverage report prints them). The mirror is unofficial: a path change or an outage only affects a refetch.

    uv run tools/geodata/datagrundlag.py geodanmark bygning      # print the current snapshot of one dataset
"""
from __future__ import annotations

import json
import os
import sys
import threading
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW_CITY = ROOT / "data" / "raw" / "city"
BASE = "https://datagrundlag.s3.eu-west-1.amazonaws.com/filer/dk"
SNAPSHOTS = RAW_CITY / "dg_snapshots.json"
UA = "aalborg-twin-geodata/0.1 (open-data compiler)"

# BBR code lists (byg032 Ydervæggens materiale, byg033 Tagdækningsmateriale) -> the lower-case texts the compiler keys on
# (presets.TONES for walls, buildings.FLAT_ROOFS / PITCHED_ROOFS and far_lod.ROOF_COLOURS for roofs). 80 (Ingen) is no material.
WALL_TEXT = {"1": "mursten", "2": "letbetonsten", "3": "fibercement", "4": "bindingsværk", "5": "træ", "6": "betonelementer",
             "8": "metal", "10": "fibercement", "11": "andet materiale", "12": "glas", "90": "andet materiale"}
ROOF_TEXT = {"1": "tagpap med lille hældning", "2": "tagpap med stor hældning", "3": "fibercement herunder asbest", "4": "betontagsten",
             "5": "tegl", "6": "metal", "7": "stråtag", "10": "fibercement uden asbest", "11": "plastmaterialer", "12": "glas",
             "20": "levende tage", "90": "andet materiale"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def latest(source: str, table: str) -> dict:
    """The dataset's latest.json: {'snapshot_date', 'assets': {'data'|'flatgeobuf'|...: {'href'}}}."""
    req = urllib.request.Request(f"{BASE}/schema={source}/relation={table}/latest.json", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def asset_url(source: str, table: str, kind: str) -> tuple[str, str]:
    """(URL of the current file of `kind` ('flatgeobuf' or 'data' = GeoParquet), snapshot date)."""
    d = latest(source, table)
    href = d["assets"][kind]["href"]
    return f"{BASE}/schema={source}/relation={table}/{href.removeprefix('./')}", d["snapshot_date"]


_lock = threading.Lock()  # build_city fetches several datasets in threads; they share the snapshot log


def record_snapshot(source: str, table: str, date: str, **info) -> None:
    with _lock:
        doc = snapshots()
        doc[f"{source}/{table}"] = {"snapshot_date": date, **info}
        _write(SNAPSHOTS, json.dumps(doc, indent=1, ensure_ascii=False))


def snapshots() -> dict:
    return json.loads(SNAPSHOTS.read_text(encoding="utf-8")) if SNAPSHOTS.exists() else {}


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def cache_path(source: str, table: str, suffix: str = "") -> Path:
    return RAW_CITY / f"dg_{source}_{table}{suffix}.json"


def fetch_features(source: str, table: str, bbox=None, where: str | None = None, columns=None, force: bool = False,
                   suffix: str = "") -> dict:
    """A FeatureCollection (EPSG:25832) of the features in `bbox` (minE, minN, maxE, maxN) and/or matching the OGR SQL `where`,
    cached under data/raw/city/. `columns` limits the attributes kept."""
    p = cache_path(source, table, suffix)
    if p.exists() and not force:
        return json.loads(p.read_text(encoding="utf-8"))
    import pyogrio

    url, date = asset_url(source, table, "flatgeobuf")
    kw = {}
    if bbox is not None:
        kw["bbox"] = tuple(float(v) for v in bbox)
    if where:
        kw["where"] = where
    if columns:
        kw["columns"] = list(columns)
    df = pyogrio.read_dataframe("/vsicurl/" + url, **kw)
    if df.crs is not None and df.crs.to_epsg() != 25832:
        df = df.to_crs(25832)
    fc = json.loads(df.to_json(drop_id=True, na="null"))
    fc["source"] = f"datagrundlag.dk {source}.{table}, snapshot {date}"
    _write(p, json.dumps(fc, ensure_ascii=False, separators=(",", ":")))
    record_snapshot(source, table, date, features=len(fc["features"]))
    log(f"[datagrundlag] {source}.{table} ({date}): {len(fc['features'])} features")
    return fc


def fetch_bbr_bygning(kommunekode: str, force: bool = False) -> dict:
    """BBR bygning of one kommune, {id_lokalid: {use, year, wall, roof, storeys, status, wall_code, roof_code}}, from the
    GeoParquet with DuckDB. Column names are matched by their BBR field number (the mirror spells them with æ/ø/å)."""
    p = cache_path("bbr", "bygning", f"_{kommunekode}")
    if p.exists() and not force:
        return json.loads(p.read_text(encoding="utf-8"))
    import duckdb

    url, date = asset_url("bbr", "bygning", "data")
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='eu-west-1';")
    cols = [c[0] for c in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{url}')").fetchall()]

    def col(prefix: str) -> str:
        return next(c for c in cols if c.startswith(prefix))

    pick = {"use": col("byg021"), "year": col("byg026"), "wall_code": col("byg032"), "roof_code": col("byg033"),
            "storeys": col("byg054"), "status": "status"}
    sel = ", ".join(f'"{v}"' for v in pick.values())
    rows = con.execute(f'SELECT id_lokalid, {sel} FROM read_parquet(\'{url}\') WHERE kommunekode = ?', [kommunekode.zfill(4)]).fetchall()

    def num(v):
        v = (v or "").strip()
        return int(v) if v.lstrip("-").isdigit() else None

    out = {}
    for r in rows:
        rec = dict(zip(pick, r[1:]))
        storeys = num(rec["storeys"])
        out[r[0].lower()] = {"use": num(rec["use"]), "year": num(rec["year"]) or None, "storeys": storeys if storeys and storeys > 0 else None,
                             "wall": WALL_TEXT.get((rec["wall_code"] or "").strip()), "roof": ROOF_TEXT.get((rec["roof_code"] or "").strip()),
                             "wall_code": rec["wall_code"] or None, "roof_code": rec["roof_code"] or None, "status": rec["status"]}
    _write(p, json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    record_snapshot("bbr", "bygning", date, kommunekode=kommunekode, records=len(out))
    log(f"[datagrundlag] bbr.bygning ({date}) kommune {kommunekode}: {len(out)} records")
    return out


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: datagrundlag.py <source> <table>")
    print(json.dumps(latest(sys.argv[1], sys.argv[2]), indent=1))
