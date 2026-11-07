#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Budolfi Kirke (Aalborg Domkirke, Algade): a detail override built from the cathedral's facade drawings and the survey of its spire (docs/budolfi.md).

The walls, roofs, gables and openings are read from the four facades of the 2000 renovation at 1:100 (Budolfi.pdf pages 50-53: west, north, east and
south, drawn over the 1986 survey). The baroque spire of 1779 is read from the 1934 survey of its timbers (Budolfi_spir.pdf page 8). The GeoDanmark
footprint places the walls in plan. The drawings' heights are tied to the twin by the surface model: the nave's ridge, which all four sheets show,
lies at 22.45 m in the twin's frame, and the tower's cornice then falls at 30.4 m on all of them. Colours come from the 2021 Skraafoto flight.

The model is in the church's own frame: u east along the nave, v south across it, from the north-west corner of the footprint's box, and h is the twin's
own height (local y), so that no datum has to be carried.

    PYTHONUTF8=1 uv run tools/overrides/budolfi.py [--data data] [--out DIR]
    PYTHONUTF8=1 uv run tools/overrides/publish.py install
"""
from __future__ import annotations

import argparse, hashlib, math, sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from overrides_lib import SOURCE_FORMAT, TwinFrame, write_json
from override_model import GOLD, UP, Model, WallFrame, albedo, arch, circle, model_to_glb, periodic_noise, rgb, to_image

SET = 'budolfi'
GDK_ID = 'gdk:1019258625'
TILE = '1111_12646'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET

AXIS_DEG = 6.6  # every long edge of the footprint
ORIGIN = (-244.547, -17.705)  # the footprint box's north-west corner, in the twin's x, z

# ------------------------------------------------------------------------------------------------------------------------- the measures
# In plan (u, v), from the GeoDanmark footprint; in height (local y), from the facades by way of the ridge.
NAVE = (10.2, 52.04, 16.48, 27.64)  # nave and chancel under one roof: u0, u1, v0, v1
EAVE, RIDGE = 15.45, 22.45
EAST_GABLE = 23.6  # the crest of the stepped gable over the chancel's east end (sheets 51-53)
APSE = [(52.08, 16.48), (57.74, 19.47), (57.74, 24.07), (52.04, 27.64)]  # the east end, its corners cut back, north to south
EAST_END = 57.74  # the roof runs on over the cut corners to the crow-stepped gable on the east front (photographs, surface model)
N_AISLE = (9.9, 32.0, 10.93, 16.48)
S_AISLE = (9.9, 32.15, 27.64, 33.24)
AISLE_FOOT_N, AISLE_FOOT_S, AISLE_HEAD = 7.75, 8.65, 14.05  # the lean-to roofs: eaves on the north and the south, and where they meet the nave
CLERESTORY_SILL, CLERESTORY_TOP = 14.25, 15.25
TOWER = (1.3, 10.2, 17.55, 27.05)
TOWER_TOP = 30.4  # the top of the cornice
TOWER_BAND = 13.15
CHAPEL = (32.0, 41.9, 2.31, 16.48)  # the north chapel of 1899, its roof running on to the nave
CHAPEL_EAVE, CHAPEL_RIDGE, CHAPEL_GABLE = 8.45, 12.9, 16.75
CHAPEL_FRONT = (36.47, 41.9, 0.0, 2.31, 5.6)  # the low room before its gable
PORCH = (32.15, 40.84, 27.64, 39.8)  # the south porch
PORCH_EAVE, PORCH_RIDGE, PORCH_GABLE = 9.5, 13.0, 16.15
ANNEX = (1.27, 9.9, 27.05, 33.24)  # south of the tower, its stepped gable towards Algade
ANNEX_EAVE, ANNEX_RIDGE, ANNEX_GABLE = 13.25, 18.1, 19.9
NW_ROOM = (1.38, 8.89, 15.22, 17.55, 8.2, 10.0)  # the low room north of the tower: u0, u1, v0, v1, eave, head against the tower
OVER = 0.35  # how far the eaves stand out

# The spire (1934 survey, 55.9 px to the metre at the scan's 2400 px; the section cut through the flats): (half across the flats, height over the cornice).
LOWER_BELL = [(4.3, 0.0), (3.13, 1.52), (3.49, 1.88), (3.79, 2.33), (3.97, 2.86), (3.97, 4.3), (3.67, 5.0), (3.04, 5.72), (2.68, 6.44), (2.68, 6.62)]
LANTERN = (2.68, 6.62, 13.15)  # the open octagon: half across the flats, foot, head
UPPER_BELL = [(3.13, 13.15), (2.06, 14.58), (2.4, 15.1), (2.54, 15.56), (2.5, 16.1), (2.24, 16.8), (1.88, 17.5), (1.52, 18.16), (1.34, 18.78),
              (1.07, 19.5), (0.75, 20.57), (0.45, 21.8), (0.14, 23.6), (0.02, 25.6)]
VANE = 29.9  # the rod's head over the cornice
SPIRE_C = ((TOWER[0] + TOWER[1]) / 2, (TOWER[2] + TOWER[3]) / 2)

WHITE_SHADE, DARK, DOOR, CLOCK, LOUVRE = rgb(.62, .62, .6), rgb(.05, .05, .06), rgb(.24, .17, .12), rgb(.88, .87, .82), rgb(.16, .16, .16)


def rect_ring(u0, u1, v0, v1):
    """Clockwise seen from above (u east, v south): north, east, south and west walls in that order."""
    return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]


def pointed(sill, top, w, seg=6):
    """A pointed (equilateral) arch: (h, half width) going up."""
    a = w / 2
    rise = min(0.866 * w, top - sill)
    hs = top - rise
    out = [(sill, a), (hs, a)] if hs > sill + 1e-6 else [(sill, a)]
    for k in range(1, seg + 1):
        t = math.radians(60) * k / seg
        out.append((hs + rise * math.sin(t) / math.sin(math.radians(60)), max(0.0, w * math.cos(t) - a)))
    return out


# ------------------------------------------------------------------------------------------------------------------------- building blocks
def openings(m, w, ops, depth=0.45):
    """The reveals of a wall's openings: ops = [(absolute u or v, outline, kind)]. kind: glass, door, louvre or niche."""
    for c, o, kind in ops:
        s = w.at(c)
        if kind == 'glass':
            m.reveal(w, s, o, depth, side='wall')
        elif kind == 'door':
            m.reveal(w, s, o, depth + 0.1, fill='painted', color=DOOR, side='wall')
        elif kind == 'louvre':
            m.reveal(w, s, o, depth, fill='painted', color=LOUVRE, side='wall')
        else:
            m.reveal(w, s, o, 0.18, fill='painted', color=WHITE_SHADE, side='wall')


