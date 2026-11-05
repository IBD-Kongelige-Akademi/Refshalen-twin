# LoD2 roofs (M4): `data/lod2/`

Pitched roofs for the Copenhagen buildings, reconstructed by [roofer](https://github.com/3DBAG/roofer) 1.1.0-beta.1 from the DHM Punktsky point cloud. Kept apart from `data/cph-geodata.json` on purpose: the engine joins the two by building id, so the geodata compiler never has to know about LoD2. Design and numbers: `docs/research/roofer-citywide.md`; per-run QA: `data/lod2/report.md`.

## Pipeline (`tools/lod2/`, `uv run --project tools/lod2 python tools/lod2/<step>.py`)

| step | does |
|---|---|
| `fetch.py [--bbox minE minN maxE maxN]` | 1 km Punktsky LAZ tiles covering the bbox (default: the district) into `data/raw/lod2/` (gitignored, resume-safe, API key from Secret Manager via ADC). Pass the municipality bbox for the whole commune. |
| `prep.py` | per tile: footprints (own tile plus a 25 m margin of neighbours, which are only LoD1.1 context), PDAL crop of classes 2+6 with the neighbours' points, `roofer.toml` with the scan year. BBR `year` after the scan year marks the roof `inferred`. |
| `run.py` | roofer in Docker, tiles in parallel. |
| `convert.py` | CityJSONSeq LoD2.2 -> `data/lod2/<tile>.bin` + `index.json` (local frame, cm, int16/uint16). Layout in the module docstring. |
| `qa.py` | `data/lod2/report.md`. |

## Contract

`index.json`: `{version: "lod2/1", frame, src, tiles: {tile: {file, bytes, scan_date}}, buildings: {"gdk:<id>": entry}}`. A measured entry has `tile, offset, length, conf: "measured", roof_type, planes, rmse, density, nodata, scan_date, closed`; an entry without `offset` has `conf: "inferred"` and a `reason` (built after the scan, too little coverage, roofer failure ...) and the engine keeps the flat extrusion.

Engine (`js/lod2-geometry.js`, `js/building-geometry.js addBuilding`): the roofer roof replaces the flat deck; the footprint-extruded facade walls (facade shader attributes) stay but end at the roofer eave of each footprint edge (`top`); roofer wall triangles survive only above that eave (gables) or as inner step walls, drawn as plain masonry. `?debug=nolod2` disables it for before/after comparisons.

## Closing the shell (Aalborg)

The walls are extruded from the footprint and the roof comes from the LoD2 record, so nothing guarantees they meet. Materials are front-side
only: where the shell stands open you see the inside of the far walls culled away, and the building looks transparent. An audit of all
3,336 buildings (rays at every facade and down on every roof) found 872 with a ray seeing through. `js/lod2-geometry.js`,
`js/building-geometry.js addBuilding`:

- **Refused records.** A record whose roof covers under 60 % of the footprint is not used (33 of 3,040; many fit 4 to 16 m off). The building is
  drawn as an extrusion with a whole roof.
- **Below ground.** A refused record on a footprint over 100 m² and under 2.5 m high means nothing stands there:
  `tools/geodata/below_ground.py` (in the `canopies` stage) marks it `below_ground`. 3 buildings; the 2,716 m² under Budolfi Plads, 4 % roofed,
  is most likely the underground car park. A marked building is dropped altogether (`dropBuilding` in `js/world.js`): not drawn, no collider,
  no block to walkers, not in the far ring or the overview map, and trees and lamps may stand there. Sheds with a bad record are under 40 m²
  and stay. Rerun the furniture stage after marking.
- **Unmatched edges.** 1,161 buildings have edges the record has no eave for. Those walls used a generic eave, ending short of the roof or
  standing above it. They now end at the lowest roof over them.
- **Closing walls.** Above each wall, up to the roof read over it, a wall piece closes any gap the record's own walls leave.
- **Closing deck.** A roof that covers under 97 % of the footprint, or misses a point of a grid over it, gets a flat deck 0.3 m under its
  lowest point, so a gap at an eave shows a surface, not the hollow.

Together these add 5 % triangles. The deck is only drawn where needed because more than that ran the GPU out of memory (`E_OUTOFMEMORY`) on a
7.7 GB machine. After them, 119 of the 3,336 buildings still have a ray seeing through, nearly all one to three narrow gaps at an eave: 115 of
66,597 roof rays and 20 of 59,287 facade rays.
