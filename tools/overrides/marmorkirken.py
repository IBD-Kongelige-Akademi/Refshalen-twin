#!/usr/bin/env python3
"""Marmorkirken / Frederiks Kirke (Eigtved and Jardin from 1749, completed by Meldahl 1894; GeoDanmark gdk:1064716606 and the portico
gdk:1064803333): a detail override built from photographs and the historic drawings.

The form: a marble-and-limestone rotunda (two storeys of arched windows, a cornice with a balustrade and statues), a drum ringed by
paired columns, the great copper dome (31 m span, twelve ribs, two rings of gilded oculi), a lantern with its own small dome, ball and
cross, and the columned portico with its pediment towards Amalienborg. Proportions are read from the photographs (images in
Detalje Bygninger/Marmorkirken) and the historic section and plan; the heights are fitted to the twin's measurements (the dome's
DSM p95 at 54.8 m, Roofer's top of the lantern at about 65 m above the ground).

    uv run --no-project --with numpy,pillow python tools/overrides/marmorkirken.py
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
from papiroen import earclip  # noqa: E402

SET = 'marmorkirken'
GDK_ID = 'gdk:1064716606'
PORTICO_ID = 'gdk:1064803333'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET

# heights above the ground (m)
BODY = 20.5          # the rotunda's cornice
BALUSTRADE = 1.4
DRUM_R, DRUM_TOP = 17.6, 34.5
ATTIC_TOP = 36.8
DOME_R, DOME_RISE = 16.8, 17.7     # the dome's springing radius and rise: apex at ATTIC_TOP + DOME_RISE
LANTERN_R, LANTERN_TOP = 3.3, 61.0
CAP_TOP = 64.6
SPIRE_TOP = 70.5

STONE = (0.80, 0.77, 0.70)
COPPER = (0.38, 0.62, 0.54)
RIB = (0.30, 0.52, 0.45)
GOLD = (0.86, 0.68, 0.26)
WINDOW = (0.12, 0.13, 0.15)
STATUE = (0.70, 0.68, 0.63)

ATTRIBUTION = {
    'marmorkirken-photos': {'text': 'Marmorkirken: proportions read from photographs and the historic drawings (Jardin\'s section and elevation; '
                                    'the plan and section DMR-174027), heights fitted to the twin\'s height data', 'licence': 'measurements only',
                            'url': 'https://da.wikipedia.org/wiki/Marmorkirken'},
    'geodanmark': {'text': 'GeoDanmark Bygning (the footprints the model is placed on), Klimadatastyrelsen', 'licence': 'CC BY 4.0',
                   'url': 'https://dataforsyningen.dk'},
}


def rgb(c):
    return tuple(float(v) for v in srgb_to_linear(np.array(c))) + (1.0,)


def stone_texture(n=512):
    """3 x 3 m of ashlar: 0.6 m courses of 1.2-1.6 m blocks, faint joints, a little weathering."""
    rs = np.random.default_rng(1894)
    img = np.ones((n, n, 3)) * np.array(albedo(STONE))
    course = n // 5
    for r in range(0, n, course):
        x = int(rs.integers(0, n))
        while x < n + n // 2:
            w = int(rs.integers(n // 3, n // 2))
            xs = np.arange(x, x + w) % n
            img[r:r + course, xs] *= 1 + rs.normal(0, 0.03)
            img[r:r + course, (x + w) % n] *= 0.84
            x += w
        img[r, :] *= 0.84
    img *= (1 + 0.07 * periodic_noise(n, 1.7, 3, low=2))[..., None]
    return to_image(np.clip(img, 0, 1))


def copper_texture(n=256):
    """2 x 2 m of verdigris with standing seams."""
    img = np.ones((n, n, 3)) * np.array(albedo(COPPER))
    img[:, ::n // 4] *= 0.8
    img *= (1 + 0.12 * periodic_noise(n, 1.5, 9, low=1))[..., None]
    return to_image(np.clip(img, 0, 1))


def arch_window(m, cx, cz, y0, w, h, ang, r, color):
    """An arched window on the cylinder of radius r at angle ang (a flat quad with a segmental head), a hair outside the wall."""
    nx, nz = math.cos(ang), math.sin(ang)
    tx, tz = -nz, nx
    px, pz = cx + nx * (r + 0.05), cz + nz * (r + 0.05)
    pts = [(px - tx * w / 2, y0, pz - tz * w / 2), (px + tx * w / 2, y0, pz + tz * w / 2), (px + tx * w / 2, y0 + h - w / 2, pz + tz * w / 2)]
    for k in range(1, 8):
        a = math.pi * k / 8
        pts.append((px + tx * w / 2 * math.cos(a), y0 + h - w / 2 + w / 2 * math.sin(a), pz + tz * w / 2 * math.cos(a)))
    pts.append((px - tx * w / 2, y0 + h - w / 2, pz - tz * w / 2))
    m.poly('painted', pts, (nx, 0, nz), color=rgb(color))


def build(ring, c, g, low, portico):
    m = Model()
    cx, cz = c
    n = len(ring)
    area2 = sum(ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1] for i in range(n))
    ccw = area2 > 0
    top = g + BODY
    # ---- the rotunda: the GeoDanmark outline up to the cornice
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        L = np.linalg.norm(b - a)
        if L < 1e-3:
            continue
        t = (b - a) / L
        nrm = np.array([t[1], -t[0]]) if ccw else np.array([-t[1], t[0]])
        m.poly('stone', [(a[0], low, a[1]), (b[0], low, b[1]), (b[0], top, b[1]), (a[0], top, a[1])], (nrm[0], 0, nrm[1]), color=rgb((1, 1, 1)))
    for tri in earclip(ring):
        m.poly('stone', [(p[0], top + BALUSTRADE * 0.3, p[1]) for p in tri], (0, 1, 0), color=rgb((1, 1, 1)))
    rr = np.median(np.hypot(ring[:, 0] - cx, ring[:, 1] - cz))
    # cornice, balustrade and statues on the round part
    m.cylinder('stone', cx, cz, rr + 0.7, top - 1.0, top, n=64, r1=rr + 0.9)
    m.cylinder('stone', cx, cz, rr - 0.2, top, top + BALUSTRADE, n=64)
    for k in range(16):
        a = 2 * math.pi * (k + 0.5) / 16
        sx, sz = cx + (rr - 0.2) * math.cos(a), cz + (rr - 0.2) * math.sin(a)
        m.cylinder('painted', sx, sz, 0.45, top + BALUSTRADE, top + BALUSTRADE + 0.6, n=8, color=rgb(STATUE))
        m.cylinder('painted', sx, sz, 0.32, top + BALUSTRADE + 0.6, top + BALUSTRADE + 2.4, n=8, r1=0.2, color=rgb(STATUE))
    # two storeys of arched windows and a band between them, all round (the corner pavilions hide some, as on the building)
    m.cylinder('stone', cx, cz, rr + 0.35, g + 9.0, g + 9.8, n=64)
    for k in range(20):
        a = 2 * math.pi * (k + 0.5) / 20
        arch_window(m, cx, cz, g + 2.2, 2.0, 5.2, a, rr, WINDOW)
        arch_window(m, cx, cz, g + 11.4, 2.0, 6.0, a, rr, WINDOW)
    # ---- the drum with paired columns, the attic, the dome
    m.cylinder('stone', cx, cz, DRUM_R, top, g + DRUM_TOP, n=64)
    for k in range(12):
        a = 2 * math.pi * k / 12
        for d in (-0.055, 0.055):
            px, pz = cx + (DRUM_R + 0.9) * math.cos(a + d), cz + (DRUM_R + 0.9) * math.sin(a + d)
            m.cylinder('stone', px, pz, 0.55, top + BALUSTRADE, g + DRUM_TOP - 1.4, n=10)
        arch_window(m, cx, cz, top + 3.5, 2.2, 7.0, a + math.pi / 12, DRUM_R, WINDOW)
    m.cylinder('stone', cx, cz, DRUM_R + 1.7, g + DRUM_TOP - 1.4, g + DRUM_TOP, n=64)
    m.poly('stone', [(cx + (DRUM_R + 1.7) * math.cos(2 * math.pi * k / 64), g + DRUM_TOP, cz + (DRUM_R + 1.7) * math.sin(2 * math.pi * k / 64))
                     for k in range(64)], (0, 1, 0), color=rgb((1, 1, 1)))
    m.cylinder('stone', cx, cz, DRUM_R - 0.3, g + DRUM_TOP, g + ATTIC_TOP, n=64)
    # dome: a raised half-ellipse, from the attic to the lantern's foot
    prof = []
    for k in range(25):
        th = math.pi / 2 * k / 24
        r = DOME_R * math.cos(th)
        if r < LANTERN_R:
            break
        prof.append((r, g + ATTIC_TOP + DOME_RISE * math.sin(th)))
    m.loft('copper', cx, cz, prof, sides=48)
    dome_top = prof[-1][1]
    # twelve ribs and two rings of gilded oculi
    for k in range(12):
        a = 2 * math.pi * k / 12
        for j in range(len(prof) - 1):
            (r0, h0), (r1, h1) = prof[j], prof[j + 1]
            ca, sa = math.cos(a), math.sin(a)
            ta, tb = -sa * 0.35, ca * 0.35
            q0 = (cx + ca * (r0 + 0.25), h0, cz + sa * (r0 + 0.25))
            q1 = (cx + ca * (r1 + 0.25), h1, cz + sa * (r1 + 0.25))
            m.poly('painted', [(q0[0] - ta, q0[1], q0[2] - tb), (q0[0] + ta, q0[1], q0[2] + tb), (q1[0] + ta, q1[1], q1[2] + tb),
                               (q1[0] - ta, q1[1], q1[2] - tb)], (ca, 0.5, sa), color=rgb(RIB))
        for th_deg, rad in ((18, 0.8), (42, 0.6)):
            th = math.radians(th_deg)
            b = a + math.pi / 12
            r, h = DOME_R * math.cos(th) + 0.12, g + ATTIC_TOP + DOME_RISE * math.sin(th)
            nx, nz = math.cos(b), math.sin(b)
            nrm = (nx * math.cos(th), math.sin(th) * 0.6, nz * math.cos(th))
            ring_g, ring_w = [], []
            for s in range(10):
                p_ = 2 * math.pi * s / 10
                dx, dy = math.cos(p_), math.sin(p_)
                for (lst, rr_) in ((ring_g, rad), (ring_w, rad * 0.7)):
                    lst.append((cx + nx * r - nz * dx * rr_, h + dy * rr_ * math.cos(th), cz + nz * r + nx * dx * rr_))
            m.poly('painted', ring_g, nrm, color=rgb(GOLD))
            m.poly('painted', [(p[0] + nx * 0.03, p[1], p[2] + nz * 0.03) for p in ring_w], nrm, color=rgb(WINDOW))
    # ---- lantern, cap, ball and cross
    m.cylinder('stone', cx, cz, LANTERN_R, dome_top - 0.5, g + LANTERN_TOP, n=24)
    for k in range(8):
        a = 2 * math.pi * k / 8
        m.cylinder('stone', cx + (LANTERN_R + 0.35) * math.cos(a), cz + (LANTERN_R + 0.35) * math.sin(a), 0.22, dome_top, g + LANTERN_TOP - 0.6, n=8)
        arch_window(m, cx, cz, dome_top + 1.2, 1.0, 3.6, a + math.pi / 8, LANTERN_R, WINDOW)
    m.cylinder('stone', cx, cz, LANTERN_R + 0.7, g + LANTERN_TOP - 0.6, g + LANTERN_TOP, n=24)
    cap = [(LANTERN_R + 0.5, g + LANTERN_TOP)] + [((LANTERN_R + 0.5) * math.cos(math.pi / 2 * k / 8), g + LANTERN_TOP + (CAP_TOP - LANTERN_TOP - 1.0) * math.sin(math.pi / 2 * k / 8))
                                                  for k in range(1, 8)]
    m.loft('copper', cx, cz, cap, sides=24)
    m.cylinder('copper', cx, cz, 0.7, cap[-1][1], g + CAP_TOP, n=12, r1=0.35)
    m.cylinder('painted', cx, cz, 0.12, g + CAP_TOP, g + SPIRE_TOP, n=6, color=rgb(GOLD))
    m.ball(cx, g + CAP_TOP + 0.9, cz, 0.6, color=rgb(GOLD))
    m.box('painted', (cx - 0.9, g + SPIRE_TOP - 1.6, cz - 0.08), (cx + 0.9, g + SPIRE_TOP - 1.3, cz + 0.08), color=rgb(GOLD))
    # ---- the portico: columns, entablature, pediment, steps
    if portico is not None:
        P0, P1, out, depth = portico   # front corners (left, right), outward unit vector, depth from the wall
        span = np.linalg.norm(P1 - P0)
        t = (P1 - P0) / span
        back = -out * depth
        ent0, ent1 = g + 15.0, g + 17.2
        apex = ent1 + span * 0.5 * math.tan(math.radians(14))
        for k in range(6):
            s = 0.08 + 0.84 * k / 5
            p = P0 + (P1 - P0) * s - out * 0.9
            m.cylinder('stone', p[0], p[1], 0.75, g + 1.2, ent0, n=14, r1=0.62)
            m.box('stone', (p[0] - 0.95, ent0 - 0.6, p[1] - 0.95), (p[0] + 0.95, ent0, p[1] + 0.95))
        # entablature: a box over the columns back to the wall
        corners = [P0, P1, P1 + back, P0 + back]
        for i in range(4):
            a_, b_ = corners[i], corners[(i + 1) % 4]
            mid = (a_ + b_) / 2 - np.mean(corners, axis=0)
            m.poly('stone', [(a_[0], ent0, a_[1]), (b_[0], ent0, b_[1]), (b_[0], ent1, b_[1]), (a_[0], ent1, a_[1])], (mid[0], 0, mid[1]), color=rgb((1, 1, 1)))
        m.poly('stone', [(p[0], ent0, p[1]) for p in corners], (0, -1, 0), color=rgb((1, 1, 1)))
        # pediment: front and back triangles, two roof slopes (copper)
        Cm, Cb = (P0 + P1) / 2, (P0 + P1) / 2 + back
        for A, B, Cc, nrm in ((P0, P1, Cm, out), (P0 + back, P1 + back, Cb, -out)):
            m.poly('stone', [(A[0], ent1, A[1]), (B[0], ent1, B[1]), (Cc[0], apex, Cc[1])], (nrm[0], 0, nrm[1]), color=rgb((1, 1, 1)))
        for A, Ab, side in ((P0, P0 + back, -t), (P1, P1 + back, t)):
            m.poly('copper', [(A[0], ent1, A[1]), (Ab[0], ent1, Ab[1]), (Cb[0], apex, Cb[1]), (Cm[0], apex, Cm[1])], (side[0], 1.2, side[1]))
        # the sculpture group in the tympanum: a low relief band
        q0, q1 = P0 + t * span * 0.3 + out * 0.05, P1 - t * span * 0.3 + out * 0.05
        m.poly('painted', [(q0[0], ent1 + 0.3, q0[1]), (q1[0], ent1 + 0.3, q1[1]), (q1[0], ent1 + 1.6, q1[1]), (q0[0], ent1 + 1.6, q0[1])], (out[0], 0, out[1]),
               color=rgb(STATUE))
        # steps
        for k in range(4):
            e = out * (0.6 * (4 - k))
            a_, b_ = P0 - t * 0.5 + e, P1 + t * 0.5 + e
            pts = [a_, b_, b_ + back - e, a_ + back - e]
            m.poly('stone', [(p[0], g + 0.3 * (k + 1), p[1]) for p in pts], (0, 1, 0), color=rgb((1, 1, 1)))
            m.poly('stone', [(a_[0], low, a_[1]), (b_[0], low, b_[1]), (b_[0], g + 0.3 * (k + 1), b_[1]), (a_[0], g + 0.3 * (k + 1), a_[1])], (out[0], 0, out[1]),
                   color=rgb((1, 1, 1)))
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
        for gid in (GDK_ID, PORTICO_ID):
            if gid in frame.buildings(tid):
                recs[gid] = frame.buildings(tid)[gid]
                if gid == GDK_ID:
                    tile = tid
    rec = recs[GDK_ID]
    ring = np.array(rec['ring'], float).reshape(-1, 2)
    if np.allclose(ring[0], ring[-1]):
        ring = ring[:-1]
    # the centre of the rotunda: the centroid of the outline
    x, z = ring[:, 0], ring[:, 1]
    cr = x * np.roll(z, -1) - np.roll(x, -1) * z
    A = cr.sum() / 2
    c = np.array([((x + np.roll(x, -1)) * cr).sum() / (6 * A), ((z + np.roll(z, -1)) * cr).sum() / (6 * A)])
    g = rec['ground']
    low = frame.ground_low(rec) - 0.25
    portico = None
    if PORTICO_ID in recs:
        pr = np.array(recs[PORTICO_ID]['ring'], float).reshape(-1, 2)
        pc = pr.mean(0)
        out_ = (pc - c) / np.linalg.norm(pc - c)
        side = np.array([-out_[1], out_[0]])
        s = (pr - c) @ side
        f = (pr - c) @ out_
        front = f.max() + 0.0
        half = (s.max() - s.min()) / 2
        sm = (s.max() + s.min()) / 2
        P0 = c + out_ * front + side * (sm - half)
        P1 = c + out_ * front + side * (sm + half)
        depth = front - f.min() + 2.0
        portico = (P0, P1, out_, depth)
        print(f'portico: {2 * half:.1f} m wide, {depth:.1f} m deep, towards {math.degrees(math.atan2(out_[1], out_[0])):.0f} deg')
    model = build(ring, c, g, low, portico)
    materials = {'stone': dict(tile=(3.0, 3.0), roughness=0.75), 'copper': dict(tile=(2.0, 2.0), roughness=0.6, metallic=0.2),
                 'painted': dict(roughness=0.5)}
    textures = {'stone': stone_texture, 'copper': copper_texture}
    body, mesh, lo, hi = model_to_glb(model, 0.0, (0.0, 0.0, 0.0), materials, textures, SET,
                                      root_extras={'building_id': GDK_ID, 'source_ids': ['marmorkirken-photos'], 'attribution': list(ATTRIBUTION),
                                                   'confidence': 'inferred'},
                                      asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                                      attribution=list(ATTRIBUTION), generator='tools/overrides/marmorkirken.py')
    rel = f'meshes/{GDK_ID.replace(":", "_")}.glb'
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    (out / rel).write_bytes(body)
    covers = [GDK_ID] + ([PORTICO_ID] if PORTICO_ID in recs else [])
    entry = {
        'tile': tile, 'mode': 'replace', 'covers': covers, 'footprint': {'use': 'gdk'},
        'match': {'kind': 'split' if len(covers) > 1 else '1:1', 'iou': None, 'hausdorff': None},
        'source': {'ids': ['marmorkirken-photos'], 'kind': 'photographs', 'reconstruction': 'tools/overrides/marmorkirken.py'},
        'confidence': 'inferred', 'attribution': list(ATTRIBUTION),
        'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': g, 'low': round(low, 2), 'sunk': 0.25,
        'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
    }
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': {GDK_ID: entry}})
    print(f'{out}: {mesh["triangles"]} triangles, {len(body) / 1e6:.2f} MB GLB, top {hi[1]:.2f} (ground {g:.2f})')


if __name__ == '__main__':
    main()
