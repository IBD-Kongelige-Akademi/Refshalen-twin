#!/usr/bin/env python3
"""Papirøen / Christiansholm housing (COBE for AKB and others, 2023-): the steep "Christiansholm roofs" of building fields B1 and B2, a
detail override built from lokalplan 548 Christiansholm and the AKB letting brochure.

The buildings are scanned after the 2019 point cloud, so the twin only knows their footprints and the measured eave/ridge heights. The
characteristic form comes from the lokalplan (tegning nr. 4, 4A, 4B):

- a plinth over the whole field (the halls / 1st floor, 6.5-10 m),
- above it wings ("længehuse", 13-15 m deep) and point houses ("punkthuse", 22-25 m deep) whose long walls rise a little and then
  lean in at 16-22 degrees from the vertical to a narrow flat top (4-8 m), with steep, pointed gables at the ends,
- heights 24-30 m for the wings and 38-41 m for the point houses (the twin's measured ridges are used).

Which part of each footprint is a wing and which a point house is read from tegning nr. 4 (bebyggelsesplan); measurements only.

    uv run --no-project --with numpy,pillow python tools/overrides/papiroen.py
"""
from __future__ import annotations

import argparse
import hashlib
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from override_model import Model, albedo, model_to_glb, periodic_noise, to_image  # noqa: E402
from overrides_lib import SOURCE_FORMAT, TwinFrame, srgb_to_linear, write_json  # noqa: E402

SET = 'papiroen'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET

# the island's grid: u along KAI's long edge (towards Trangraven), v across it; origin at KAI's north corner (twin local x, z)
GRID_ORIGIN = (-805.3, 1174.7)
GRID_DEG = 114.4224
LEAN = math.radians(19.0)      # the roof faces' lean from the vertical (lokalplan: 16-22 degrees)
PLINTH = 8.0                   # m above ground: the halls / 1st floor
MIN_WALL = 11.0                # m above ground: the straight walls always reach at least this before the lean

# per building: the GeoDanmark id and its parts (u0, u1, v0, v1, ridge axis 'u'|'v', top: 'wing'|'point', flat top width m)
BUILDINGS = {
    'gdk:1220273543': [          # B1: point house at the north corner, wings along Inderhavnen and Trangraven
        (57.8, 80.5, -4.2, -27.5, 'u', 'point', 7.0),
        (87.7, 123.3, -4.2, -19.6, 'u', 'wing', 5.0),
        (108.0, 123.3, -19.6, -75.8, 'v', 'wing', 5.0),
    ],
    'gdk:1223612478': [          # B2 north: point house, short wing
        (6.0, 30.0, -49.5, -74.5, 'v', 'point', 7.0),
        (20.4, 36.6, -74.5, -89.7, 'u', 'wing', 5.0),
    ],
    'gdk:1223612479': [          # B2 middle: wings to Proviantmagasingraven and Arsenalgraven
        (6.0, 20.3, -81.7, -116.0, 'v', 'wing', 4.5),
        (6.0, 40.4, -116.0, -131.6, 'u', 'wing', 5.0),
    ],
    'gdk:1220273564': [          # B2: the point house in the middle
        (46.4, 70.6, -88.0, -127.2, 'v', 'point', 7.0),
    ],
    'gdk:1220273578': [          # B2 south: wings to Trangraven and Arsenalgraven
        (118.4, 133.8, -85.2, -129.7, 'v', 'wing', 5.0),
        (80.3, 118.4, -114.0, -129.7, 'u', 'wing', 5.0),
    ],
}

WALL = (0.80, 0.78, 0.74)      # pale concrete / render
ROOFFACE = (0.70, 0.70, 0.69)  # the leaning faces (light metal)
WINDOW = (0.10, 0.12, 0.14)
GLASS = (0.22, 0.27, 0.30)
FRAME = (0.30, 0.30, 0.30)
TOP = (0.45, 0.46, 0.45)