def block(m, ring, h0, tops, ops=None, depth=0.45, skip=()):
    """Walls round a clockwise ring, from h0 to tops[i] (one height, or one per edge), with their openings: ops = {edge: [(coord, outline, kind)]}.
    skip: edges that stand against another part's wall."""
    ops = ops or {}
    n = len(ring)
    tops = tops if isinstance(tops, (list, tuple)) else [tops] * n
    for i in range(n):
        if i in skip:
            continue
        w = WallFrame(ring[i], ring[(i + 1) % n])
        here = ops.get(i, [])
        m.wall('wall', w, h0, tops[i], [(w.at(c), o) for c, o, _ in here])
        openings(m, w, here, depth)


def gable_roof(m, u0, u1, v0, v1, eave, ridge, along='u', ends=(True, True), over=OVER):
    """A saddle roof whose ridge runs along u (or v), standing out `over` beyond its walls and dropping with the slope; `ends`: draw the gable infill."""
    if along == 'u':
        vm, half = (v0 + v1) / 2, (v1 - v0) / 2
        drop = over * (ridge - eave) / half
        for sgn, ve in ((-1, v0 - over), (1, v1 + over)):
            m.poly('roof', [(u0 - over * 0.3, eave - drop, ve), (u1 + over * 0.3, eave - drop, ve), (u1 + over * 0.3, ridge, vm), (u0 - over * 0.3, ridge, vm)], UP + (0, 0, sgn))
        for u, sgn, on in ((u0, -1, ends[0]), (u1, 1, ends[1])):
            if on:
                m.poly('wall', [(u, eave, v0), (u, eave, v1), (u, ridge, vm)], (sgn, 0, 0))
    else:
        um, half = (u0 + u1) / 2, (u1 - u0) / 2
        drop = over * (ridge - eave) / half
        for sgn, ue in ((-1, u0 - over), (1, u1 + over)):
            m.poly('roof', [(ue, eave - drop, v0 - over * 0.3), (ue, eave - drop, v1 + over * 0.3), (um, ridge, v1 + over * 0.3), (um, ridge, v0 - over * 0.3)], UP + (sgn, 0, 0))
        for v, sgn, on in ((v0, -1, ends[0]), (v1, 1, ends[1])):
            if on:
                m.poly('wall', [(u0, eave, v), (u1, eave, v), (um, ridge, v)], (0, 0, sgn))


