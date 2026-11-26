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


def _read_geoparquet(url: str, bbox, where: str | None, columns) -> dict:
    """GeoParquet 1.1 (EPSG:25832, WKB + bbox covering column) -> FeatureCollection, reading only the row groups whose
    bbox statistics touch `bbox`. `where` supports the one form the compiler uses: "<col> IN ('a', 'b')"."""
    import re
    import fsspec
    import pyarrow.dataset as ds
    import pyarrow.parquet as pq
    from shapely import wkb
    from shapely.geometry import box as _box, mapping

    fs = fsspec.filesystem("https", client_kwargs={"trust_env": True})
    with fs.open(url, block_size=1 << 20) as fh:
        meta = json.loads(pq.ParquetFile(fh).metadata.metadata[b"geo"])
    gcol = meta["primary_column"]
    cov = (meta["columns"][gcol].get("covering") or {}).get("bbox")
    bcol = cov["xmin"][0] if cov else f"{gcol}_bbox"
    dset = ds.dataset(url, filesystem=fs, format="parquet")
    flt = None
    if bbox is not None:
        e0, n0, e1, n1 = (float(v) for v in bbox)
        f = ds.field
        flt = (f(bcol, "xmax") >= e0) & (f(bcol, "xmin") <= e1) & (f(bcol, "ymax") >= n0) & (f(bcol, "ymin") <= n1)
    if where:
        m = re.fullmatch(r"\s*(\w+)\s+IN\s*\((.*)\)\s*", where, re.I)
        if not m:
            raise ValueError(f"unsupported where: {where}")
        vals = [v.strip().strip("'\"") for v in m.group(2).split(",")]
        w = ds.field(m.group(1)).isin(vals)
        flt = w if flt is None else flt & w
    names = dset.schema.names
    keep = [c for c in (columns or names) if c in names and c not in (gcol, bcol)]
    tbl = dset.to_table(columns=keep + [gcol], filter=flt, batch_size=1 << 16)
    area = _box(*bbox) if bbox is not None else None
    feats = []
    props = {c: tbl.column(c).to_pylist() for c in keep}
    for i, g in enumerate(tbl.column(gcol).to_pylist()):
        if g is None:
            continue
        geom = wkb.loads(g)
        if area is not None and not geom.intersects(area):
            continue
        feats.append({"type": "Feature", "properties": {c: props[c][i] for c in keep}, "geometry": mapping(geom)})
    return {"type": "FeatureCollection", "features": json.loads(json.dumps(feats, default=str))}


def fetch_features(source: str, table: str, bbox=None, where: str | None = None, columns=None, force: bool = False,
                   suffix: str = "") -> dict:
    """A FeatureCollection (EPSG:25832) of the features in `bbox` (minE, minN, maxE, maxN) and/or matching the OGR SQL `where`,
    cached under data/raw/city/. `columns` limits the attributes kept."""
    p = cache_path(source, table, suffix)
    if p.exists() and not force:
        return json.loads(p.read_text(encoding="utf-8"))
    try:
        url, date = asset_url(source, table, "flatgeobuf")
    except KeyError:  # datagrundlag.dk dropped the FlatGeobuf assets (Nov 2026): read the GeoParquet by HTTP range
        url, date = asset_url(source, table, "data")
        fc = _read_geoparquet(url, bbox, where, columns)
    else:
        import pyogrio
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


_HTTPFS: set[int] = set()  # ids of duck_connect() connections with httpfs loaded


def duck_connect():
    """A DuckDB connection that reads remote GeoParquet: with the httpfs extension when it can be installed, else (`has_httpfs`
    False) through pyarrow datasets registered as views (parquet_src), which DuckDB scans with filter pushdown over HTTP ranges."""
    import duckdb

    con = duckdb.connect()
    try:
        con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='eu-west-1';")
        _HTTPFS.add(id(con))
    except Exception:  # noqa: BLE001  (extension download blocked, e.g. behind a proxy)
        pass
    return con


def parquet_src(con, url: str) -> str:
    """The FROM expression for a remote parquet file on a duck_connect() connection."""
    if id(con) in _HTTPFS:
        return f"read_parquet('{url}')"
    import fsspec
    import pyarrow.dataset as ds

    name = "pq_" + str(abs(hash(url)))
    con.register(name, ds.dataset(url, filesystem=fsspec.filesystem("https", client_kwargs={"trust_env": True}), format="parquet"))
    return name


def fetch_bbr_bygning(kommunekode: str, force: bool = False) -> dict:
    """BBR bygning of one kommune, {id_lokalid: {use, year, wall, roof, storeys, status, wall_code, roof_code}}, from the
    GeoParquet with DuckDB. Column names are matched by their BBR field number (the mirror spells them with æ/ø/å)."""
    p = cache_path("bbr", "bygning", f"_{kommunekode}")
    if p.exists() and not force:
        return json.loads(p.read_text(encoding="utf-8"))
    url, date = asset_url("bbr", "bygning", "data")
    import fsspec
    import pyarrow.dataset as ds

    # pyarrow over HTTP range reads (DuckDB's httpfs extension cannot be installed behind every proxy)
    dset = ds.dataset(url, filesystem=fsspec.filesystem("https", client_kwargs={"trust_env": True}), format="parquet")
    cols = dset.schema.names

    def col(prefix: str) -> str:
        return next(c for c in cols if c.startswith(prefix))

    pick = {"use": col("byg021"), "year": col("byg026"), "wall_code": col("byg032"), "roof_code": col("byg033"),
            "storeys": col("byg054"), "status": "status"}
    tbl = dset.to_table(columns=["id_lokalid", *pick.values()], filter=ds.field("kommunekode") == kommunekode.zfill(4))
    data = [tbl.column(c).to_pylist() for c in ["id_lokalid", *pick.values()]]
    rows = list(zip(*data))

    def num(v):
        v = str(v if v is not None else "").strip()
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
