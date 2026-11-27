#!/usr/bin/env python3
"""Operaen on Dokøen (Henning Larsen Tegnestue, 2004; GeoDanmark gdk:1064732327 and the roof-overhang outlines around it): a detail
override built from the published drawings.

The opera is a stone-and-glass block under one huge flat roof that cantilevers out over the harbour plaza, with the curved glass foyer
facing Amalienborg and the fly tower rising through the roof. From the drawings (Henning Larsen Tegnestue A/S, published on ArchDaily:
level 0, longitudinal section A-A and west elevation, all 1:700):

- level 0: the foyer front (the curve's apex), the main stage and the back of the house, read as fractions of the building's length,
- section A-A and the west elevation: the fly tower is about as wide as it is long (~33 m), centred across the building, its top
  about 1.5 times the roof's height; the roof's knife edge,
- the heights themselves come from the twin's own height data (roof, tower top), so the model sits where the point cloud says.

Measurements only; nothing of the drawings themselves is in the model.

    uv run --no-project --with numpy,pillow python tools/overrides/operaen.py
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from override_model import Model, albedo, model_to_glb, periodic_noise, to_image  # noqa: E402
from overrides_lib import SOURCE_FORMAT, TwinFrame, srgb_to_linear, write_json  # noqa: E402

SET = 'operaen'
GDK_ID = 'gdk:1064732327'   # the house itself
COVERS = [GDK_ID, 'gdk:1064798125', 'gdk:1064733266', 'gdk:1064803639', 'gdk:1064783322']  # + the roof overhang outlines
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET

FOYER_DEPTH = 30.0             # m from the foyer curve's apex back to where the straight side walls start (level 0)
TOWER_U = (0.395, 0.593)       # the fly tower along the house, foyer apex (0) .. east facade (1) (level 0: the main stage)
TOWER_V = (0.315, 0.685)       # across the roof (west elevation: ~33 of ~90 m, centred)
ROOF_EDGE = 0.45               # m: the roof's knife edge
ROOF_SOFFIT_IN = 9.0           # m in from the edge where the soffit reaches its full depth
ROOF_DEPTH = 2.2               # m: the roof's depth over the house

STONE = (0.74, 0.70, 0.62)     # the pale Jura-like stone of the side walls
WINDOW = (0.10, 0.12, 0.14)
GLASS = (0.26, 0.33, 0.37)
STEEL = (0.30, 0.31, 0.32)
ROOF_TOP = (0.62, 0.63, 0.63)
SOFFIT = (0.86, 0.82, 0.72)    # the warm, lit underside
TOWER = (0.33, 0.35, 0.37)
MAPLE = (0.70, 0.42, 0.20)     # the auditorium's maple shell, seen through the foyer glass

ATTRIBUTION = {
    'operaen-drawings': {'text': 'Operaen: proportions read from the published level 0 plan, section A-A and west elevation '
                                 '(Henning Larsen Tegnestue A/S, via ArchDaily)', 'licence': 'measurements only',
                         'url': 'https://www.archdaily.com/915153/the-royal-danish-opera-henning-larsen'},
    'geodanmark': {'text': 'GeoDanmark Bygning (the footprints the model is placed on), Klimadatastyrelsen', 'licence': 'CC BY 4.0',
                   'url': 'https://dataforsyningen.dk'},
}


def rgb(c):
    return tuple(float(v) for v in srgb_to_linear(np.array(c))) + (1.0,)


def stone_texture(n=512):
    """3 x 3 m of large stone panels (1.5 x 0.75 m) with fine joints and a little tone variation."""
    rs = np.random.default_rng(2004)
    img = np.ones((n, n, 3)) * np.array(albedo(STONE))
    ph, pw = n // 4, n // 2
    for r in range(0, n, ph):
        for c in range(0, n, pw):
            img[r:r + ph, c:c + pw] *= 1 + rs.normal(0, 0.035)
        img[r, :] *= 0.72
    for c in range(0, n, pw):
        img[:, c] *= 0.72
    img *= (1 + 0.06 * periodic_noise(n, 1.8, 7, low=2))[..., None]
    return to_image(np.clip(img, 0, 1))


def min_rect(pts):
    """The minimum-area rectangle around the points -> (centre, U long unit axis, V, half length, half width)."""
    from math import atan2
    best = None
    for i in range(len(pts)):
        e = pts[(i + 1) % len(pts)] - pts[i]
        if np.linalg.norm(e) < 1e-6:
            continue
        a = atan2(e[1], e[0])
        U, V = np.array([np.cos(a), np.sin(a)]), np.array([-np.sin(a), np.cos(a)])
        pu, pv = pts @ U, pts @ V
        area = (pu.max() - pu.min()) * (pv.max() - pv.min())
        if best is None or area < best[0]:
            best = (area, U, V, pu.min(), pu.max(), pv.min(), pv.max())
    _, U, V, u0, u1, v0, v1 = best
    if u1 - u0 < v1 - v0:
        U, V, u0, u1, v0, v1 = V, -U, v0, v1, -u1, -u0
    if U[0] > 0:  # u runs from the harbour (west) inland (east): flip so the foyer is at u = u0... we want u to grow eastwards
        pass
    else:
        U, V, u0, u1, v0, v1 = -U, -V, -u1, -u0, -v1, -v0
    return U, V, u0, u1, v0, v1


def build(ring, U, V, box, ground, low, roof_top, tower_top):
    m = Model()
    u0, u1, v0, v1 = box
    P = lambda u, v, y: (u * U[0] + v * V[0], y, u * U[1] + v * V[1])
    under = roof_top - ROOF_DEPTH
    edge_lo = roof_top - ROOF_EDGE

    # ---- the roof: flat top, knife edge, soffit sloping down to its full depth
    m.poly('roof', [P(u0, v0, roof_top), P(u1, v0, roof_top), P(u1, v1, roof_top), P(u0, v1, roof_top)], (0, 1, 0), color=rgb(ROOF_TOP))
    outer = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    k = ROOF_SOFFIT_IN
    inner = [(u0 + k, v0 + k), (u1 - k, v0 + k), (u1 - k, v1 - k), (u0 + k, v1 - k)]
    c = ((u0 + u1) / 2, (v0 + v1) / 2)
    for i in range(4):
        a, b = outer[i], outer[(i + 1) % 4]
        ia, ib = inner[i], inner[(i + 1) % 4]
        mid = ((a[0] + b[0]) / 2 - c[0], (a[1] + b[1]) / 2 - c[1])
        out = (mid[0] * U[0] + mid[1] * V[0], 0, mid[0] * U[1] + mid[1] * V[1])
        m.poly('roof', [P(*a, edge_lo), P(*b, edge_lo), P(*b, roof_top), P(*a, roof_top)], out, color=rgb(ROOF_TOP))
        m.poly('soffit', [P(*a, edge_lo), P(*b, edge_lo), P(*ib, under), P(*ia, under)], (out[0] * 0.2, -1, out[2] * 0.2), color=rgb(SOFFIT))
    m.poly('soffit', [P(*p, under) for p in inner], (0, -1, 0), color=rgb(SOFFIT))

    # ---- the house: the GeoDanmark outline, walls up under the soffit; the foyer curve is glass
    pu, pv = ring @ U, ring @ V
    apex, east = pu.min(), pu.max()
    rs = np.random.default_rng(553)
    n = len(ring)
    cen = np.array([np.mean(pu), np.mean(pv)])
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        L = np.linalg.norm(b - a)
        if L < 0.05:
            continue
        ua, va, ub, vb = a @ U, a @ V, b @ U, b @ V
        t = (b - a) / L
        nrm = np.array([t[1], -t[0]])
        mid = (a + b) / 2
        if (mid - (cen[0] * U + cen[1] * V)) @ nrm < 0:
            nrm = -nrm
        hint = (nrm[0], 0, nrm[1])
        foyer = max(ua, ub) < apex + FOYER_DEPTH
        if foyer:
            m.poly('glass', [(a[0], low, a[1]), (b[0], low, b[1]), (b[0], under, b[1]), (a[0], under, a[1])], hint, color=rgb(GLASS))
            # the steel grid: a mullion at every vertex of the curve, transoms every 3.2 m
            p = a + nrm * 0.06
            w = t * 0.07
            m.poly('steel', [(p[0] - w[0], low, p[1] - w[1]), (p[0] + w[0], low, p[1] + w[1]), (p[0] + w[0], under, p[1] + w[1]),
                             (p[0] - w[0], under, p[1] - w[1])], hint, color=rgb(STEEL))
            for y in np.arange(ground + 3.2, under - 0.5, 3.2):
                q0, q1 = a + nrm * 0.06, b + nrm * 0.06
                m.poly('steel', [(q0[0], y, q0[1]), (q1[0], y, q1[1]), (q1[0], y + 0.12, q1[1]), (q0[0], y + 0.12, q0[1])], hint, color=rgb(STEEL))
            continue
        m.poly('stone', [(a[0], low, a[1]), (b[0], low, b[1]), (b[0], under, b[1]), (a[0], under, a[1])], hint, color=rgb((1, 1, 1)))
        # ribbon glazing: one continuous band per 4.5 m storey, stopped 0.8 m short of the corners; not on the short jogs
        if L < 6:
            continue
        p0, p1 = a + t * 0.8 + nrm * 0.03, b - t * 0.8 + nrm * 0.03
        for y in np.arange(ground + 1.0, under - 2.5, 4.5):
            m.poly('painted', [(p0[0], y, p0[1]), (p1[0], y, p1[1]), (p1[0], y + 2.2, p1[1]), (p0[0], y + 2.2, p0[1])], hint, color=rgb(WINDOW))
            for s_ in np.arange(1.8, L - 1.6, 1.8):  # mullions
                q = a + t * s_ + nrm * 0.05
                w = t * 0.05
                m.poly('steel', [(q[0] - w[0], y, q[1] - w[1]), (q[0] + w[0], y, q[1] + w[1]), (q[0] + w[0], y + 2.2, q[1] + w[1]),
                                 (q[0] - w[0], y + 2.2, q[1] - w[1])], hint, color=rgb(STEEL))
    # the maple shell behind the foyer glass: a rounded drum, set back from the apex
    sc = (apex + 22.0, (pv.min() + pv.max()) / 2)
    ru, rv = 13.0, 18.0
    seg = 28
    prev = None
    for j in range(seg + 1):
        a_ = np.pi / 2 + np.pi * j / seg            # the western half only (the rest is inside the house)
        u, v = sc[0] + ru * np.cos(a_), sc[1] + rv * np.sin(a_)
        if prev is not None:
            pu_, pv_ = prev
            out = (np.cos(a_) * U[0] + np.sin(a_) * V[0], 0, np.cos(a_) * U[1] + np.sin(a_) * V[1])
            m.poly('maple', [P(pu_, pv_, ground + 4.0), P(u, v, ground + 4.0), P(u, v, under - 1.5), P(pu_, pv_, under - 1.5)], out, color=rgb(MAPLE))
        prev = (u, v)

    # ---- the fly tower, through the roof
    tu0, tu1 = apex + (east - apex) * TOWER_U[0], apex + (east - apex) * TOWER_U[1]
    tv0, tv1 = v0 + (v1 - v0) * TOWER_V[0], v0 + (v1 - v0) * TOWER_V[1]
    corners = [(tu0, tv0), (tu1, tv0), (tu1, tv1), (tu0, tv1)]
    tc = ((tu0 + tu1) / 2, (tv0 + tv1) / 2)
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        mid = ((a[0] + b[0]) / 2 - tc[0], (a[1] + b[1]) / 2 - tc[1])
        out = (mid[0] * U[0] + mid[1] * V[0], 0, mid[0] * U[1] + mid[1] * V[1])
        m.poly('tower', [P(*a, under), P(*b, under), P(*b, tower_top), P(*a, tower_top)], out, color=rgb(TOWER))
        # horizontal glazing bands and a thin cornice
        for y in np.arange(roof_top + 1.0, tower_top - 1.0, 2.4):
            e = 0.04
            da = (np.array(a) - tc) / np.linalg.norm(np.array(a) - tc) * e
            db = (np.array(b) - tc) / np.linalg.norm(np.array(b) - tc) * e
            m.poly('steel', [P(a[0] + da[0], a[1] + da[1], y), P(b[0] + db[0], b[1] + db[1], y), P(b[0] + db[0], b[1] + db[1], y + 0.18),
                             P(a[0] + da[0], a[1] + da[1], y + 0.18)], out, color=rgb(STEEL))
    m.poly('roof', [P(*p, tower_top) for p in corners], (0, 1, 0), color=rgb(ROOF_TOP))
    return m


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', default=str(ROOT / 'data'))
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    a = ap.parse_args()
    data, out = Path(a.data), Path(a.out)
    frame = TwinFrame(data)
    recs, tile = {}, None
    for tid in frame.index['tiles']:
        for gid in COVERS:
            if gid in frame.buildings(tid):
                recs[gid] = frame.buildings(tid)[gid]
                if gid == GDK_ID:
                    tile = tid
    missing = set(COVERS) - set(recs)
    if missing or tile is None:
        raise SystemExit(f'not found: {sorted(missing)}')
    house = recs[GDK_ID]
    ring = np.array(house['ring'], float).reshape(-1, 2)
    if np.allclose(ring[0], ring[-1]):
        ring = ring[:-1]
    allpts = np.vstack([np.array(r['ring'], float).reshape(-1, 2) for r in recs.values()])
    from scipy.spatial import ConvexHull  # noqa: PLC0415
    hull = allpts[ConvexHull(allpts).vertices]
    U, V, u0, u1, v0, v1 = min_rect(hull)
    ground = house['ground']
    low = min(frame.ground_low(r) for r in recs.values()) - 0.25
    roof_top = float(np.median([recs[g]['eave'] for g in COVERS]))
    roof_top = max(roof_top, house['eave'])
    tower_top = house['ridge']
    print(f'tile {tile}; roof {u1 - u0:.1f} x {v1 - v0:.1f} m, axis {np.degrees(np.arctan2(U[1], U[0])):.1f} deg; ground {ground:.2f}, '
          f'roof {roof_top:.2f}, tower {tower_top:.2f}')
    model = build(ring, U, V, (u0, u1, v0, v1), ground, low, roof_top, tower_top)
    materials = {'stone': dict(tile=(3.0, 3.0), roughness=0.85), 'roof': dict(roughness=0.5, metallic=0.3), 'soffit': dict(roughness=0.7),
                 'painted': dict(roughness=0.4), 'glass': dict(roughness=0.08, metallic=0.7), 'steel': dict(roughness=0.4, metallic=0.6),
                 'tower': dict(roughness=0.25, metallic=0.5), 'maple': dict(roughness=0.5)}
    textures = {'stone': stone_texture}
    body, mesh, lo, hi = model_to_glb(model, 0.0, (0.0, 0.0, 0.0), materials, textures, SET,
                                      root_extras={'building_id': GDK_ID, 'source_ids': ['operaen-drawings'], 'attribution': list(ATTRIBUTION),
                                                   'confidence': 'inferred'},
                                      asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                                      attribution=list(ATTRIBUTION), generator='tools/overrides/operaen.py')
    rel = f'meshes/{GDK_ID.replace(":", "_")}.glb'
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    (out / rel).write_bytes(body)
    entry = {
        'tile': tile, 'mode': 'replace', 'covers': COVERS, 'footprint': {'use': 'gdk'},
        'match': {'kind': 'split', 'iou': None, 'hausdorff': None},
        'source': {'ids': ['operaen-drawings'], 'kind': 'architect-drawing', 'reconstruction': 'tools/overrides/operaen.py'},
        'confidence': 'inferred', 'attribution': list(ATTRIBUTION),
        'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': ground, 'low': round(low, 2), 'sunk': 0.25,
        'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
    }
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': {GDK_ID: entry}})
    print(f'{out}: {mesh["triangles"]} triangles, {len(body) / 1e6:.2f} MB GLB, {mesh["textureBytes"] / 1e6:.1f} MB textures, top {hi[1]:.2f}')


if __name__ == '__main__':
    main()
