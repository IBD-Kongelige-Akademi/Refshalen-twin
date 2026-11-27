#!/usr/bin/env python3
"""KAI, Vandkulturhuset on Papirøen (Kengo Kuma & Associates with Cornelius Vöge and Søren Jensen; executing architect Vilhelm
Lauritzen Arkitekter; GeoDanmark gdk:1219264487): a detail override built from the published drawings.

Five (six with the narrow F) brick "stubs", truncated pyramids clad in long dark-grey brick with scattered deep-set windows, float on a
glazed ground floor carried by raking V columns. From the drawings (vandkulturhusetpapiroen.dk, image archive "plan drawings" and
sections; vilhelmlauritzen.com):

- the structural roof diagram (grid A-G x 1-6): which stub stands where, its base rectangle (the stubs meet at the base) and its top
  rectangle (the flat roof); read in fractions of the building's outline,
- sections: tops at kote +31.63 (A, the culture tower), +25.63 (C), +22.63 (B), +21.63 (E), +19.13 (D); the brick starts at kote
  +7.08 (ESM) over the glass ground floor (EST +2.63),
- plan L1: the north arrow (the plan's left side is the north-north-east end), which fixes the diagram on the GeoDanmark footprint.

Measurements only; nothing of the drawings themselves is in the model. Kote (DVR90) -> local y = kote - origin height.

    uv run --no-project --with numpy,pillow python tools/overrides/kai.py
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

SET = 'kai'
GDK_ID = 'gdk:1219264487'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET

# the roof diagram in its own pixels: outline (x0, y0, x1, y1); per stub the base and the top rectangle and the top kote
OUTLINE = (35, 45, 362, 302)
STUBS = {
    'A': ((35, 175, 218, 302), (72, 202, 158, 270), 31.63),
    'B': ((35, 45, 133, 175), (62, 68, 108, 112), 22.63),
    'C': ((133, 45, 218, 115), (158, 52, 200, 98), 25.63),
    'D': ((258, 45, 362, 135), (280, 58, 335, 100), 19.13),
    'E': ((258, 135, 362, 302), (285, 168, 336, 264), 21.63),
    'F': ((218, 115, 258, 302), (230, 140, 246, 280), 14.13),   # the narrow stub over the valley pool (no kote on the drawings: inferred)
    'CD': ((218, 45, 258, 115), (226, 55, 250, 105), 17.13),  # the link between C and D (inferred)
}
BRICK_KOTE = 7.08      # ESM: where the brick starts
ROOF_DARK = (0.30, 0.29, 0.28)
GLASS = (0.30, 0.38, 0.42)
FRAME = (0.20, 0.21, 0.22)
COLUMN = (0.80, 0.80, 0.78)
BRICK = (0.43, 0.40, 0.37)       # the dark grey-brown of the photographs
WINDOW = (0.07, 0.08, 0.09)

ATTRIBUTION = {
    'kai-drawings': {'text': 'KAI / Vandkulturhuset Papirøen: dimensions read from the published plans and sections (Kengo Kuma & Associates, '
                             'Cornelius Vöge, Søren Jensen; Vilhelm Lauritzen Arkitekter)', 'licence': 'measurements only',
                     'url': 'https://xn--vandkulturhusetpapiren-pjc.dk/en/image-archives/architecture/plan-drawings/'},
    'geodanmark': {'text': 'GeoDanmark Bygning (the footprint the model is placed on), Klimadatastyrelsen', 'licence': 'CC BY 4.0',
                   'url': 'https://dataforsyningen.dk'},
}


def rgb(c):
    return tuple(float(v) for v in srgb_to_linear(np.array(c))) + (1.0,)


def brick_texture(n=512):
    """3 x 3 m of long, thin bricks (about 50 x 4 cm), stepped and of varying tone, deep joints."""
    rs = np.random.default_rng(147)
    img = np.ones((n, n, 3)) * np.array(albedo(BRICK))
    course = 8                                        # ~4.7 cm courses (64 to the repeat)
    for r in range(0, n, course):
        x = int(rs.integers(0, n))
        while True:
            w = int(rs.integers(n // 9, n // 5))        # 33..60 cm
            tone = 1 + rs.normal(0, 0.10)
            xs = (np.arange(x, x + w) % n)
            img[r:r + course - 1, xs] *= tone
            img[r + course - 1, xs] *= 0.55           # bed joint
            img[r:r + course, (x + w) % n] *= 0.55    # head joint
            x += w + 1
            if x > n + n // 3:
                break
    img *= (1 + 0.05 * periodic_noise(n, 1.6, 5, low=2))[..., None]
    return to_image(np.clip(img, 0, 1))


def build(to_twin, y0, low):
    m = Model()
    yb = BRICK_KOTE - 2.0  # local
    # the glazed ground floor: glass all round, 0.6 m in from the brick's base edge, over a slab, under the brick
    ox0, oy0, ox1, oy1 = OUTLINE
    inset = 0.6
    corners = [to_twin(ox0, oy0, inset), to_twin(ox1, oy0, inset), to_twin(ox1, oy1, inset), to_twin(ox0, oy1, inset)]
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        mid = (a + b) / 2
        out = mid - np.mean(corners, axis=0)
        m.poly('glass', [(a[0], low, a[1]), (b[0], low, b[1]), (b[0], yb, b[1]), (a[0], yb, a[1])], (out[0], 0, out[1]), color=rgb(GLASS))
        # mullions every 3 m and the raking V columns behind the glass
        L = np.linalg.norm(b - a)
        t = (b - a) / L
        nrm = np.array([out[0], out[1]]) / np.linalg.norm(out)
        for s in np.arange(3.0, L - 1.0, 3.0):
            p = a + t * s + nrm * 0.02
            m.poly('painted', [(p[0] - t[0] * .04, low, p[1] - t[1] * .04), (p[0] + t[0] * .04, low, p[1] + t[1] * .04),
                               (p[0] + t[0] * .04, yb, p[1] + t[1] * .04), (p[0] - t[0] * .04, yb, p[1] - t[1] * .04)], (nrm[0], 0, nrm[1]), color=rgb(FRAME))
        for s in np.arange(4.0, L - 3.0, 7.0):
            for k in (-1, 1):
                p0 = a + t * s - nrm * 1.2
                p1 = a + t * (s + k * 2.4) - nrm * 1.2
                w = t * 0.18
                m.poly('painted', [(p0[0] - w[0], y0, p0[1] - w[1]), (p0[0] + w[0], y0, p0[1] + w[1]),
                                   (p1[0] + w[0], yb, p1[1] + w[1]), (p1[0] - w[0], yb, p1[1] - w[1])], (nrm[0], 0, nrm[1]), color=rgb(COLUMN))
    rs = np.random.default_rng(403)
    for name, (base, top, kote) in STUBS.items():
        yt = kote - 2.0
        bq = [to_twin(base[0], base[1]), to_twin(base[2], base[1]), to_twin(base[2], base[3]), to_twin(base[0], base[3])]
        tq = [to_twin(top[0], top[1]), to_twin(top[2], top[1]), to_twin(top[2], top[3]), to_twin(top[0], top[3])]
        centre = np.mean(bq, axis=0)
        # the underside, seen from the glass floor and from outside
        m.poly('brick', [(p[0], yb, p[1]) for p in bq], (0, -1, 0), color=rgb((1, 1, 1)))
        m.poly('roof', [(p[0], yt, p[1]) for p in tq], (0, 1, 0), color=rgb(ROOF_DARK))
        for i in range(4):
            b0, b1, t0, t1 = bq[i], bq[(i + 1) % 4], tq[i], tq[(i + 1) % 4]
            mid = (b0 + b1) / 2
            out = mid - centre
            hint = (out[0], 0.3, out[1])
            m.poly('brick', [(b0[0], yb, b0[1]), (b1[0], yb, b1[1]), (t1[0], yt, t1[1]), (t0[0], yt, t0[1])], hint, color=rgb((1, 1, 1)))
            # scattered deep-set windows: small dark quads a hair in front of the sloping face (about 400 over the building)
            area = np.linalg.norm(b1 - b0) * (yt - yb)
            for _ in range(int(area / 28)):
                s, h = rs.uniform(0.12, 0.88), rs.uniform(0.12, 0.92)
                w, hh = rs.choice([0.8, 1.0, 1.3]), rs.choice([0.6, 0.8, 1.0])
                pb, pt = b0 + (b1 - b0) * s, t0 + (t1 - t0) * s
                lo_ = pb + (pt - pb) * h                    # the point on the sloping face at height fraction h
                along = (b1 - b0) / np.linalg.norm(b1 - b0)
                y = yb + (yt - yb) * h
                lean = (pt - pb) / (yt - yb)                # inward per metre up
                nrm = np.array([out[0], out[1]]) / np.linalg.norm(out) * 0.03
                p = lo_ + nrm
                q = [(p[0] - along[0] * w / 2, y, p[1] - along[1] * w / 2), (p[0] + along[0] * w / 2, y, p[1] + along[1] * w / 2),
                     (p[0] + along[0] * w / 2 + lean[0] * hh, y + hh, p[1] + along[1] * w / 2 + lean[1] * hh),
                     (p[0] - along[0] * w / 2 + lean[0] * hh, y + hh, p[1] - along[1] * w / 2 + lean[1] * hh)]
                m.poly('painted', q, hint, color=rgb(WINDOW))
    return m


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', default=str(ROOT / 'data'))
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    a = ap.parse_args()
    data, out = Path(a.data), Path(a.out)
    frame = TwinFrame(data)
    for tid in frame.index['tiles']:
        if GDK_ID in frame.buildings(tid):
            tile, rec = tid, frame.buildings(tid)[GDK_ID]
            break
    else:
        raise SystemExit(f'{GDK_ID} is in no tile')
    ring = np.array(rec['ring'], float).reshape(-1, 2)
    # the diagram's top-left corner is the outline's north-east corner (north-north-east end, east-south-east side); its x runs to the
    # south-south-west end, its y to the west-north-west side (plan L1's north arrow)
    order = sorted(range(4), key=lambda i: ring[i][1])  # the two northernmost corners
    north = [ring[i] for i in order[:2]]
    tl = max(north, key=lambda p: p[0])                 # of those, the eastern one
    i = next(k for k in range(4) if np.allclose(ring[k], tl))
    n1, n2 = ring[(i + 1) % 4], ring[(i - 1) % 4]
    # the long edge from tl runs to the south-south-west end (image x), the short one to the west-north-west (image y)
    ex, ey = (n1, n2) if np.linalg.norm(n1 - tl) > np.linalg.norm(n2 - tl) else (n2, n1)
    ux, uy = ex - tl, ey - tl
    ox0, oy0, ox1, oy1 = OUTLINE

    def to_twin(px, py, inset=0.0):
        fx, fy = (px - ox0) / (ox1 - ox0), (py - oy0) / (oy1 - oy0)
        p = tl + ux * fx + uy * fy
        if inset:
            c = tl + ux * 0.5 + uy * 0.5
            p = p + (c - p) / np.linalg.norm(c - p) * inset * 1.41
        return p

    low = frame.ground_low(rec)
    print(f'tile {tile}; outline {np.linalg.norm(ux):.1f} x {np.linalg.norm(uy):.1f} m; ground {rec["ground"]:.2f}, low {low:.2f}')
    model = build(to_twin, rec['ground'], low - 0.25)
    materials = {'brick': dict(tile=(3.0, 3.0), roughness=0.9), 'roof': dict(roughness=0.8), 'painted': dict(roughness=0.6),
                 'glass': dict(roughness=0.1, metallic=0.6)}
    textures = {'brick': brick_texture}
    body, mesh, lo, hi = model_to_glb(model, 0.0, (0.0, 0.0, 0.0), materials, textures, SET,
                                      root_extras={'building_id': GDK_ID, 'source_ids': ['kai-drawings'], 'attribution': list(ATTRIBUTION),
                                                   'confidence': 'inferred'},
                                      asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                                      attribution=list(ATTRIBUTION), generator='tools/overrides/kai.py')
    rel = f'meshes/{GDK_ID.replace(":", "_")}.glb'
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    (out / rel).write_bytes(body)
    entry = {
        'tile': tile, 'mode': 'replace', 'covers': [GDK_ID], 'footprint': {'use': 'gdk'},
        'match': {'kind': '1:1', 'iou': None, 'hausdorff': None},
        'source': {'ids': ['kai-drawings'], 'kind': 'architect-drawing', 'reconstruction': 'tools/overrides/kai.py'},
        'confidence': 'inferred', 'attribution': list(ATTRIBUTION),
        'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': rec['ground'], 'low': round(low, 2), 'sunk': 0.25,
        'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
    }
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': {GDK_ID: entry}})
    print(f'{out}: {mesh["triangles"]} triangles, {len(body) / 1e6:.2f} MB GLB, {mesh["textureBytes"] / 1e6:.1f} MB textures, top {hi[1]:.2f}')


if __name__ == '__main__':
    main()
