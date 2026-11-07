"""Street addresses of the twin's buildings -> data/city/addresses.json (aalborg-addresses/1), for the building info panel.

Keyed by the building's BBR bygning id (`bbr_id` in data/tiles/<id>/buildings.json). A building's house numbers (DAR husnummer)
come from three links, all read from datagrundlag.dk (MapCentia's open mirror; GeoParquet + DuckDB, cached under data/raw/city/):
  1. BBR enhed (every flat, shop or office unit) -> its DAR adresse (`adresseidentificerer`) -> the adresse's husnummer
  2. BBR opgang (stairwell) -> `adgangFraHusnummer`
  3. DAR husnummer whose `adgangTilBygning` is the building
The husnummer's `adgangsadressebetegnelse` ("Nytorv 1, 9000 Aalborg") gives street, number and post town. A building's label groups
its numbers by street, the street with the most units first, numbers in natural order, at most four per street:

    "Nytorv 1, 1A, 1D · Lille Kongensgade 4, 9000 Aalborg"

    uv run --no-project --with duckdb python -X utf8 tools/geodata/addresses.py [--kommune 0851] [--out data/city/addresses.json]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import datagrundlag as DG  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
TILES_DIR = ROOT / "data" / "tiles"
OUT = ROOT / "data" / "city" / "addresses.json"
VERSION = "aalborg-addresses/1"
MAX_NUMBERS = 4
# BBR life-cycle codes of units that no longer exist (afsluttet, historisk, fejlregistreret, henlagt)
GONE = {"9", "10", "11", "14"}


def current(col: str) -> str:
    return f"(\"{col}\" IS NULL OR \"{col}\" = '')"


class Mirror:
    def __init__(self):
        self._con = None

    def con(self):
        if self._con is None:
            import duckdb

            self._con = duckdb.connect()
            self._con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='eu-west-1';")
        return self._con

    def rows(self, source: str, table: str, suffix: str, sql: str, params: list, cols: list[str]) -> list[dict]:
        """Rows of `sql` over the dataset's GeoParquet ({src}), cached as data/raw/city/dg_<source>_<table><suffix>.json."""
        p = DG.cache_path(source, table, suffix)
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
        url, date = DG.asset_url(source, table, "data")
        t0 = time.time()
        out = [dict(zip(cols, r)) for r in self.con().execute(sql.format(src=f"read_parquet('{url}')"), params).fetchall()]
        DG._write(p, json.dumps(out, ensure_ascii=False, separators=(",", ":")))
        DG.record_snapshot(source, table, date, records=len(out))
        DG.log(f"[addresses] {source}.{table} ({date}): {len(out)} records ({time.time() - t0:.0f}s)")
        return out


def twin_buildings() -> set[str]:
    """BBR ids of every building in the compiled tiles."""
    ids = set()
    for p in sorted(TILES_DIR.glob("*/buildings.json")):
        for b in json.loads(p.read_text(encoding="utf-8"))["buildings"]:
            if b.get("bbr_id"):
                ids.add(b["bbr_id"].lower())
    return ids


def natural(text: str):
    """'2' < '10' < '10A': the number, then the letter."""
    m = re.match(r"(\d+)(.*)", text or "")
    return (int(m.group(1)), m.group(2)) if m else (10**9, text or "")


def split_address(betegnelse: str, number: str):
    """("Nytorv 1, 9000 Aalborg", "1") -> ("Nytorv", "9000 Aalborg"); None when the text does not have that shape."""
    if not betegnelse or not number:
        return None
    head, _, rest = betegnelse.partition(",")
    suffix = f" {number}"
    if not head.endswith(suffix):
        return None
    town = rest.rsplit(",", 1)[-1].strip()
    return head[: -len(suffix)].strip(), town or None


def label(numbers: dict[str, dict]) -> str | None:
    """Building label from {husnummer id: {street, number, town, units}}."""
    streets: dict[str, dict] = {}
    towns = Counter()
    for h in numbers.values():
        s = streets.setdefault(h["street"], {"units": 0, "numbers": set()})
        s["units"] += h["units"]
        s["numbers"].add(h["number"])
        if h["town"]:
            towns[h["town"]] += h["units"] or 1
    if not streets:
        return None
    parts = []
    for street, s in sorted(streets.items(), key=lambda kv: (-kv[1]["units"], -len(kv[1]["numbers"]), kv[0])):
        nums = sorted(s["numbers"], key=natural)
        more = f" +{len(nums) - MAX_NUMBERS}" if len(nums) > MAX_NUMBERS else ""
        parts.append(f"{street} {', '.join(nums[:MAX_NUMBERS])}{more}")
    town = towns.most_common(1)[0][0] if towns else None
    return " · ".join(parts) + (f", {town}" if town else "")


