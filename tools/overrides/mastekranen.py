#!/usr/bin/env python3
"""Mastekranen on Nyholm (1748-51, Philip de Lange; GeoDanmark gdk:1064733899): a detail override built from the construction drawing
in Nationalmuseet's collection ("Konstruktionstegning af Mastekranen på Nyholm", OM 1990:0327, no known rights).

The square plastered tower (four storeys of small windows, an arched door), its bell-shaped roof with a railed platform, and the sheer
legs: two raking masts standing on the platform and leaning out over the water, braced back to the tower, with the hoisting tackle.
Proportions are read from elevation F of the drawing (the tower's width is the footprint's); heights are fitted to the twin's height
data (the roof's DSM p95 and Roofer's top).

    uv run --no-project --with numpy,pillow python tools/overrides/mastekranen.py
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

SET = 'mastekranen'
GDK_ID = 'gdk:1064733899'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET

# heights above the ground (m), from elevation F scaled to the measured roof
CORNICE = 21.5
ROOF_TOP = 28.2          # the bell roof's flat top
RAIL = 1.1
SHEERS_APEX = 44.0       # where the two legs meet, out over the water
SHEERS_REACH = 13.0      # m out from the tower's water face at the apex
LEG = 0.35               # half the legs' section

PLASTER = (0.92, 0.87, 0.72)
ROOF = (0.24, 0.25, 0.26)
TIMBER = (0.24, 0.20, 0.16)
WINDOW = (0.12, 0.12, 0.13)
TRIM = (0.93, 0.91, 0.86)

ATTRIBUTION = {
    'mastekranen-drawing': {'text': 'Mastekranen: proportions read from "Konstruktionstegning af Mastekranen på Nyholm" (Nationalmuseet, OM 1990:0327)',
                            'licence': 'no known rights', 'url': 'https://samlinger.natmus.dk/'},
    'geodanmark': {'text': 'GeoDanmark Bygning (the footprint the model is placed on), Klimadatastyrelsen', 'licence': 'CC BY 4.0',
                   'url': 'https://dataforsyningen.dk'},
}


def rgb(c):
    return tuple(float(v) for v in srgb_to_linear(np.array(c))) + (1.0,)


def plaster_texture(n=256):
    img = np.ones((n, n, 3)) * np.array(albedo(PLASTER))
    img *= (1 + 0.08 * periodic_noise(n, 1.6, 21, low=1))[..., None]
    return to_image(np.clip(img, 0, 1))


def beam(m, a, b, r, color):
    """A square timber from a to b (3D points), half-section r."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = (b - a) / np.linalg.norm(b - a)
    up = np.array([0, 1.0, 0]) if abs(d[1]) < 0.9 else np.array([1.0, 0, 0])
    s1 = np.cross(d, up)
    s1 /= np.linalg.norm(s1)
    s2 = np.cross(d, s1)
    cs = [s1 * r + s2 * r, -s1 * r + s2 * r, -s1 * r - s2 * r, s1 * r - s2 * r]
    for i in range(4):
        c0, c1 = cs[i], cs[(i + 1) % 4]
        m.poly('painted', [a + c0, a + c1, b + c1, b + c0], (c0 + c1), color=rgb(color))