def stepped_gable(m, w, h0, crest, steps, t=0.55, niches=0, cap='roof'):
    """A crow-stepped gable on the wall plane `w` (its whole length), from the eaves h0 to its crest: stacked courses, each `steps` narrower to a side, capped.
    `niches`: tall blind recesses in its face, as the sheets draw them, shown as shaded panels."""
    L = w.length
    sw = L / (2 * steps + 1)
    rise = (crest - h0) / (steps + 1)
    for k in range(steps + 1):
        s0, s1 = k * sw, L - k * sw
        a, b = h0 + k * rise, h0 + (k + 1) * rise
        c = lambda s, h, d: w.p(s, h, d)
        m.poly('wall', [c(s0, a, 0), c(s1, a, 0), c(s1, b, 0), c(s0, b, 0)], w.n)
        m.poly('wall', [c(s0, a, -t), c(s1, a, -t), c(s1, b, -t), c(s0, b, -t)], -w.n)
        m.poly('wall', [c(s0, a, 0), c(s0, a, -t), c(s0, b, -t), c(s0, b, 0)], -w.t)
        m.poly('wall', [c(s1, a, 0), c(s1, a, -t), c(s1, b, -t), c(s1, b, 0)], w.t)
        top_to = s1 if k == steps else s0 + sw
        for p0, p1 in ((s0, top_to), (max(s1 - sw, top_to), s1)) if k < steps else ((s0, s1),):
            m.poly(cap, [c(p0, b, 0.05), c(p1, b, 0.05), c(p1, b + 0.06, -t - 0.05), c(p0, b + 0.06, -t - 0.05)], UP + w.n * 0.3)
    # the blind recesses: one tall panel in each course's free width, up to below its step
    if niches:
        for k in range(steps + 1):
            for sc in ((k + 0.5) * sw, L - (k + 0.5) * sw) if k < steps else ((L / 2),):
                top = h0 + (k + 1) * rise - 0.35
                bottom = max(h0 + 0.4, top - (k + 1) * rise * 0.8)
                if top - bottom < 0.6:
                    continue
                o = pointed(bottom, top, min(0.55, sw * 0.5))
                m.poly('painted', [w.p(sc - a_, h, 0.02) for h, a_ in o] + [w.p(sc + a_, h, 0.02) for h, a_ in reversed(o)], w.n, color=WHITE_SHADE)


def buttress(m, u, v, du, dv, h0, h1):
    """A buttress standing out (du, dv) from the wall at (u, v), 0.9 m wide, its head sloped back."""
    if du:
        a, b = (u, v - 0.45), (u + du, v + 0.45)
    else:
        a, b = (u - 0.45, v), (u + 0.45, v + dv)
    (ua, va), (ub, vb) = a, b
    u0, u1, v0, v1 = min(ua, ub), max(ua, ub), min(va, vb), max(va, vb)
    m.box('wall', (u0, h0, v0), (u1, h1 - 0.7, v1), skip=('b',))
    # the sloped head
    if du:
        far = u + du
        m.poly('roof', [(far, h1 - 0.7, v0), (far, h1 - 0.7, v1), (u, h1, v1), (u, h1, v0)], UP + (np.sign(du), 0, 0))
        for vv, sg in ((v0, -1), (v1, 1)):
            m.poly('wall', [(far, h1 - 0.7, vv), (u, h1 - 0.7, vv), (u, h1, vv)], (0, 0, sg))
    else:
        far = v + dv
        m.poly('roof', [(u0, h1 - 0.7, far), (u1, h1 - 0.7, far), (u1, h1, v), (u0, h1, v)], UP + (0, 0, np.sign(dv)))
        for uu, sg in ((u0, -1), (u1, 1)):
            m.poly('wall', [(uu, h1 - 0.7, far), (uu, h1 - 0.7, v), (uu, h1, v)], (sg, 0, 0))