def build(kommune: str) -> dict:
    wanted = twin_buildings()
    DG.log(f"[addresses] {len(wanted)} buildings with a BBR id in {TILES_DIR}")
    M = Mirror()
    k = kommune.zfill(4)

    enheder = M.rows("bbr", "enhed", f"_{k}",
                     f"SELECT bygning, adresseidentificerer, status FROM {{src}} WHERE kommunekode = ? AND {current('registreringtil')} "
                     f"AND {current('virkningtil')}", [k], ["bygning", "adresse", "status"])
    unit_addr = defaultdict(Counter)  # bygning -> adresse id -> units
    for e in enheder:
        b = (e["bygning"] or "").lower()
        if b in wanted and e["adresse"] and str(e["status"] or "") not in GONE:
            unit_addr[b][e["adresse"]] += 1
    adresse_ids = sorted({a for c in unit_addr.values() for a in c})
    adresser = M.rows("dar", "adresse", f"_bbr_{k}",
                      f"SELECT id_lokalid, husnummer FROM {{src}} WHERE status IN ('2', '3') AND {current('registreringtil')} "
                      f"AND {current('virkningtil')} AND list_contains(?, id_lokalid)", [adresse_ids], ["id", "husnummer"])
    adresse_hn = {a["id"]: a["husnummer"] for a in adresser if a["husnummer"]}

    opgange = json.loads(DG.cache_path("bbr", "opgang", f"_{k}").read_text(encoding="utf-8")) \
        if DG.cache_path("bbr", "opgang", f"_{k}").exists() else []

    links = defaultdict(Counter)  # bygning -> husnummer id -> units (0 for a stairwell or a direct link)
    for b, c in unit_addr.items():
        for a, n in c.items():
            if a in adresse_hn:
                links[b][adresse_hn[a]] += n
    for o in opgange:
        b = (o.get("bygning") or "").lower()
        if b in wanted and o.get("adgangfrahusnummer"):
            links[b][o["adgangfrahusnummer"]] += 0
    hn_ids = sorted({h for c in links.values() for h in c})
    cols = ["id", "tekst", "betegnelse", "bygning", "registreringfra"]
    husnumre = M.rows("dar", "husnummer", f"_bbr_{k}",
                      f"SELECT id_lokalid, husnummertekst, adgangsadressebetegnelse, adgangtilbygning, registreringfra FROM {{src}} "
                      f"WHERE status IN ('2', '3') AND {current('registreringtil')} AND {current('virkningtil')} "
                      f"AND (list_contains(?, id_lokalid) OR list_contains(?, lower(adgangtilbygning)))", [hn_ids, sorted(wanted)], cols)
    hn = {}
    for r in husnumre:  # one per id: a re-registration in the same snapshot keeps the newest
        if r["id"] not in hn or (r["registreringfra"] or "") > (hn[r["id"]]["registreringfra"] or ""):
            hn[r["id"]] = r
    for r in hn.values():
        b = (r["bygning"] or "").lower()
        if b in wanted:
            links[b][r["id"]] += 0

    out, sources = {}, Counter()
    for b in sorted(links):
        numbers = {}
        for h, units in links[b].items():
            r = hn.get(h)
            parts = split_address(r["betegnelse"], r["tekst"]) if r else None
            if parts:
                numbers[h] = {"street": parts[0], "number": r["tekst"], "town": parts[1], "units": units}
        text = label(numbers)
        if text:
            out[b] = text
            sources["units" if any(n["units"] for n in numbers.values()) else "stairwell/direct"] += 1
    DG.log(f"[addresses] {len(out)} of {len(wanted)} buildings addressed ({dict(sources)})")
    return {"version": VERSION, "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": "BBR enhed -> DAR adresse -> husnummer, BBR opgang, DAR husnummer.adgangTilBygning (datagrundlag.dk)",
            "count": len(out), "addresses": out}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kommune", default="0851")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args()
    doc = build(a.kommune)
    DG._write(Path(a.out), json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    DG.log(f"[addresses] -> {a.out} ({Path(a.out).stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()