def build(ring, ground, low, water):
    m = Model()
    c = ring.mean(0)
    # the tower's frame: the face towards the water and the one across it
    n = len(ring)
    edges = [(ring[i], ring[(i + 1) % n]) for i in range(n)]
    top = ground + CORNICE
    for a, b in edges:
        mid = (a + b) / 2
        out = (mid - c) / np.linalg.norm(mid - c)
        L = np.linalg.norm(b - a)
        t = (b - a) / L
        m.poly('plaster', [(a[0], low, a[1]), (b[0], low, b[1]), (b[0], top, b[1]), (a[0], top, a[1])], (out[0], 0, out[1]), color=rgb((1, 1, 1)))
        # corner quoins, a plinth band, the cornice
        for p_ in (a + t * 0.45, b - t * 0.45):
            q = p_ + out * 0.06
            w = t * 0.45
            m.poly('painted', [(q[0] - w[0], ground, q[1] - w[1]), (q[0] + w[0], ground, q[1] + w[1]), (q[0] + w[0], top, q[1] + w[1]),
                               (q[0] - w[0], top, q[1] - w[1])], (out[0], 0, out[1]), color=rgb(TRIM))
        # four storeys of small windows on the axis, a door on the ground floor of the land side
        mid_w = (a + b) / 2 + out * 0.05
        for k, y in enumerate((ground + 5.5, ground + 9.5, ground + 13.5, ground + 17.3)):
            h = 2.0 if k < 3 else 1.6
            w = t * 0.65
            m.poly('painted', [(mid_w[0] - w[0], y, mid_w[1] - w[1]), (mid_w[0] + w[0], y, mid_w[1] + w[1]), (mid_w[0] + w[0], y + h, mid_w[1] + w[1]),
                               (mid_w[0] - w[0], y + h, mid_w[1] - w[1])], (out[0], 0, out[1]), color=rgb(WINDOW))
        if out @ water < -0.5:
            w = t * 1.3
            m.poly('painted', [(mid_w[0] - w[0], ground, mid_w[1] - w[1]), (mid_w[0] + w[0], ground, mid_w[1] + w[1]), (mid_w[0] + w[0], ground + 3.4, mid_w[1] + w[1]),
                               (mid_w[0] - w[0], ground + 3.4, mid_w[1] - w[1])], (out[0], 0, out[1]), color=rgb(TIMBER))
    # cornice (a slight overhang) and the bell roof: concave above the eaves, up to a flat platform
    def ring_at(off):
        return [c + (p - c) * (1 + off / np.linalg.norm(p - c)) for p in ring]
    eave = ring_at(0.8)
    for (a, b), (ea, eb) in zip(edges, zip(eave, eave[1:] + eave[:1])):
        mid = (a + b) / 2
        out = (mid - c) / np.linalg.norm(mid - c)
        m.poly('painted', [(a[0], top - 0.5, a[1]), (b[0], top - 0.5, b[1]), (eb[0], top, eb[1]), (ea[0], top, ea[1])], (out[0], -1, out[1]), color=rgb(TRIM))
    roof_h = ROOF_TOP - CORNICE
    steps = [(0.8, 0.0), (0.2, 0.18), (-0.8, 0.38), (-2.0, 0.6), (-3.0, 0.82), (-3.5, 1.0)]
    rings = [ring_at(o) for o, _ in steps]
    for (r0, (o0, f0)), (r1, (o1, f1)) in zip(zip(rings, steps), zip(rings[1:], steps[1:])):
        for i in range(n):
            a0, b0, a1, b1 = r0[i], r0[(i + 1) % n], r1[i], r1[(i + 1) % n]
            mid = (a0 + b0) / 2
            out = (mid - c) / np.linalg.norm(mid - c)
            m.poly('roof', [(a0[0], top + roof_h * f0, a0[1]), (b0[0], top + roof_h * f0, b0[1]), (b1[0], top + roof_h * f1, b1[1]),
                            (a1[0], top + roof_h * f1, a1[1])], (out[0], 0.8, out[1]), color=rgb(ROOF))
    plat = rings[-1]
    ytop = ground + ROOF_TOP
    m.poly('roof', [(p[0], ytop, p[1]) for p in plat], (0, 1, 0), color=rgb(ROOF))
    # a dormer on the water side
    for i in range(n):
        a0, b0 = rings[1][i], rings[1][(i + 1) % n]
        mid = (a0 + b0) / 2
        out = (mid - c) / np.linalg.norm(mid - c)
        if out @ water > 0.5:
            t = (b0 - a0) / np.linalg.norm(b0 - a0)
            q = mid + out * 0.5
            y0 = top + roof_h * 0.2
            m.poly('painted', [(q[0] - t[0], y0, q[1] - t[1]), (q[0] + t[0], y0, q[1] + t[1]), (q[0] + t[0], y0 + 1.6, q[1] + t[1]), (q[0] - t[0], y0 + 1.6, q[1] - t[1])],
                   (out[0], 0, out[1]), color=rgb(TRIM))
            m.poly('painted', [(q[0] - t[0] * .6 + out[0] * .03, y0 + .2, q[1] - t[1] * .6 + out[1] * .03), (q[0] + t[0] * .6 + out[0] * .03, y0 + .2, q[1] + t[1] * .6 + out[1] * .03),
                               (q[0] + t[0] * .6 + out[0] * .03, y0 + 1.3, q[1] + t[1] * .6 + out[1] * .03), (q[0] - t[0] * .6 + out[0] * .03, y0 + 1.3, q[1] - t[1] * .6 + out[1] * .03)],
                   (out[0], 0, out[1]), color=rgb(WINDOW))
    # the railing round the platform
    for i in range(n):
        a0, b0 = plat[i], plat[(i + 1) % n]
        mid = (a0 + b0) / 2
        out = (mid - c) / np.linalg.norm(mid - c)
        m.poly('painted', [(a0[0], ytop, a0[1]), (b0[0], ytop, b0[1]), (b0[0], ytop + RAIL, b0[1]), (a0[0], ytop + RAIL, a0[1])], (out[0], 0, out[1]), color=rgb(TRIM))
    # ---- the sheer legs: feet on the platform's water corners, apex out over the water
    side = np.array([-water[1], water[0]])
    half = max(abs((p - c) @ side) for p in plat) - 0.4
    face = max((p - c) @ water for p in ring)
    foot_d = max((p - c) @ water for p in plat) - 0.6
    feet = [c + water * foot_d + side * half, c + water * foot_d - side * half]
    apex2 = c + water * (face + SHEERS_REACH)
    ya = ground + SHEERS_APEX
    A = np.array([apex2[0], ya, apex2[1]])
    F = [np.array([f[0], ytop, f[1]]) for f in feet]
    for f in F:
        beam(m, f, A + np.array([0, 0.3, 0]), LEG, TIMBER)
    # cross braces between the legs (the lattice of elevation D)
    for k in (0.25, 0.5, 0.75):
        p0, p1 = F[0] + (A - F[0]) * k, F[1] + (A - F[1]) * k
        beam(m, p0, p1, LEG * 0.6, TIMBER)
        if k < 0.75:
            q0, q1 = F[0] + (A - F[0]) * (k + 0.25), F[1] + (A - F[1]) * (k + 0.25)
            beam(m, p0, q1, LEG * 0.45, TIMBER)
            beam(m, p1, q0, LEG * 0.45, TIMBER)
    # the back stays: from the apex down to the land side of the platform
    back = c - water * foot_d
    beam(m, A, np.array([back[0], ytop + 0.4, back[1]]), LEG * 0.5, TIMBER)
    # a flagpole on the platform and the tackle hanging from the apex
    beam(m, np.array([c[0], ytop, c[1]]), np.array([c[0], ytop + 6.5, c[1]]), 0.08, TIMBER)
    beam(m, A - np.array([0, 0.2, 0]), np.array([A[0], ground + 18.0, A[2]]), 0.05, (0.1, 0.1, 0.1))
    m.box('painted', (A[0] - 0.4, ground + 17.2, A[2] - 0.25), (A[0] + 0.4, ground + 18.2, A[2] + 0.25), color=rgb(TIMBER))
    return m


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', default=str(ROOT / 'data'))
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    a = ap.parse_args()
    data, out = Path(a.data), Path(a.out)
    frame = TwinFrame(data)
    tile = rec = None
    for tid in frame.index['tiles']:
        if GDK_ID in frame.buildings(tid):
            tile, rec = tid, frame.buildings(tid)[GDK_ID]
            break
    ring = np.array(rec['ring'], float).reshape(-1, 2)
    if np.allclose(ring[0], ring[-1]):
        ring = ring[:-1]
    # the water side: west (the attached store house is on the east); snapped to the nearest face normal
    c = ring.mean(0)
    best = None
    for i in range(len(ring)):
        mid = (ring[i] + ring[(i + 1) % len(ring)]) / 2
        o = (mid - c) / np.linalg.norm(mid - c)
        if best is None or o[0] < best[0]:
            best = o
    water = best
    g = rec['ground']
    low = frame.ground_low(rec) - 0.25
    model = build(ring, g, low, water)
    materials = {'plaster': dict(tile=(2.0, 2.0), roughness=0.9), 'roof': dict(roughness=0.7), 'painted': dict(roughness=0.7)}
    body, mesh, lo, hi = model_to_glb(model, 0.0, (0.0, 0.0, 0.0), materials, {'plaster': plaster_texture}, SET,
                                      root_extras={'building_id': GDK_ID, 'source_ids': ['mastekranen-drawing'], 'attribution': list(ATTRIBUTION),
                                                   'confidence': 'inferred'},
                                      asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                                      attribution=list(ATTRIBUTION), generator='tools/overrides/mastekranen.py')
    rel = f'meshes/{GDK_ID.replace(":", "_")}.glb'
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    (out / rel).write_bytes(body)
    entry = {
        'tile': tile, 'mode': 'replace', 'covers': [GDK_ID], 'footprint': {'use': 'gdk'},
        'match': {'kind': '1:1', 'iou': None, 'hausdorff': None},
        'source': {'ids': ['mastekranen-drawing'], 'kind': 'historic-drawing', 'reconstruction': 'tools/overrides/mastekranen.py'},
        'confidence': 'inferred', 'attribution': list(ATTRIBUTION),
        'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': g, 'low': round(low, 2), 'sunk': 0.25,
        'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
    }
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': {GDK_ID: entry}})
    print(f'{out}: {mesh["triangles"]} triangles, top {hi[1]:.2f}, water side {water.round(2)}')


if __name__ == '__main__':
    main()