# ------------------------------------------------------------------------------------------------------------------------- the church
def add_nave(m, hb):
    u0, u1, v0, v1 = NAVE
    win = lambda: arch(CLERESTORY_SILL, CLERESTORY_TOP, 0.9)
    # the clerestory's small round-headed windows over the aisles' roofs (sheets 51 and 53)
    ops = {0: [(u, win(), 'glass') for u in (14.9, 20.4, 26.2, 35.1)] + [(u, pointed(9.6, 13.1, 1.5), 'glass') for u in (44.6, 49.9)],
           2: [(u, win(), 'glass') for u in (15.7, 21.5, 26.4)] + [(u, arch(8.15, 13.05, 1.6), 'glass') for u in (42.6, 49.4)]}
    block(m, rect_ring(u0, u1, v0, v1), hb, [EAVE, EAVE, EAVE, EAVE], ops, skip=(1, 3))  # the tower and the apse close its ends
    gable_roof(m, u0, EAST_END - 0.45, v0, v1, EAVE, RIDGE, 'u', ends=(False, False))
    # the east gable, crow-stepped and set with blind recesses (sheet 52), standing on the east front
    stepped_gable(m, WallFrame((EAST_END, v0), (EAST_END, v1)), EAVE, EAST_GABLE, 6, niches=1)
    # the buttresses at the chancel's corners (sheets 52 and 53)
    for v, dv in ((v0, -1.1), (v1, 1.1)):
        buttress(m, u1 - 0.45, v, 0, dv, hb, 11.5)


def add_apse(m, hb):
    ring = APSE
    ops = {1: [(21.77, arch(8.6, 12.4, 1.4), 'glass')]}
    for i in range(len(ring) - 1):
        w = WallFrame(ring[i], ring[i + 1])
        here = ops.get(i, [])
        m.wall('wall', w, hb, EAVE, [(w.at(c), o) for c, o, _ in here])
        openings(m, w, here)
    # over each cut corner, a ledge under the gable's overhang
    (a, b), (c, d) = (ring[0], ring[1]), (ring[2], ring[3])
    m.poly('roof', [(a[0], EAVE, a[1]), (EAST_END, EAVE, a[1]), (b[0], EAVE, b[1])], UP)
    m.poly('roof', [(d[0], EAVE, d[1]), (c[0], EAVE, c[1]), (EAST_END, EAVE, d[1])], UP)
    for u, v in ring[1:3]:
        buttress(m, u, v + (0.0 if v > 22 else 0.0), 1.0, 0, hb, 10.5)


def add_aisles(m, hb):
    # north: four large round-headed windows between buttresses (sheet 51)
    u0, u1, v0, v1 = N_AISLE
    ops = {0: [(u, arch(3.65, 7.05, 3.0), 'glass') for u in (13.7, 19.2, 24.9, 29.8)]}
    block(m, rect_ring(u0, u1, v0, v1), hb, [AISLE_FOOT_N, AISLE_FOOT_N, AISLE_FOOT_N, AISLE_FOOT_N], ops)
    drop = OVER * (AISLE_HEAD - AISLE_FOOT_N) / (v1 - v0)
    m.poly('roof', [(u0 - 0.1, AISLE_FOOT_N - drop, v0 - OVER), (u1, AISLE_FOOT_N - drop, v0 - OVER), (u1, AISLE_HEAD, v1), (u0 - 0.1, AISLE_HEAD, v1)], UP + (0, 0, -1))
    m.poly('wall', [(u0, AISLE_FOOT_N, v0), (u0, AISLE_FOOT_N, v1), (u0, AISLE_HEAD, v1)], (-1, 0, 0))
    for u in (16.4, 21.9, 27.4):
        buttress(m, u, v0, 0, -0.7, hb, 6.8)
    # south: the same, its eaves 0.9 m higher (sheet 53)
    u0, u1, v0, v1 = S_AISLE
    ops = {2: [(u, arch(4.8, 7.85, 2.9), 'glass') for u in (13.45, 18.85, 24.35, 28.9)]}
    block(m, rect_ring(u0, u1, v0, v1), hb, [AISLE_FOOT_S] * 4, ops)
    drop = OVER * (AISLE_HEAD - AISLE_FOOT_S) / (v1 - v0)
    m.poly('roof', [(u0, AISLE_HEAD, v0), (u1, AISLE_HEAD, v0), (u1, AISLE_FOOT_S - drop, v1 + OVER), (u0, AISLE_FOOT_S - drop, v1 + OVER)], UP + (0, 0, 1))
    for u in (16.4, 21.6, 26.7):
        buttress(m, u, v1, 0, 0.7, hb, 7.7)