ATTRIBUTION = {
    'christiansholm-lokalplan': {'text': 'Papirøen: building fields, heights and the Christiansholm roof read from lokalplan nr. 548 '
                                         'Christiansholm (Københavns Kommune, 2017) and the AKB Papirøen letting brochure (renderings COBE)',
                                 'licence': 'measurements only', 'url': 'https://www.kk.dk/lokalplaner'},
    'geodanmark': {'text': 'GeoDanmark Bygning (the footprints the model is placed on), Klimadatastyrelsen', 'licence': 'CC BY 4.0',
                   'url': 'https://dataforsyningen.dk'},
}


def rgb(c):
    return tuple(float(v) for v in srgb_to_linear(np.array(c))) + (1.0,)


def wall_texture(n=256):
    """2 x 2 m of large pale panels with fine joints."""
    img = np.ones((n, n, 3)) * np.array(albedo(WALL))
    img[:, :2] *= 0.82
    img[:2, :] *= 0.82
    img *= (1 + 0.05 * periodic_noise(n, 1.8, 11, low=2))[..., None]
    return to_image(np.clip(img, 0, 1))


class Grid:
    def __init__(self):
        a = math.radians(GRID_DEG)
        self.U = np.array([math.cos(a), math.sin(a)])
        self.V = np.array([-math.sin(a), math.cos(a)])
        self.O = np.array(GRID_ORIGIN)

    def xz(self, u, v):
        return self.O + u * self.U + v * self.V

    def p(self, u, v, y):
        q = self.xz(u, v)
        return np.array([q[0], y, q[1]])

    def dir3(self, du, dv):
        q = du * self.U + dv * self.V
        return np.array([q[0], 0.0, q[1]])