def add_chapel(m, hb):
    """The north chapel of 1899: its decorated crow-stepped gable (sheet 51, dated in its face) over a low room, its roof running on to the nave."""
    u0, u1, v0, v1 = CHAPEL
    ops = {0: [(37.0, pointed(9.0, 12.6, 1.0), 'glass'), (35.6, pointed(9.0, 11.8, 0.8), 'glass'), (38.4, pointed(9.0, 11.8, 0.8), 'glass'),
               (33.6, arch(5.9, 7.6, 1.0), 'glass')],
           1: [(c, pointed(3.4, 6.6, 1.5), 'glass') for c in (6.0, 10.0)],
           3: [(c, pointed(3.4, 6.6, 1.5), 'glass') for c in (6.0,)]}
    block(m, rect_ring(u0, u1, v0, v1), hb, CHAPEL_EAVE, ops)
    gable_roof(m, u0, u1, v0, v1, CHAPEL_EAVE, CHAPEL_RIDGE, 'v', ends=(False, False))
    stepped_gable(m, WallFrame((u0, v0), (u1, v0)), CHAPEL_EAVE, CHAPEL_GABLE, 5, niches=1)
    # its pinnacles, on the gable's foot and over its crest
    for u in (u0 + 0.3, u1 - 0.3):
        m.box('wall', (u - 0.3, CHAPEL_EAVE, v0 - 0.2), (u + 0.3, CHAPEL_EAVE + 1.6, v0 + 0.4), skip=('b',))
        m.poly('roof', [(u - 0.32, CHAPEL_EAVE + 1.6, v0 - 0.22), (u + 0.32, CHAPEL_EAVE + 1.6, v0 - 0.22), (u, CHAPEL_EAVE + 2.3, v0 + 0.1)], UP + (0, 0, -1))
    a0, a1, b0, b1, top = CHAPEL_FRONT
    block(m, rect_ring(a0, a1, b0, b1), hb, top, {0: [((a0 + a1) / 2, arch(hb + 0.2 if hb > 1 else 1.9, 4.4, 1.3), 'door')]})
    m.box('roof', (a0 - 0.15, top, b0 - 0.15), (a1 + 0.15, top + 0.2, b1), skip=('b',))


def add_porch(m, hb):
    u0, u1, v0, v1 = PORCH
    um = (u0 + u1) / 2
    ops = {2: [(um, pointed(2.9, 6.6, 1.9), 'door'), (um, pointed(7.6, 9.2, 0.8), 'glass')], 1: [(36.0, arch(4.9, 7.4, 1.2), 'glass')], 3: [(36.0, arch(4.9, 7.4, 1.2), 'glass')]}
    block(m, rect_ring(u0, u1, v0, v1), hb, PORCH_EAVE, ops)
    gable_roof(m, u0, u1, v0, v1, PORCH_EAVE, PORCH_RIDGE, 'v', ends=(False, False))
    stepped_gable(m, WallFrame((u1, v1), (u0, v1)), PORCH_EAVE, PORCH_GABLE, 4, niches=1)


def add_annex(m, hb):
    """South of the tower: the room with the big pointed window over its door and the crow-stepped gable towards the street (sheets 50 and 53)."""
    u0, u1, v0, v1 = ANNEX
    um = (u0 + u1) / 2
    ops = {2: [(um, pointed(3.6, 6.9, 1.6), 'door'), (um, pointed(7.2, 10.0, 1.7), 'glass'), (um, arch(11.2, 12.4, 0.7), 'glass')],
           3: [(30.0, arch(8.5, 10.8, 0.8), 'glass')]}
    block(m, rect_ring(u0, u1, v0, v1), hb, ANNEX_EAVE, ops)
    gable_roof(m, u0, u1, v0, v1, ANNEX_EAVE, ANNEX_RIDGE, 'v', ends=(False, False))
    stepped_gable(m, WallFrame((u1, v1), (u0, v1)), ANNEX_EAVE, ANNEX_GABLE, 4, niches=1)
    # the north-west room against the tower, under a lean-to
    a0, a1, b0, b1, eave, head = NW_ROOM
    block(m, rect_ring(a0, a1, b0, b1), hb, eave, {0: [(4.0, arch(3.4, 5.6, 0.9), 'glass')]})
    m.poly('roof', [(a0 - 0.2, eave - 0.1, b0 - 0.3), (a1 + 0.2, eave - 0.1, b0 - 0.3), (a1 + 0.2, head, b1), (a0 - 0.2, head, b1)], UP + (0, 0, -1))
    for u, sg in ((a0, -1), (a1, 1)):
        m.poly('wall', [(u, eave, b0), (u, eave, b1), (u, head, b1)], (sg, 0, 0))


def tower_face_ops(face):
    """The openings of each face of the tower (sheets 50-53), as (offset from the face's middle, outline, kind)."""
    clock = (0.0, circle(28.65, 0.95), 'clock')
    if face == 'west':
        return [(0.0, pointed(2.9, 7.75, 3.2), 'door'), (0.0, circle(10.35, 0.6), 'glass'), (-2.8, pointed(17.95, 19.25, 0.45), 'glass'), (2.8, pointed(17.95, 19.25, 0.45), 'glass'),
                (-2.8, pointed(20.85, 22.25, 0.9), 'niche'), (-1.4, pointed(20.85, 23.65, 1.0), 'niche'), (0.0, pointed(20.85, 24.35, 1.0), 'niche'),
                (1.4, pointed(20.85, 23.65, 1.0), 'niche'), (2.8, pointed(20.85, 22.25, 0.9), 'niche'),
                (-1.3, pointed(25.85, 27.95, 1.2), 'louvre'), (1.3, pointed(25.85, 27.95, 1.2), 'louvre'), clock]
    if face == 'east':
        return [(-1.3, pointed(25.85, 27.95, 1.2), 'louvre'), (1.3, pointed(25.85, 27.95, 1.2), 'louvre'), clock]
    if face == 'north':
        return [(-1.2, arch(13.9, 15.0, 0.6), 'glass'), (1.2, arch(13.9, 15.0, 0.6), 'glass'), (-1.5, arch(16.5, 17.7, 0.55), 'glass'), (1.5, arch(16.5, 17.7, 0.55), 'glass'),
                (-2.8, pointed(19.35, 20.75, 0.8), 'niche'), (-1.4, pointed(19.35, 21.75, 0.9), 'niche'), (0.0, pointed(19.35, 22.45, 0.9), 'niche'),
                (1.4, pointed(19.35, 21.75, 0.9), 'niche'), (2.8, pointed(19.35, 20.75, 0.8), 'niche'), (0.0, pointed(24.9, 27.95, 1.6), 'louvre'), clock]
    return [(0.0, arch(21.0, 22.2, 0.5), 'glass'), (0.0, pointed(24.75, 26.85, 1.2), 'louvre'), clock]