def windows_on(m, a, b, c, d, nrm, rows, bay, win_w, win_h, color, start=0.5):
    """Windows on the planar quad a-b (bottom) c-d (top, over b and a): `rows` rows, one per bay along the bottom edge."""
    L = np.linalg.norm(b - a)
    n = max(int((L - 1.0) // bay), 0)
    if n == 0 or rows == 0:
        return
    off = (L - n * bay) / 2
    for r in range(rows):
        f0 = (r + start - 0.5 * win_h) / rows
        f1 = (r + start + 0.5 * win_h) / rows
        for k in range(n):
            s = (off + (k + 0.5) * bay) / L
            w = win_w / L / 2
            pts = []
            for (ss, ff) in ((s - w, f0), (s + w, f0), (s + w, f1), (s - w, f1)):
                lo = a + (b - a) * ss
                hi = d + (c - d) * ss
                pts.append(lo + (hi - lo) * ff + nrm * 0.04)
            m.poly('painted', pts, nrm, color=rgb(color))


def prism(m, g, part, ground, top_y, low):
    """One wing or point house: straight walls, then faces leaning in at LEAN to a flat top `tw` wide, pointed gables at both ends."""
    u0, u1, v0, v1, axis, kind, tw = part
    if axis == 'u':   # ridge along u: the long walls are at v0, v1
        along, across = (u0, u1), (v0, v1)
        P = lambda s, t, y: g.p(s, t, y)
        dA, dC = g.dir3(1, 0), g.dir3(0, 1)
    else:
        along, across = (v0, v1), (u0, u1)
        P = lambda s, t, y: g.p(t, s, y)
        dA, dC = g.dir3(0, 1), g.dir3(1, 0)
    a0, a1 = along
    c0, c1 = sorted(across)
    w = c1 - c0
    inset = max((w - tw) / 2, 0.5)
    he = max(top_y - inset / math.tan(LEAN), ground + MIN_WALL)
    inset = min(inset, (top_y - he) * math.tan(LEAN))
    t0, t1 = c0 + inset, c1 - inset
    mid_a = (a0 + a1) / 2
    mid_c = (c0 + c1) / 2
    # long sides: wall + leaning face, with windows
    for side, (c_wall, c_top) in ((-1, (c0, t0)), (1, (c1, t1))):
        out = (P(mid_a, c_wall, 0) - P(mid_a, mid_c, 0))
        out = out / np.linalg.norm(out)
        A, B = P(a0, c_wall, low), P(a1, c_wall, low)
        Ae, Be = P(a0, c_wall, he), P(a1, c_wall, he)
        m.poly('wall', [A, B, Be, Ae], out, color=rgb((1, 1, 1)))
        At, Bt = P(a0, c_top, top_y), P(a1, c_top, top_y)
        nface = out * math.cos(LEAN) + np.array([0, math.sin(LEAN), 0])
        m.poly('roofface', [Ae, Be, Bt, At], nface, color=rgb(ROOFFACE))
        # windows: storeys of 3.1 m on the wall above the plinth, then on the leaning face
        wall_rows = int((he - (ground + PLINTH)) // 3.1)
        if wall_rows > 0:
            Ap, Bp = P(a0, c_wall, ground + PLINTH), P(a1, c_wall, ground + PLINTH)
            windows_on(m, Ap, Bp, Bp + (Be - Bp) * (wall_rows * 3.1) / (he - ground - PLINTH),
                       Ap + (Ae - Ap) * (wall_rows * 3.1) / (he - ground - PLINTH), out, wall_rows, 3.4, 1.5, 0.6, WINDOW)
        face_rows = int((top_y - he) // 3.1)
        if face_rows > 0:
            windows_on(m, Ae, Be, Bt, At, nface, face_rows, 3.4, 1.4, 0.55, WINDOW)
    m.poly('top', [P(a0, t0, top_y), P(a1, t0, top_y), P(a1, t1, top_y), P(a0, t1, top_y)], (0, 1, 0), color=rgb(TOP))
    # the gables: a pointed pentagon-hexagon at each end, windows in storeys
    for a_, sgn in ((a0, -1), (a1, 1)):
        out = P(a_, mid_c, 0) - P(mid_a, mid_c, 0)
        out = out / np.linalg.norm(out)
        pts = [P(a_, c0, low), P(a_, c1, low), P(a_, c1, he), P(a_, t1, top_y), P(a_, t0, top_y), P(a_, c0, he)]
        m.poly('wall', pts, out, color=rgb((1, 1, 1)))
        y = ground + PLINTH + 0.9
        while y + 1.8 < top_y - 0.5:
            # the gable's width at this height
            frac = 0.0 if y < he else (y + 1.8 - he) / max(top_y - he, 1e-3)
            half = (w / 2) - inset * min(frac, 1.0) - 1.2
            nwin = int((2 * half) // 3.0)
            for k in range(nwin):
                cpos = mid_c - half + (k + 0.5) * (2 * half / nwin)
                q0 = P(a_, cpos - 0.7, y) + out * 0.04
                q1 = P(a_, cpos + 0.7, y) + out * 0.04
                m.poly('painted', [q0, q1, q1 + (0, 1.8, 0), q0 + (0, 1.8, 0)], out, color=rgb(WINDOW))
            y += 3.1


def plinth(m, ring, ground, low):
    """The plinth over the whole footprint: glazed ground floor, closed band above, flat roof (triangulated)."""
    n = len(ring)
    c = ring.mean(0)
    area2 = sum(ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1] for i in range(n))
    ccw = area2 > 0
    top = ground + PLINTH
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        L = np.linalg.norm(b - a)
        if L < 0.2:
            continue
        t = (b - a) / L
        nrm = np.array([t[1], -t[0]]) if ccw else np.array([-t[1], t[0]])
        hint = (nrm[0], 0, nrm[1])
        m.poly('glass', [(a[0], low, a[1]), (b[0], low, b[1]), (b[0], ground + 5.0, b[1]), (a[0], ground + 5.0, a[1])], hint, color=rgb(GLASS))
        m.poly('wall', [(a[0], ground + 5.0, a[1]), (b[0], ground + 5.0, b[1]), (b[0], top, b[1]), (a[0], top, a[1])], hint, color=rgb((1, 1, 1)))
        for s in np.arange(1.5, L - 0.5, 3.0):
            p = a + t * s + nrm * 0.05
            w = t * 0.08
            m.poly('painted', [(p[0] - w[0], low, p[1] - w[1]), (p[0] + w[0], low, p[1] + w[1]), (p[0] + w[0], ground + 5.0, p[1] + w[1]),
                               (p[0] - w[0], ground + 5.0, p[1] - w[1])], hint, color=rgb(FRAME))
    for tri in earclip(ring):
        m.poly('top', [(p[0], top, p[1]) for p in tri], (0, 1, 0), color=rgb(TOP))


def earclip(ring):
    """Triangles of a simple polygon (either winding) by ear clipping -> [(p, p, p)]."""
    n = len(ring)
    area2 = sum(ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1] for i in range(n))
    idx = list(range(n)) if area2 > 0 else list(range(n))[::-1]
    pts = ring
    out = []

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    guard = 0
    while len(idx) > 3 and guard < 100000:
        guard += 1
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            if cross(pts[i0], pts[i1], pts[i2]) <= 1e-9:
                continue
            tri = (pts[i0], pts[i1], pts[i2])
            if any(cross(tri[0], tri[1], pts[j]) > 0 and cross(tri[1], tri[2], pts[j]) > 0 and cross(tri[2], tri[0], pts[j]) > 0
                   for j in idx if j not in (i0, i1, i2)):
                continue
            out.append(tri)
            idx.pop(k)
            break
        else:
            break
    if len(idx) == 3:
        out.append(tuple(pts[i] for i in idx))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', default=str(ROOT / 'data'))
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    a = ap.parse_args()
    data, out = Path(a.data), Path(a.out)
    frame = TwinFrame(data)
    g = Grid()
    entries = {}
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    for gid, parts in BUILDINGS.items():
        tile = rec = None
        for tid in frame.index['tiles']:
            if gid in frame.buildings(tid):
                tile, rec = tid, frame.buildings(tid)[gid]
                break
        if rec is None:
            raise SystemExit(f'{gid} is in no tile')
        ring = np.array(rec['ring'], float).reshape(-1, 2)
        if np.allclose(ring[0], ring[-1]):
            ring = ring[:-1]
        ground = rec['ground']
        low = frame.ground_low(rec) - 0.25
        ridge = rec['ridge']
        m = Model()
        plinth(m, ring, ground, low)
        for part in parts:
            top = ridge if part[5] == 'point' else min(ridge, ground + 30.0)
            prism(m, g, part, ground, top, low)
        materials = {'wall': dict(tile=(2.0, 2.0), roughness=0.85), 'roofface': dict(roughness=0.55, metallic=0.25), 'painted': dict(roughness=0.4),
                     'glass': dict(roughness=0.1, metallic=0.6), 'top': dict(roughness=0.8)}
        body, mesh, lo, hi = model_to_glb(m, 0.0, (0.0, 0.0, 0.0), materials, {'wall': wall_texture}, f'{SET}-{gid}',
                                          root_extras={'building_id': gid, 'source_ids': ['christiansholm-lokalplan'], 'attribution': list(ATTRIBUTION),
                                                       'confidence': 'inferred'},
                                          asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                                          attribution=list(ATTRIBUTION), generator='tools/overrides/papiroen.py')
        rel = f'meshes/{gid.replace(":", "_")}.glb'
        (out / rel).write_bytes(body)
        entries[gid] = {
            'tile': tile, 'mode': 'replace', 'covers': [gid], 'footprint': {'use': 'gdk'},
            'match': {'kind': '1:1', 'iou': None, 'hausdorff': None},
            'source': {'ids': ['christiansholm-lokalplan'], 'kind': 'planning-document', 'reconstruction': 'tools/overrides/papiroen.py'},
            'confidence': 'inferred', 'attribution': list(ATTRIBUTION),
            'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': ground, 'low': round(low, 2), 'sunk': 0.25,
            'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
        }
        print(f'{gid}: {mesh["triangles"]} triangles, top {hi[1]:.2f} (ridge {ridge:.2f})')
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': entries})


if __name__ == '__main__':
    main()