def add_tower(m, hb):
    u0, u1, v0, v1 = TOWER
    ring = rect_ring(u0, u1, v0, v1)
    names = ['north', 'east', 'south', 'west']
    for i, name in enumerate(names):
        w = WallFrame(ring[i], ring[(i + 1) % 4])
        mid = w.length / 2
        ops = [(mid + off, o, kind) for off, o, kind in tower_face_ops(name)]
        m.wall('wall', w, hb, TOWER_TOP - 0.45, [(s, o) for s, o, _ in ops])
        for s, o, kind in ops:
            if kind == 'clock':
                # a white dial in a dark ring, with its hands at ten past ten
                hc, r = o[len(o) // 2][0], o[len(o) // 2][1]
                m.reveal(w, s, o, 0.12, fill='painted', color=CLOCK, side='wall')
                for ang, ln in ((math.radians(60), 0.75), (math.radians(150), 0.55)):
                    tip = (s + ln * math.cos(ang) * r, hc + ln * math.sin(ang) * r)
                    side = np.array([-math.sin(ang), math.cos(ang)]) * 0.04
                    m.poly('painted', [w.p(s + side[0], hc + side[1], -0.1), w.p(s - side[0], hc - side[1], -0.1), w.p(tip[0] - side[0], tip[1] - side[1], -0.1),
                                       w.p(tip[0] + side[0], tip[1] + side[1], -0.1)], w.n, color=DARK)
            else:
                axis = 0 if abs(w.t2[0]) > 0.5 else 1
                openings(m, w, [(w.a[axis] + s * w.t2[axis], o, kind)], 0.6)
    # the string course and the cornice, all round
    m.band('wall', ring, [(0.0, TOWER_BAND - 0.25), (0.12, TOWER_BAND - 0.12), (0.12, TOWER_BAND), (0.0, TOWER_BAND + 0.05)])
    m.band('wall', ring, [(0.0, TOWER_TOP - 0.45), (0.15, TOWER_TOP - 0.35), (0.35, TOWER_TOP - 0.2), (0.45, TOWER_TOP - 0.05), (0.45, TOWER_TOP)])
    m.poly('roof', [(u0 - 0.45, TOWER_TOP, v0 - 0.45), (u1 + 0.45, TOWER_TOP, v0 - 0.45), (u1 + 0.45, TOWER_TOP, v1 + 0.45), (u0 - 0.45, TOWER_TOP, v1 + 0.45)], UP)
    add_spire(m)


def add_spire(m):
    """The spire of 1779 (Budolfi_spir.pdf p. 8): a bell-shaped octagonal roof, the open lantern, a second bell and the needle, the ball and the vane's rod."""
    cu, cv = SPIRE_C
    up = lambda prof: [(r, TOWER_TOP + h) for r, h in prof]
    m.loft('spire', cu, cv, up(LOWER_BELL), sides=8, rot=math.pi / 8)
    r, h0, h1 = LANTERN
    m.loft('wall', cu, cv, [(r, TOWER_TOP + h0), (r, TOWER_TOP + h1 - 0.55)], sides=8, rot=math.pi / 8, smooth=False)
    m.loft('wall', cu, cv, [(r, TOWER_TOP + h1 - 0.55), (r + 0.2, TOWER_TOP + h1 - 0.3), (r + 0.3, TOWER_TOP + h1)], sides=8, rot=math.pi / 8, smooth=False)
    # the lantern's eight round-headed openings, dark between its posts
    step = 2 * math.pi / 8
    for i in range(8):
        a = math.pi / 8 + i * step - math.pi / 2
        nrm = np.array([math.cos(a), 0, math.sin(a)])
        tng = np.array([-math.sin(a), 0, math.cos(a)])
        ctr = np.array([cu, 0, cv]) + nrm * (r + 0.03)
        o = arch(TOWER_TOP + h0 + 0.9, TOWER_TOP + h1 - 1.1, 1.25)
        pts = [ctr + tng * -hw + UP * h for h, hw in o] + [ctr + tng * hw + UP * h for h, hw in reversed(o)]
        m.poly('painted', pts, nrm, color=DARK)
    m.loft('spire', cu, cv, up(UPPER_BELL), sides=8, rot=math.pi / 8)
    m.cylinder('painted', cu, cv, 0.05, TOWER_TOP + UPPER_BELL[-1][1] - 0.4, TOWER_TOP + VANE, n=6, color=DARK)
    m.ball(cu, TOWER_TOP + 26.6, cv, 0.32, color=GOLD)
    # the vane, across the rod
    m.poly('painted', [(cu - 0.05, TOWER_TOP + 27.6, cv), (cu - 0.05, TOWER_TOP + 28.4, cv), (cu + 1.3, TOWER_TOP + 28.2, cv), (cu + 1.3, TOWER_TOP + 27.8, cv)], (0, 0, 1), color=GOLD)
    m.ball(cu, TOWER_TOP + VANE, cv, 0.12, color=GOLD)


def build(hb=1.0):
    """The cathedral in its own frame. hb: how far its walls go down."""
    m = Model()
    add_tower(m, hb)
    add_nave(m, hb)
    add_apse(m, hb)
    add_aisles(m, hb)
    add_chapel(m, hb)
    add_porch(m, hb)
    add_annex(m, hb)
    return m


# ------------------------------------------------------------------------------------------------------------------------- textures
# sRGB in sunlight on the 2021 Skraafoto flight: whitewashed brick walls, grey (lead) roofs and spire.
TONES = {'wall': (0.88, 0.87, 0.84), 'roof': (0.52, 0.53, 0.55)}


def wall_texture(n=512, seed=41):
    """Whitewash over brick: the courses still show faintly through it (7.5 cm, running bond), the lime is patchy and greyer low on the wall."""
    rs = np.random.default_rng(seed)
    y, x = np.mgrid[0:n, 0:n] + 0.5
    rows, cols = 64, 16  # a 4.8 m repeat
    cy = y / n * rows
    cj = np.floor(cy).astype(int)
    cx = x / n * cols + 0.5 * (cj % 2)
    bed = np.minimum(cy % 1, 1 - cy % 1) < 0.07
    head = np.minimum(cx % 1, 1 - cx % 1) < 0.02
    lum = 1 + 0.03 * rs.normal(0, 1, (rows, cols))[cj, np.floor(cx).astype(int) % cols]
    lum = np.where(bed | head, 0.95, lum)
    lum *= 1 + 0.04 * periodic_noise(n, 1.6, seed + 1, low=1) + 0.015 * periodic_noise(n, 0.6, seed + 2, low=24)
    return to_image(np.clip(np.array(albedo(TONES['wall'])) * lum[..., None], 0, 1))


def roof_texture(n=512, seed=43):
    """Lead in strips 0.6 m wide between rolls, dulled unevenly: a 4.8 m repeat."""
    x = (np.arange(n) + 0.5) / n * 8
    roll = np.exp(-((np.minimum(x % 1, 1 - x % 1)) / 0.035) ** 2)
    lum = 1 + 0.18 * roll[None, :] - 0.08 * np.exp(-((np.minimum((x - 0.06) % 1, 1 - (x - 0.06) % 1)) / 0.03) ** 2)[None, :]
    lum = lum * (1 + 0.07 * periodic_noise(n, 1.4, seed, stretch=(1.0, 0.3), low=1) + 0.03 * periodic_noise(n, 0.5, seed + 1, low=20))
    return to_image(np.clip(np.array(albedo(TONES['roof'])) * lum[..., None], 0, 1))


def glass_texture(n=256, seed=45):
    """Leaded lights: small dark panes in grey cames, 0.3 m by 0.4 m to the pane."""
    rs = np.random.default_rng(seed)
    y, x = np.mgrid[0:n, 0:n] + 0.5
    cx, cy = x / n * 4, y / n * 3
    came = (np.minimum(cx % 1, 1 - cx % 1) < 0.05) | (np.minimum(cy % 1, 1 - cy % 1) < 0.04)
    pane = np.array([0.03, 0.035, 0.045]) * (1 + 0.3 * rs.normal(0, 1, (3, 4)))[np.floor(cy).astype(int), np.floor(cx).astype(int)][..., None]
    return to_image(np.clip(np.where(came[..., None], np.array([0.2, 0.2, 0.2]), pane), 0, 1))


TEXTURES = {'wall': wall_texture, 'roof': roof_texture, 'glass': glass_texture}
MATERIALS = {
    'wall': dict(tile=(4.8, 4.8), roughness=0.95),
    'roof': dict(tile=(4.8, 4.8), roughness=0.6, metallic=0.2),
    'spire': dict(tile=(2.4, 2.4), texture='roof', color=(0.92, 0.93, 0.95, 1.0), roughness=0.5, metallic=0.25),
    'glass': dict(tile=(1.2, 1.2), roughness=0.15, metallic=0.4),
    'painted': dict(tile=None, roughness=0.6),
}
ATTRIBUTION = {
    'budolfi-tegning-2000': {'text': 'Sankt Budolfi - Aalborg Domkirke, hovedrenovering 1. afsnit: facades towards west, north, east and south, Arkitekter Dall & Lindhardtsen A/S, 2000 (after the survey of 1986, Brøgger arkitektfirma)', 'licence': 'municipal building file', 'url': ''},
    'budolfi-spir-1934': {'text': 'Budolfi Kirke: opmaaling af spiret, 1934 (building commission case on the partial renewal of the spire)', 'licence': 'historic building file', 'url': ''},
    'skraafoto-2021': {'text': 'Skråfoto 2021, Klimadatastyrelsen (colours, checks)', 'licence': 'CC BY 4.0 terms for free geographic data', 'url': 'https://dataforsyningen.dk'},
    'geodanmark': {'text': 'GeoDanmark Bygning (placement)', 'licence': 'CC BY 4.0', 'url': 'https://www.geodanmark.dk'},
}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', default=str(ROOT / 'data'))
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    a = ap.parse_args()
    data, out = Path(a.data), Path(a.out)
    frame = TwinFrame(data)
    rec = frame.buildings(TILE)[GDK_ID]
    low = frame.ground_low(rec)
    model = build(low - 0.25)
    body, mesh, lo, hi = model_to_glb(model, AXIS_DEG, (ORIGIN[0], 0.0, ORIGIN[1]), MATERIALS, TEXTURES, SET,
                                      root_extras={'building_id': GDK_ID, 'source_ids': list(ATTRIBUTION)[:2], 'attribution': list(ATTRIBUTION), 'confidence': 'observed'},
                                      asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                                      attribution=list(ATTRIBUTION), generator='tools/overrides/budolfi.py')
    rel = 'meshes/gdk_1019258625.glb'
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    (out / rel).write_bytes(body)
    entry = {
        'tile': TILE, 'mode': 'replace', 'covers': [GDK_ID], 'footprint': {'use': 'gdk'},
        'match': {'kind': '1:1', 'iou': 0.95, 'hausdorff': 1.0},
        'source': {'ids': list(ATTRIBUTION)[:2], 'kind': 'architect-drawing', 'reconstruction': 'tools/overrides/budolfi.py'},
        'confidence': 'observed', 'attribution': list(ATTRIBUTION),
        'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': rec['ground'], 'low': round(low, 2), 'sunk': 0.25,
        'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
    }
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': {GDK_ID: entry}})
    print(f'{out}: {mesh["triangles"]} triangles, {len(body) / 1e6:.2f} MB GLB, {mesh["textureBytes"] / 1e6:.1f} MB textures, walls down to {low - 0.25:.2f}, top {hi[1]:.2f}')


if __name__ == '__main__':
    main()
