#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Hotel Hvide Hus (Vesterbro 2, Aalborg): a detail override built from its drawings (docs/hvide-hus.md).

The tower comes from the architects' facades of 1967 (HvideHus_1967.pdf, pages 7-10, 1:100). The podium, the white east block with its apse and the entrance
come from the facades and plan of the 2005 alterations ("facade bund"), and the terrace towards Kildeparken from the 2002 landscape plans ("facade mod park",
LA.02-LA.06). The GeoDanmark footprint and the 2021 Skraafoto flight place and colour it, and settle what was built differently.

The model's frame: u east, across the tower, from the west end of the footprint's box. v south, along the tower, from its north end. h up from the ground floor,
kote 8.83.

    PYTHONUTF8=1 uv run tools/overrides/hvide_hus.py [--data data] [--out DIR]
    PYTHONUTF8=1 uv run tools/overrides/publish.py install     # every set, so also the church
"""
from __future__ import annotations

import argparse, hashlib, math, sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from overrides_lib import SOURCE_FORMAT, TwinFrame, write_json
from override_model import Model, UP, WallFrame, albedo, model_to_glb, periodic_noise, rect, rgb, to_image

SET = 'hvide-hus'
GDK_ID = 'gdk:1019237254'
TILE = '1110_12644'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET

AXIS_DEG = 5.15  # all of the footprint's long edges
ORIGIN = (-692.692, 625.458)  # the footprint box's north-west corner, in the twin's x, z
GRADE_Y = 8.83 - 3.85  # kote 8.83 (ground floor and terrace, LA.02), less the twin's origin height

# ---------------------------------------------------------------------------------------------------------------------------- 1967: the tower (pages 7-10)
TW, TE, TN, TS = 6.55, 25.6, 4.0, 46.6  # the balcony slabs' outer edges: 19.05 m by 42.6 m
WALL_E, WALL_S = 1.24, 1.36  # how far the room walls stand back from them, on the long sides and the gables
FIRST_SLAB, STOREY, SLAB, FLOORS = 10.2, 2.82, 1.05, 12
TOP_FASCIA = (44.04, 46.1)  # the closed top: fascia, ribbon of windows, fascia
ROOF_FASCIA = (47.9, 49.8)
ROOF_LEVEL = 48.9  # the surface model's, under the drawn fascia
RAILS = (0.25, 0.42)  # the two steel rails, over the slab
# the column lines on both long sides, from the north: bays of 5.1 m and 3.6 m in turn
PIERS = (5.36, 10.47, 14.09, 19.2, 22.8, 27.9, 31.5, 36.6, 40.2, 45.24)
BAY_REPEAT = 8.7
# as built, from the surface model and photographs. Pages 7-9 draw it smaller (17.5 m by 11.2 m), at the same height
PENT = (9.0, 24.4, 10.2, 32.4, 51.9)
PLANT = (15.2, 19.3, 18.0, 23.2, 54.6)

# --------------------------------------------------------------------------------------------------------------------- 2005: the podium (facades 160-161, 260-261, plan 100)
PW, PE, PN, PS = 2.33, 37.6, 1.52, 49.18  # the fascias
GW, GE, GN, GS = 4.8, 36.3, 4.0, 46.7  # the ground floor's glass
G_TOP, F1_TOP, RIB_TOP, F2_TOP = 3.05, 5.09, 6.7, 9.14
PODIUM_ROOF = F2_TOP - 0.8  # behind the fascia, by the surface model
LIFT = (13.05, 17.98, 0.0, TN + WALL_S, 52.0)  # the glazed lift tower on the north gable (u0, u1, v0, v1, top), on the footprint and surface model
# the white east block on its piers
BLOCK_E, BLOCK_N, BLOCK_S, BLOCK_TOP = 44.0, 12.0, 38.4, 13.8
TIERS = ((0.0, 2.9), (4.8, 7.2), (8.4, 11.5))  # the openings in its east front, over each other
EAST_BAYS = ((12.4, 16.0), (16.5, 20.0), (30.9, 34.4), (34.8, 38.2))  # and side by side, either side of the apse
SIDE_BAY = (38.8, 41.9)  # one over the other in the north and south ends, with the open stairs behind them
APSE = (BLOCK_E - 0.7, 25.3, 4.85)  # centre u, v and radius
APSE_RINGS = ((2.9, 4.8), (7.2, 8.4), (11.5, BLOCK_TOP))
VAULT_W = 34.95  # the centre of the metal vault's west end

# -------------------------------------------------------------------------------------------------------------------------------- 2002: the terrace (LA.02-LA.06)
TERR_N, TERR_S, TERR_E = -0.4, 49.2, 52.0
HEDGE = (6.2, 45.9, 52.0, 57.85)  # v0, v1, u0, u1: the clipped beech on its bank
K = lambda kote: kote - 8.83  # a kote on the plans as h
HEDGE_TOP, HEDGE_FOOT, WALL_FOOT, PARK = K(9.83), K(6.64), K(6.00), K(4.70)
LANDING = K(7.00)
# the stairs at the terrace's ends (LA.05): a flight in a well in the terrace's edge, down to the landing, and the flight on towards the park. v at the flight's top, at the
# landing, at the landing's end, and the lower flight's width. The drawn fan of steps is simplified to one flight.
WELL_U, STEPS, STAIR_RUN = 48.7, 12, 6.0
STAIRS = ((HEDGE[0], HEDGE[0] - 3.6, TERR_N, (TERR_N, HEDGE[0])), (HEDGE[1] - 3.6, HEDGE[1], TERR_S, (HEDGE[1], TERR_S)))
LEVELS = ((LANDING, PARK), (LANDING, PARK))  # per stair (landing h, foot h): the koter; stair_levels sets them on the twin's ground
WALL_T, PARAPET = 0.2, 0.9
WALL_W = PE - 1.5  # the terrace's walls start here, against the podium
POOL = (39.8, 42.0, 3.0, 9.9, K(8.78))
PLINTH = (39.0, 44.0, 40.2, 41.0)

STEEL, DARK, WHITE = rgb(.30, .31, .33), rgb(.05, .06, .07), rgb(.84, .84, .82)
LIFT_CAP, FRAME, COOLER, VENT = rgb(.56, .57, .58), rgb(.16, .17, .19), rgb(.78, .78, .76), rgb(.70, .70, .68)
WATER = rgb(.10, .15, .20)
DISC = rgb(.42, .41, .39)


def rect_faces(u0, u1, v0, v1):
    """The outward wall frames of a rectangle: north, east, south, west."""
    return [WallFrame((u0, v0), (u1, v0)), WallFrame((u1, v0), (u1, v1)), WallFrame((u1, v1), (u0, v1)), WallFrame((u0, v1), (u0, v0))]


def rect_ring(u0, u1, v0, v1):
    return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]


def glass_face(m, w, s0, s1, h0, h1, d=0.0, mat='glass', tile_h=3.2):
    """A band of glazing whose panes run its whole height."""
    m.poly(mat, [w.p(s0, h0, d), w.p(s1, h0, d), w.p(s1, h1, d), w.p(s0, h1, d)], w.n, uvs=[(s0, 0.0), (s1, 0.0), (s1, tile_h), (s0, tile_h)])


# ------------------------------------------------------------------------------------------------------------------------------------------------- the tower
def balcony_wall(m, side, floor, h0, h1):
    """The rooms behind the balconies, a bay texture repeating every 5.1 + 3.6 m. Rows of the texture differ, so the floors do not look alike."""
    u = TW + WALL_E if side == 'w' else TE - WALL_E
    n = -1 if side == 'w' else 1
    v0, v1 = TN + WALL_S, TS - WALL_S
    row = (floor * 3 + (side == 'e')) % 4
    t0, t1 = (v0 - PIERS[0]), (v1 - PIERS[0])
    m.poly('rooms', [(u, h0, v0), (u, h0, v1), (u, h1, v1), (u, h1, v0)], (n, 0, 0),
           uvs=[(t0, row * ROW_H), (t1, row * ROW_H), (t1, (row + 1) * ROW_H), (t0, (row + 1) * ROW_H)])


def add_tower(m):
    # the storey under the first slab, recessed
    for w in rect_faces(TW + WALL_E, TE - WALL_E, TN + WALL_S, TS - WALL_S):
        glass_face(m, w, 0, w.length, F2_TOP, FIRST_SLAB, mat='concrete', tile_h=FIRST_SLAB - F2_TOP)
    for k in range(FLOORS):
        h0 = FIRST_SLAB + STOREY * k
        h1 = h0 + SLAB
        top = h0 + STOREY
        m.box('concrete', (TW, h0, TN), (TE, h1, TS), skip=('b',))
        m.poly('soffit', [(TW, h0, TN), (TE, h0, TN), (TE, h0, TS), (TW, h0, TS)], -UP)
        balcony_wall(m, 'w', k, h1, top)
        balcony_wall(m, 'e', k, h1, top)
        # the gables: the end of the rooms, with the corridor's window in the south one (sheet 10)
        north = WallFrame((TW + WALL_E, TN + WALL_S), (TE - WALL_E, TN + WALL_S))
        south = WallFrame((TE - WALL_E, TS - WALL_S), (TW + WALL_E, TS - WALL_S))
        m.wall('concrete', north, h1, top)
        c = south.length / 2
        o = rect(h1 + 0.25, top - 0.45, 2.7)
        m.wall('concrete', south, h1, top, [(c, o)])
        m.reveal(south, c, o, 0.2, side='concrete')
        # the piers between the balconies, and the ones at the gables
        for v in PIERS:
            for u, sgn in ((TW + WALL_E, -1), (TE - WALL_E, 1)):
                a, b = (u, u + sgn * 0.85)
                m.box('concrete', (min(a, b), h1, v - 0.11), (max(a, b), top, v + 0.11), skip=('t', 'b'))
        # the rails, right round
        for r in RAILS:
            y0, y1 = h1 + r, h1 + r + 0.05
            for u in (TW + 0.03, TE - 0.08):
                m.box('painted', (u, y0, TN + 0.03), (u + 0.05, y1, TS - 0.03), color=STEEL, skip=('n', 's'))
            for v in (TN + 0.03, TS - 0.08):
                m.box('painted', (TW + 0.03, y0, v), (TE - 0.03, y1, v + 0.05), color=STEEL, skip=('w', 'e'))
    # the closed top: fascia, ribbon of windows behind its mullions, roof fascia
    m.box('concrete', (TW, TOP_FASCIA[0], TN), (TE, TOP_FASCIA[1], TS), skip=('b',))
    m.poly('soffit', [(TW, TOP_FASCIA[0], TN), (TE, TOP_FASCIA[0], TN), (TE, TOP_FASCIA[0], TS), (TW, TOP_FASCIA[0], TS)], -UP)
    u0, u1 = TW + 0.2, TE - 0.2
    v0, v1 = TN + 0.15, TS - 0.15
    for w in rect_faces(u0, u1, v0, v1):
        glass_face(m, w, 0, w.length, TOP_FASCIA[1], ROOF_FASCIA[0])
    m.poly('concrete', [(TW, ROOF_FASCIA[0], TN), (TE, ROOF_FASCIA[0], TN), (TE, ROOF_FASCIA[0], TS), (TW, ROOF_FASCIA[0], TS)], -UP)
    ring = rect_ring(TW, TE, TN, TS)
    m.band('concrete', ring, [(0.0, ROOF_FASCIA[0]), (0.0, ROOF_FASCIA[1])])
    m.band('painted', ring, [(0.0, ROOF_FASCIA[1]), (-0.35, ROOF_FASCIA[1]), (-0.35, ROOF_LEVEL)], color=VENT)
    m.poly('roof', [(TW + .35, ROOF_LEVEL, TN + .35), (TE - .35, ROOF_LEVEL, TN + .35), (TE - .35, ROOF_LEVEL, TS - .35), (TW + .35, ROOF_LEVEL, TS - .35)], UP)
    add_penthouse(m)


def add_penthouse(m):
    u0, u1, v0, v1, top = PENT
    for k, w in enumerate(rect_faces(u0, u1, v0, v1)):
        if k == 2:  # the windows are in its south end
            glass_face(m, w, 0, w.length, ROOF_LEVEL, top - 0.7)
            m.wbox('concrete', w, 0, w.length, top - 0.7, top, 0.0, 0.12, top=False)
        else:
            glass_face(m, w, 0, w.length, ROOF_LEVEL, top, mat='concrete', tile_h=top - ROOF_LEVEL)
    m.band('painted', rect_ring(u0, u1, v0, v1), [(0.12, top), (-0.3, top), (-0.3, top - 0.25)], color=VENT)
    m.poly('roof', [(u0 + .3, top - .25, v0 + .3), (u1 - .3, top - .25, v0 + .3), (u1 - .3, top - .25, v1 - .3), (u0 + .3, top - .25, v1 - .3)], UP)
    pu0, pu1, pv0, pv1, ptop = PLANT
    m.box('concrete', (pu0, top - .3, pv0), (pu1, ptop, pv1), skip=('b', 't'))
    m.poly('roof', [(pu0, ptop, pv0), (pu1, ptop, pv0), (pu1, ptop, pv1), (pu0, ptop, pv1)], UP)
    # what stands on the roofs: the flues and the coolers
    for u, v, r, h in ((20.3, 13.5, 0.42, 1.0), (21.6, 21.2, 0.3, 0.8), (17.5, 29.0, 0.3, 0.7), (11.6, 26.5, 0.42, 0.9)):
        m.cylinder('painted', u, v, r, top - .3, top + h, n=10, color=COOLER)
    for k in range(6):
        v = 13.2 + k * 0.95
        m.box('painted', (22.9, top - .3, v), (23.3, top + 1.5, v + 0.08), color=FRAME)
    for u, v in ((8.0, 6.5), (8.0, 42.0), (23.5, 42.0), (23.5, 38.4)):
        m.box('painted', (u - .7, ROOF_LEVEL, v - .5), (u + .7, ROOF_LEVEL + .8, v + .5), color=COOLER)


def add_lift(m, hb):
    u0, u1, v0, v1, top = LIFT
    for k, w in enumerate(rect_faces(u0, u1, v0, v1)):
        if k == 2:
            continue
        m.poly('lift', [w.p(0, hb), w.p(w.length, hb), w.p(w.length, top), w.p(0, top)], w.n,
               uvs=[(0, hb), (w.length, hb), (w.length, top), (0, top)])
    # the steel in front of the glass
    north = rect_faces(u0, u1, v0, v1)[0]
    for s in np.linspace(0.1, north.length - 0.1, 6):
        m.wbox('painted', north, s - 0.07, s + 0.07, hb, top - 0.6, 0.0, 0.14, color=FRAME, top=False)
    for f in (rect_faces(u0, u1, v0, v1)[1], rect_faces(u0, u1, v0, v1)[3]):
        for s in (0.1, f.length - 1.5, f.length - 0.1):
            m.wbox('painted', f, s - 0.07, s + 0.07, hb, top - 0.6, 0.0, 0.14, color=FRAME, top=False)
    m.box('painted', (u0 - .12, top - .6, v0 - .12), (u1 + .12, top, v1), color=rgb(.13, .17, .28), skip=('t',))
    m.poly('painted', [(u0 - .12, top, v0 - .12), (u1 + .12, top, v0 - .12), (u1 + .12, top, v1), (u0 - .12, top, v1)], UP, color=LIFT_CAP)


# ------------------------------------------------------------------------------------------------------------------------------------------------ the podium
def add_podium(m, hb):
    # the ground floor's glass above its low stone band (260, 261), the upper ribbon, the two dark fascias
    for w in rect_faces(GW, GE, GN, GS):
        glass_face(m, w, 0, w.length, 0.7, G_TOP)
        m.wbox('paving', w, -0.02, w.length + 0.02, hb, 0.7, -0.02, 0.05, top=True)
    for w in rect_faces(PW + .25, PE - .25, PN + .25, PS - .25):
        glass_face(m, w, 0, w.length, F1_TOP, RIB_TOP)
    m.box('clad', (PW, G_TOP, PN), (PE, F1_TOP, PS))
    m.box('clad', (PW, RIB_TOP, PN), (PE, F2_TOP, PS), skip=('t',))
    ring = rect_ring(PW, PE, PN, PS)
    m.band('painted', ring, [(0.03, F2_TOP - 0.05), (0.03, F2_TOP), (-0.25, F2_TOP), (-0.25, PODIUM_ROOF)], color=WHITE)
    # its roof, gravel behind the fascia's upstand as the surface model has it, with the row of vents on the west side
    m.poly('gravel', [(PW + .25, PODIUM_ROOF, PN + .25), (PE - .25, PODIUM_ROOF, PN + .25), (PE - .25, PODIUM_ROOF, PS - .25), (PW + .25, PODIUM_ROOF, PS - .25)], UP)
    for k in range(9):
        v = 8.0 + k * 4.4
        m.box('painted', (4.3, PODIUM_ROOF, v), (4.9, PODIUM_ROOF + .55, v + .6), color=VENT, skip=('b',))
    # the piers along the ground floor's east side
    for v in (4.5, 10.8, 40.0, 46.3):
        m.box('wall', (GE, hb, v - .25), (PE - .1, G_TOP, v + .25), skip=('t',))
    add_west_front(m)
    add_outside_stairs(m, hb)


def add_west_front(m):
    """The glass bay over the entrance and the curved canopy, on the footprint's notch (160, 260)."""
    v0, v1, u0, u1, h0, h1 = 5.3, 19.5, 1.3, PW, 4.0, 7.04
    faces = [WallFrame((u0, v1), (u0, v0)), WallFrame((u0, v0), (u1, v0)), WallFrame((u1, v1), (u0, v1))]
    for w in faces:
        glass_face(m, w, 0, w.length, h0, h1)
    m.box('painted', (u0 - .05, h0 - .1, v0 - .05), (u1, h0, v1 + .05), color=FRAME)
    m.box('painted', (u0 - .05, h1, v0 - .05), (u1, h1 + .1, v1 + .05), color=FRAME)
    for v in np.linspace(v0, v1, 6):
        m.box('painted', (u0 - .05, h0, v - .04), (u0 + .02, h1, v + .04), color=FRAME, skip=('t', 'b'))
    # the canopy, swept up at its tip
    prof = [(GW, 3.0), (2.5, 3.05), (1.0, 3.2), (0.1, 3.55), (-0.27, 3.7)]
    a, b = 14.4, 19.2
    for (e0, y0), (e1, y1) in zip(prof, prof[1:]):
        m.poly('metal', [(e0, y0, a), (e0, y0, b), (e1, y1, b), (e1, y1, a)], UP, uvs=[(a, e0), (b, e0), (b, e1), (a, e1)])
        m.poly('painted', [(e0, y0 - .06, a), (e0, y0 - .06, b), (e1, y1 - .06, b), (e1, y1 - .06, a)], -UP, color=VENT)
    for v in (a, b):
        for (e0, y0), (e1, y1) in zip(prof, prof[1:]):
            m.poly('painted', [(e0, y0 - .06, v), (e1, y1 - .06, v), (e1, y1, v), (e0, y0, v)], (0, 0, 1 if v == b else -1), color=VENT)
    # the doors under it
    w = WallFrame((GW, 19.0), (GW, 14.6))
    for s0, s1 in ((0.1, 1.6), (1.7, 2.7), (2.8, 4.3)):
        m.poly('painted', [w.p(s0, 0.7, .03), w.p(s1, 0.7, .03), w.p(s1, 2.5, .03), w.p(s0, 2.5, .03)], w.n, color=DARK)
    m.wbox('painted', w, 0, w.length, 2.5, G_TOP - .1, 0.0, .06, color=FRAME)


def add_outside_stairs(m, hb):
    """The steel escape stairs on the north and south sides (160, 161): two flights and a landing, up to the first floor."""
    for v0, v1 in ((0.15, 1.35), (49.5, 50.7)):
        flights = [((36.4, 0.0), (33.3, 2.33)), ((31.9, 2.33), (29.0, 4.8))]
        if v0 > PS:  # outside the terrace's wall: the lower flight runs on down to the ground
            flights[0] = ((36.4 + (0.0 - hb) * 3.1 / 2.33, hb), (33.3, 2.33))
        landings = [(33.3, 31.9, 2.33), (29.0, 26.6, 4.8)]
        for (e0, h0), (e1, h1) in flights:
            pts = [(e0, h0, v0), (e0, h0, v1), (e1, h1, v1), (e1, h1, v0)]
            m.poly('painted', pts, UP, color=STEEL)
            m.poly('painted', [(a, b - .12, c) for a, b, c in pts], -UP, color=FRAME)
            for v in (v0, v1):
                m.poly('painted', [(e0, h0 + .95, v), (e1, h1 + .95, v), (e1, h1 + 1.0, v), (e0, h0 + 1.0, v)], (0, 0, 1), color=FRAME)
                m.poly('painted', [(e0, h0, v), (e1, h1, v), (e1, h1 - .12, v), (e0, h0 - .12, v)], (0, 0, 1), color=FRAME)
        for e0, e1, h in landings:
            m.box('painted', (e1, h - .12, v0), (e0, h, v1), color=STEEL)
            for v in (v0, v1):
                m.poly('painted', [(e0, h + .95, v), (e1, h + .95, v), (e1, h + 1.0, v), (e0, h + 1.0, v)], (0, 0, 1), color=FRAME)
        for e, h in ((33.0, 2.33), (32.1, 2.33), (28.8, 4.8), (26.8, 4.8)):
            m.box('painted', (e - .06, hb, v0 + .1), (e + .06, h, v0 + .22), color=FRAME, skip=('t', 'b'))
            m.box('painted', (e - .06, hb, v1 - .22), (e + .06, h, v1 - .1), color=FRAME, skip=('t', 'b'))


def add_wing_tops(m):
    """The glazed rooms over the wings (160, 161, 261): closed over the north wing; over the south wing a screen around an open deck, as the photographs have it."""
    tilt = 0.55
    # south wing
    u0, u1, v0, v1 = 25.6, PE - .25, BLOCK_S, PS - .25
    m.poly('painted', [(u0, PODIUM_ROOF + .02, v0), (u1, PODIUM_ROOF + .02, v0), (u1, PODIUM_ROOF + .02, v1), (u0, PODIUM_ROOF + .02, v1)], UP, color=rgb(.68, .64, .56))
    screen(m, [(u1, v0), (u1, v1), (u0, v1)], tilt)
    # north wing
    u0, u1, v0, v1 = 25.6, PE - .25, PN + .25, BLOCK_N
    screen(m, [(u1, v1), (u1, v0), (u0, v0)], tilt)
    top = 11.0
    i = 1.1
    m.poly('gravel', [(u0, top, v0 + i), (u1 - i, top, v0 + i), (u1 - i, top, v1), (u0, top, v1)], UP)
    for w in (WallFrame((u1 - i, v0 + i), (u1 - i, v1)), WallFrame((u0, v0 + i), (u1 - i, v0 + i))):
        m.poly('painted', [w.p(0, F2_TOP), w.p(w.length, F2_TOP), w.p(w.length, top), w.p(0, top)], w.n, color=FRAME)
    for sl, (a, b, c, d) in (('e', ((u1 - .1, 10.75, v0 + .1), (u1 - .1, 10.75, v1), (u1 - i, top, v1), (u1 - i, top, v0 + i))),
                             ('n', ((u0, 10.75, v0 + .1), (u1 - .1, 10.75, v0 + .1), (u1 - i, top, v0 + i), (u0, top, v0 + i)))):
        m.poly('glass', [a, b, c, d], UP, uvs=[(0, 0), (9, 0), (9, 1), (0, 1)])


def screen(m, line, tilt):
    """A glass screen from the podium's roof, its head leaning in, along a line of points given so that the outside is on the left of each step."""
    pts = [np.array(p, float) for p in line]
    for a, b in zip(pts, pts[1:]):
        w = WallFrame(a, b)
        length = w.length
        glass_face(m, w, 0, length, F2_TOP, 10.75, d=0.0)
        for s in np.arange(0, length + .1, 1.9):
            m.wbox('painted', w, s - .03, s + .03, F2_TOP, 10.75, 0.0, .05, color=VENT, top=False)
        m.wbox('painted', w, 0, length, 10.75, 10.82, -0.03, .05, color=VENT)
        m.wbox('painted', w, 0, length, F2_TOP, F2_TOP + .12, 0.0, .05, color=VENT)


def add_block(m, hb):
    """The white block on the terrace (161): frames of three tiers either side of the apse, recessed glass behind them, deep loggias at the foot."""
    east = WallFrame((BLOCK_E, BLOCK_N), (BLOCK_E, BLOCK_S))
    ops = []
    for a, b in EAST_BAYS:
        for t0, t1 in TIERS:
            ops.append(((a + b) / 2 - BLOCK_N, rect(t0, t1, b - a), t0))
    apse_zone = ((APSE[1] - BLOCK_N), rect(0.0, 11.5, 8.9))
    m.wall('stone', east, 0.0, BLOCK_TOP, [(c, o) for c, o, _ in ops] + [apse_zone])
    m.wbox('stone', east, 0, east.length, hb, 0.0, -0.02, 0.0)
    for c, o, t0 in ops:
        deep = BLOCK_E - GE if t0 == 0.0 else 1.5
        m.reveal(east, c, o, deep, side='stone', head='soffit')
    m.reveal(east, apse_zone[0], apse_zone[1], 0.3, side='stone', head='soffit')
    # the sides: the big openings one over the other in front of the open stairs (160, 161)
    for w in (WallFrame((BLOCK_E, BLOCK_S), (PE - .01, BLOCK_S)), WallFrame((PE - .01, BLOCK_N), (BLOCK_E, BLOCK_N))):
        c = w.at((SIDE_BAY[0] + SIDE_BAY[1]) / 2)
        wide = SIDE_BAY[1] - SIDE_BAY[0]
        side_ops = [(c, rect(0.0, 3.0, wide)), (c, rect(4.1, 7.3, wide)), (c, rect(8.4, 11.4, wide))]
        m.wall('stone', w, 0.0, BLOCK_TOP, side_ops)
        for cc, o in side_ops:
            m.reveal(w, cc, o, 1.2, side='stone', fill='painted', color=DARK, head='soffit')
    # over the podium, against the tower
    for w in (WallFrame((PE - .01, BLOCK_S), (TE, BLOCK_S)), WallFrame((TE, BLOCK_N), (PE - .01, BLOCK_N))):
        m.wall('stone', w, F2_TOP, BLOCK_TOP)
    ring = rect_ring(TE, BLOCK_E, BLOCK_N, BLOCK_S)
    roof = BLOCK_TOP - .7  # by the surface model
    m.band('stone', ring, [(0.04, BLOCK_TOP - 0.05), (0.04, BLOCK_TOP), (-0.35, BLOCK_TOP), (-0.35, roof)])
    m.poly('gravel', [(TE + .35, roof, BLOCK_N + .35), (BLOCK_E - .35, roof, BLOCK_N + .35), (BLOCK_E - .35, roof, BLOCK_S - .35), (TE + .35, roof, BLOCK_S - .35)], UP)
    add_apse(m)
    add_vault(m)
    for u, v in ((27.3, 19.0), (28.6, 22.0), (28.6, 28.8), (27.3, 31.8)):
        m.cylinder('painted', u, v, 0.7, roof, roof + 1.2, n=12, color=COOLER)
        m.poly('painted', [(u + .7 * math.cos(a), roof + 1.2, v + .7 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 13)[:-1]], UP, color=VENT)


def arc_points(cu, cv, r, a0, a1, n):
    return [(cu + r * math.cos(a), cv + r * math.sin(a)) for a in np.linspace(a0, a1, n + 1)]


def add_ring(m, mat, cu, cv, r0, r1, a0, a1, h0, h1, n=16):
    """A curved beam or wall, r0 to r1 around (cu, cv), from angle a0 to a1 (0 = east, positive to the south)."""
    inner, outer = arc_points(cu, cv, r0, a0, a1, n), arc_points(cu, cv, r1, a0, a1, n)
    for i in range(n):
        (ia, ib), (oa, ob) = (inner[i], inner[i + 1]), (outer[i], outer[i + 1])
        mid = (a0 + a1) / 2 if n == 0 else a0 + (i + .5) * (a1 - a0) / n
        rad = (math.cos(mid), 0, math.sin(mid))
        m.poly(mat, [(oa[0], h0, oa[1]), (ob[0], h0, ob[1]), (ob[0], h1, ob[1]), (oa[0], h1, oa[1])], rad)
        m.poly(mat, [(ia[0], h0, ia[1]), (ib[0], h0, ib[1]), (ib[0], h1, ib[1]), (ia[0], h1, ia[1])], tuple(-c for c in rad))
        m.poly(mat, [(ia[0], h1, ia[1]), (ib[0], h1, ib[1]), (ob[0], h1, ob[1]), (oa[0], h1, oa[1])], UP)
        m.poly('soffit', [(ia[0], h0, ia[1]), (ib[0], h0, ib[1]), (ob[0], h0, ob[1]), (oa[0], h0, oa[1])], -UP)


def add_apse(m):
    """Five free piers and two curved end piers around the rooms' curved glass, tied by ring beams (plans 100, 200; facade 161)."""
    cu, cv, r = APSE
    half = math.radians(90)
    for h0, h1 in APSE_RINGS:
        add_ring(m, 'stone', cu, cv, r - 1.55, r, -half, half, h0, h1)
    pts = arc_points(cu, cv, r - 1.6, -half, half, 16)
    for a, b in zip(pts, pts[1:]):
        m.poly('glass', [(a[0], 0.0, a[1]), (b[0], 0.0, b[1]), (b[0], 11.5, b[1]), (a[0], 11.5, a[1])], (a[0] + b[0] - 2 * cu, 0, a[1] + b[1] - 2 * cv),
               uvs=[(0, 0), (1.1, 0), (1.1, 3.2), (0, 3.2)])
    for deg in (-60, -30, 0, 30, 60):
        a = math.radians(deg)
        m.cylinder('stone', cu + (r - .25) * math.cos(a), cv + (r - .25) * math.sin(a), 0.25, 0.0, 11.5, n=10)
    for a0, a1 in ((-half, math.radians(-78)), (math.radians(78), half)):
        add_ring(m, 'stone', cu, cv, r - .55, r, a0, a1, 0.0, 11.5, n=3)


def stadium(cw, ce, cv, r, n=14):
    """A long round-ended outline, clockwise from above."""
    west = arc_points(cw, cv, r, math.pi, 1.5 * math.pi, n)
    east = arc_points(ce, cv, r, -0.5 * math.pi, 0.5 * math.pi, 2 * n)
    back = arc_points(cw, cv, r, 0.5 * math.pi, math.pi, n)
    return west + east + back[:-1]


def add_vault(m):
    """The metal vault over the foyer: a ribbed stadium inside a white rim (161, the 2021 flight)."""
    cu, cv, r = APSE
    outline = lambda off: stadium(VAULT_W, cu, cv, r - off)
    rise = 0.75  # its crown over the block's edge, by the surface model; facade 160 draws it 1.2 m
    steps = [(0.0, BLOCK_TOP - .7, 'stone'), (0.0, BLOCK_TOP + 0.1, 'stone'), (0.42, BLOCK_TOP + 0.1, 'stone'), (0.42, BLOCK_TOP - 0.05, 'metal'),
             (1.0, BLOCK_TOP + rise * .45, 'metal'), (2.0, BLOCK_TOP + rise * .8, 'metal'), (3.2, BLOCK_TOP + rise * .96, 'metal'), (r - .12, BLOCK_TOP + rise, 'metal')]
    for (o0, h0, _), (o1, h1, mat) in zip(steps, steps[1:]):
        a, b = outline(o0), outline(o1)
        k = 0.0
        for i in range(len(a)):
            j = (i + 1) % len(a)
            seg = float(np.hypot(a[j][0] - a[i][0], a[j][1] - a[i][1]))
            pts = [(a[i][0], h0, a[i][1]), (a[j][0], h0, a[j][1]), (b[j][0], h1, b[j][1]), (b[i][0], h1, b[i][1])]
            mx, mz = (a[i][0] + a[j][0]) / 2, (a[i][1] + a[j][1]) / 2
            # out of the outline: along the normal of this step of the ring, turned up where the ring draws in
            dx, dz = a[j][0] - a[i][0], a[j][1] - a[i][1]
            ln = math.hypot(dx, dz) or 1.0
            n2 = (dz / ln, -dx / ln)
            hint = (n2[0] * (h1 - h0), o1 - o0, n2[1] * (h1 - h0))
            m.poly(mat, pts, hint, uvs=[(k, h0), (k + seg, h0), (k + seg, h1 + o1), (k, h1 + o1)])
            k += seg
    h = BLOCK_TOP + rise
    m.poly('metal', [(VAULT_W, h, cv - .12), (cu, h, cv - .12), (cu, h, cv + .12), (VAULT_W, h, cv + .12)], UP)
    # the skylight along its crown
    su0, su1 = VAULT_W - 1.0, cu + 0.4
    y0, y1 = h - .1, h + .28
    for v0, v1, sgn in ((cv - .95, cv + .95, 1),):
        for w in rect_faces(su0, su1, v0, v1):
            m.poly('painted', [w.p(0, y0), w.p(w.length, y0), w.p(w.length, y1), w.p(0, y1)], w.n, color=VENT)
        m.poly('glass', [(su0, y1, v0), (su1, y1, v0), (su1, y1, v1), (su0, y1, v1)], UP, uvs=[(su0, 0), (su1, 0), (su1, 1.8), (su0, 1.8)])


# ----------------------------------------------------------------------------------------------------------------------------------------------- the terrace
def add_terrace(m, deck, levels=None):
    """The granite terrace, its hedge on the bank, its walls, pool and stairs (LA.02-LA.06). `deck`: its height (h)."""
    n_top, s_top = STAIRS[0][0], STAIRS[1][0]
    pieces = [(BLOCK_E, TERR_E, n_top, s_top), (BLOCK_E, WELL_U, TERR_N, n_top), (BLOCK_E, WELL_U, s_top, TERR_S), (WALL_W + WALL_T, BLOCK_E, TERR_N, BLOCK_N), (WALL_W + WALL_T, BLOCK_E, BLOCK_S, TERR_S)]
    for u0, u1, v0, v1 in pieces:
        m.poly('paving', [(u0, deck, v0), (u1, deck, v0), (u1, deck, v1), (u0, deck, v1)], UP)
    # the belægningsskifte: the darker disc in the apse's mouth
    cu, cv = 43.6, APSE[1]
    pts = arc_points(cu, cv, 3.1, -math.pi / 2, math.pi / 2, 14)
    m.poly('painted', [(a, deck + .01, b) for a, b in pts], UP, color=DISC)
    # the mirror pool and the stone plinth
    u0, u1, v0, v1, level = POOL
    m.box('paving', (u0 - .12, deck, v0 - .12), (u1 + .12, deck + .05, v1 + .12), skip=('b', 't'))
    m.poly('paving', [(u0 - .12, deck + .05, v0 - .12), (u1 + .12, deck + .05, v0 - .12), (u1 + .12, deck + .05, v0), (u0 - .12, deck + .05, v0)], UP)
    m.poly('paving', [(u0 - .12, deck + .05, v1), (u1 + .12, deck + .05, v1), (u1 + .12, deck + .05, v1 + .12), (u0 - .12, deck + .05, v1 + .12)], UP)
    m.poly('paving', [(u0 - .12, deck + .05, v0), (u0, deck + .05, v0), (u0, deck + .05, v1), (u0 - .12, deck + .05, v1)], UP)
    m.poly('paving', [(u1, deck + .05, v0), (u1 + .12, deck + .05, v0), (u1 + .12, deck + .05, v1), (u1, deck + .05, v1)], UP)
    m.poly('painted', [(u0, deck + .03, v0), (u1, deck + .03, v0), (u1, deck + .03, v1), (u0, deck + .03, v1)], UP, color=WATER)
    u0, u1, v0, v1 = PLINTH
    m.box('paving', (u0, deck, v0), (u1, deck + .45, v1), skip=('b',))
    add_hedge(m, deck)
    add_terrace_stairs(m, deck, levels)


def add_hedge(m, deck):
    v0, v1, u0, u1 = HEDGE
    tu = u0 + 0.55  # its clipped top, a walk's width from the terrace
    # the terrace's own wall, the hedge's top and the slope down to the wall on the park's boundary (LA.04, sections A-A and B-B)
    m.box('stone', (u0, deck, v0), (u0 + .25, HEDGE_TOP - .25, v1), skip=('b',))
    m.poly('hedge', [(u0 + .25, HEDGE_TOP, v0), (u1, HEDGE_FOOT, v0), (u1, HEDGE_FOOT, v1), (u0 + .25, HEDGE_TOP, v1)], UP,
           uvs=[(v0, 0), (v0, 6.5), (v1, 6.5), (v1, 0)])
    m.poly('hedge', [(u0 + .25, HEDGE_TOP - .3, v0), (u0 + .25, HEDGE_TOP, v0), (u0 + .25, HEDGE_TOP, v1), (u0 + .25, HEDGE_TOP - .3, v1)], (-1, 0, 0),
           uvs=[(v0, 0), (v0, .3), (v1, .3), (v1, 0)])
    # its ends: the bank in section, and the wall at its foot
    for v, sgn in ((v0, -1), (v1, 1)):
        m.poly('stone', [(u0, HEDGE_TOP, v), (u1, HEDGE_FOOT, v), (u1, WALL_FOOT - 1.0, v), (u0, WALL_FOOT - 1.0, v)], (0, 0, sgn))
    m.box('stone', (u1, PARK - .3, v0), (u1 + .2, HEDGE_FOOT + 0.05, v1), skip=('b',))


def sloped_wall(m, u0, u1, v0, v1, y0, top0, top1):
    """A wall along u whose top falls from top0 at u0 to top1 at u1: beside a flight, so that it stays a parapet all the way down."""
    for v, sgn in ((v0, -1), (v1, 1)):
        m.poly('stone', [(u0, y0, v), (u1, y0, v), (u1, top1, v), (u0, top0, v)], (0, 0, sgn))
    m.poly('stone', [(u0, top0, v0), (u1, top1, v0), (u1, top1, v1), (u0, top0, v1)], UP)
    m.poly('stone', [(u1, y0, v0), (u1, y0, v1), (u1, top1, v1), (u1, top1, v0)], (1, 0, 0))


def add_terrace_stairs(m, deck, levels=None):
    """Down to the park at both ends of the terrace, in granite with white cheeks (LA.05): a flight in a well in the terrace's edge to a landing at kote 7.00, then a flight
    out towards the park. The landing and the foot are where stair_levels puts them on the twin's ground."""
    levels = levels or LEVELS
    for sgn, (v_top, v_land, v_out, lower), (landing, foot) in zip((1, -1), STAIRS, levels):
        u0, u1 = WELL_U, TERR_E
        n = STEPS
        run = abs(v_top - v_land) / n
        for k in range(n):
            v_a = v_top - sgn * k * run
            v_b = v_top - sgn * (k + 1) * run
            y = deck + (landing - deck) * (k + 1) / n
            m.poly('paving', [(u0, y, min(v_a, v_b)), (u1, y, min(v_a, v_b)), (u1, y, max(v_a, v_b)), (u0, y, max(v_a, v_b))], UP)
            ya = deck + (landing - deck) * k / n
            m.poly('paving', [(u0, ya, v_a), (u1, ya, v_a), (u1, y, v_a), (u0, y, v_a)], (0, 0, -sgn))
        a, b = sorted((v_land, v_out))
        m.poly('paving', [(u0, landing, a), (TERR_E, landing, a), (TERR_E, landing, b), (u0, landing, b)], UP)
        # the lower flight, out towards the park
        n2 = 15
        c, d = lower
        for k in range(n2):
            e0, e1 = TERR_E + k * STAIR_RUN / n2, TERR_E + (k + 1) * STAIR_RUN / n2
            ya = landing + (foot - landing) * k / n2
            yb = landing + (foot - landing) * (k + 1) / n2
            m.poly('paving', [(e0, yb, c), (e1, yb, c), (e1, yb, d), (e0, yb, d)], UP)
            m.poly('paving', [(e0, ya, c), (e0, ya, d), (e0, yb, d), (e0, yb, c)], (1, 0, 0))
        # the wall on the terrace's end, as far as the flight, and from there the cheek that falls with it
        w0, w1 = sorted((v_out, v_out - sgn * WALL_T))
        m.box('stone', (WALL_W, PARK - .3, w0), (TERR_E, deck + 1.0, w1), skip=('b',))
        sloped_wall(m, TERR_E, TERR_E + STAIR_RUN, w0, w1, PARK - .3, landing + PARAPET, foot + PARAPET)
        # and across, from that wall to the podium, so that nobody sees under the paving (the ground beside it lies up to 3 m lower)
        c0, c1 = sorted((v_out, GN if sgn > 0 else GS))
        m.box('stone', (WALL_W, PARK - .3, c0), (WALL_W + WALL_T, deck, c1), skip=('b', 't'))
        # the well's parapet against the terrace
        p0, p1 = sorted((v_top, v_out))
        m.box('stone', (WELL_U - WALL_T, landing - .05, p0), (WELL_U, deck + PARAPET, p1), skip=('b',))
    # the wells' far sides: the hedge's wall over the south flight, and over the north flight, which stands above the flight below it, a parapet
    (v_top, v_land, _, _), (landing, _) = STAIRS[1], levels[1]
    m.poly('stone', [(TERR_E, landing - .05, v_top), (TERR_E, landing - .05, v_land), (TERR_E, deck, v_land), (TERR_E, deck, v_top)], (-1, 0, 0))
    (v_top, v_land, _, _), (landing, _) = STAIRS[0], levels[0]
    m.box('stone', (TERR_E, levels[0][1], v_land), (TERR_E + WALL_T, deck + PARAPET, v_top), skip=('b',))


def build(hb=-1.0, deck=0.02, levels=None):
    """The hotel's model in its own frame. hb: how far its walls go down. deck: the height of the terrace's paving. levels: the stairs' (stair_levels)."""
    m = Model()
    add_tower(m)
    add_lift(m, hb)
    add_podium(m, hb)
    add_wing_tops(m)
    add_block(m, hb)
    add_terrace(m, deck, levels)
    return m


# ------------------------------------------------------------------------------------------------------------------------------------------------- textures
TONES = {'concrete': (0.83, 0.84, 0.84), 'stone': (0.88, 0.88, 0.86), 'wall': (0.86, 0.86, 0.84), 'clad': (0.27, 0.29, 0.34), 'paving': (0.60, 0.58, 0.54), 'metal': (0.80, 0.81, 0.82),
         'roof': (0.33, 0.34, 0.39), 'gravel': (0.46, 0.42, 0.37)}
ROW_H = STOREY - SLAB  # one row of the rooms' texture: a balcony's height


def tiled(tone, seed, grain=0.03, wash=0.06, stretch=(1.0, 1.0), n=512):
    lum = 1 + wash * periodic_noise(n, 1.7, seed, stretch=stretch, low=1) + grain * periodic_noise(n, 0.5, seed + 1, low=16)
    return lum[..., None] * np.array(albedo(tone))


def concrete_texture(n=512):
    """Painted concrete slabs: pale, a joint every 3 m of the 6 m repeat, run-off streaking down from the top."""
    img = tiled(TONES['concrete'], 21, grain=0.025, wash=0.05, stretch=(1.0, 0.15), n=n)
    x = (np.arange(n) + .5) / n * 2 % 1
    joint = np.minimum(x, 1 - x) < 0.006
    img[:, joint] *= 0.8
    return to_image(np.clip(img, 0, 1))


def rooms_texture(w=1024, h=512):
    """A balcony's back wall, 8.7 m wide and four rows high: from sheets 7 and 9 the dark head under the slab over it and the column at each bay, from the photographs the
    white panels under the windows. Rows differ in curtains and blinds; a row's first pixels lie at the floor, so that it reads upward."""
    rs = np.random.default_rng(23)
    img = np.zeros((h, w, 3))
    px = w / BAY_REPEAT
    white = np.array(albedo((0.86, 0.86, 0.84)))
    head = np.array((0.035, 0.038, 0.045))
    frame = np.array(albedo((0.74, 0.74, 0.72)))
    rows = 4
    rh = h // rows
    # bays from the start of the repeat: a 5.1 m room and a 3.6 m room
    for r in range(rows):
        ry = r * rh
        y = lambda metres: int(round(metres / ROW_H * rh))
        img[ry:ry + rh] = white
        img[ry + y(ROW_H - 0.6):ry + rh] = head
        for bay0, bay1 in ((0.0, 5.1), (5.1, 8.7)):
            door0, door1 = bay0 + 0.25, bay0 + 1.15
            win0, win1 = bay0 + 1.25, bay1 - 0.25
            # door: full height of the opening; window: over the panel
            for a, b, sill in ((door0, door1, 0.03), (win0, win1, 0.62)):
                xa, xb = int(a * px), int(b * px)
                ya, yb = ry + y(sill), ry + y(ROW_H - 0.62)
                img[ya:yb, xa:xb] = frame
                pane = np.array((0.035, 0.05, 0.075)) * (0.9 + .5 * rs.random())
                img[ya + 2:yb - 2, xa + 2:xb - 2] = pane
                cover = rs.choice([0.0, 0.0, 0.35, 0.7, 1.0])  # a blind let down, or curtains drawn from the side
                if cover:
                    c = np.array(albedo((0.70, 0.68, 0.62))) * (0.75 + .3 * rs.random())
                    yc = yb - 2 - int((yb - ya - 4) * cover * (0.4 + .3 * rs.random()))
                    img[yc:yb - 2, xa + 2:xb - 2] = c
                if b - a > 1.5:
                    xm = (xa + xb) // 2
                    img[ya:yb, xm - 1:xm + 1] = frame
    img = img * (1 + 0.03 * rs.normal(0, 1, (h, 1, 1)))
    return to_image(np.clip(img, 0, 1))


def glass_texture(n=256):
    """Dark glass in slim frames, panes 2 m wide; the frame's head and sill run along the band's edges."""
    img = np.zeros((n, n, 3))
    y, x = np.mgrid[0:n, 0:n] + .5
    fy = y / n
    img[...] = np.array((0.03, 0.045, 0.065))[None, None] * (1 + 1.0 * fy)[..., None]
    img *= (1 + .18 * periodic_noise(n, 1.3, 25, low=1))[..., None]
    frame = np.array((0.09, 0.095, 0.105))
    fx = (x / n * 2) % 1
    img[np.minimum(fx, 1 - fx) < 0.018] = frame
    img[(fy < 0.02) | (fy > 0.98)] = frame
    return to_image(np.clip(img, 0, 1))


def clad_texture(n=512):
    """The dark panels on the podium's fascias: 1.2 m wide, in the 4.8 m repeat."""
    img = tiled(TONES['clad'], 27, grain=0.02, wash=0.07, n=n)
    x = (np.arange(n) + .5) / n * 4 % 1
    img[:, np.minimum(x, 1 - x) < 0.008] *= 0.7
    return to_image(np.clip(img, 0, 1))


def stone_texture(n=512):
    """The white cladding of the east block, in the courses that LA.04 draws: 1.6 m by 0.8 m, in a repeat of 6.4 m."""
    rs = np.random.default_rng(29)
    img = tiled(TONES['stone'], 29, grain=0.02, wash=0.035, n=n)
    y, x = np.mgrid[0:n, 0:n] + .5
    rows = 8
    cols = 4
    cj = np.floor(y / n * rows).astype(int)
    cx = x / n * cols + .5 * (cj % 2)
    ci = np.floor(cx).astype(int) % cols
    img *= (1 + .018 * rs.normal(0, 1, (rows, cols)))[cj, ci][..., None]
    joint = (np.minimum(y / n * rows % 1, 1 - y / n * rows % 1) < 0.012) | (np.minimum(cx % 1, 1 - cx % 1) < 0.006)
    img[joint] *= 0.82
    return to_image(np.clip(img, 0, 1))


def paving_texture(n=512):
    """Flame-cut granite, 80 by 160 cm in quarter bond (LA.05), a repeat of 6.4 m."""
    rs = np.random.default_rng(31)
    img = tiled(TONES['paving'], 31, grain=0.05, wash=0.05, n=n)
    y, x = np.mgrid[0:n, 0:n] + .5
    rows = 8
    cols = 4
    cj = np.floor(y / n * rows).astype(int)
    cx = x / n * cols + .25 * (cj % 4)
    ci = np.floor(cx).astype(int) % cols
    img *= (1 + .05 * rs.normal(0, 1, (rows, cols)))[cj, ci][..., None]
    joint = (np.minimum(y / n * rows % 1, 1 - y / n * rows % 1) < 0.015) | (np.minimum(cx % 1, 1 - cx % 1) < 0.008)
    img[joint] *= 0.68
    return to_image(np.clip(img, 0, 1))


def hedge_texture(n=512):
    """Clipped beech: a dark mass under its clumps, lit leaf by leaf, olive and copper mixed as beech is through the year. A 3 m repeat."""
    clumps = periodic_noise(n, 1.1, 34, low=4)
    leaves = periodic_noise(n, 0.2, 33, low=40)
    light = np.clip(0.42 + 0.9 * clumps + 0.75 * leaves, 0.06, 1.5)
    copper = np.clip(0.45 + 1.4 * periodic_noise(n, 0.9, 35, low=6), 0, 1)[..., None]
    olive, brown = np.array(albedo((0.40, 0.46, 0.17))), np.array(albedo((0.55, 0.36, 0.16)))
    img = (olive * (1 - copper) + brown * copper) * light[..., None]
    return to_image(np.clip(img, 0, 1))


def metal_texture(n=256):
    """The vault's and canopy's ribbed metal: a standing rib every 0.5 m of the 2 m repeat."""
    img = tiled(TONES['metal'], 37, grain=0.015, wash=0.04, n=n)
    x = (np.arange(n) + .5) / n * 4 % 1
    prof = 0.86 + 0.2 * np.exp(-((np.minimum(x, 1 - x)) / 0.07) ** 2) - 0.2 * np.exp(-((np.minimum(x, 1 - x) - 0.11) / 0.05) ** 2)
    img *= prof[None, :, None]
    return to_image(np.clip(img, 0, 1))


def roof_texture(n=256):
    return to_image(np.clip(tiled(TONES['roof'], 39, grain=0.05, wash=0.08, n=n), 0, 1))


def lift_texture(n=256):
    """The lift tower's dark glass, its steel at each 1.2 m and 2.82 m."""
    img = np.zeros((n, n, 3))
    y, x = np.mgrid[0:n, 0:n] + .5
    img[...] = np.array((0.022, 0.028, 0.038))[None, None] * (1 + 1.2 * (y / n))[..., None]
    fx, fy = x / n, y / n
    frame = np.array((0.055, 0.058, 0.066))
    img[np.minimum(fx, 1 - fx) < 0.035] = frame
    img[np.minimum(fy, 1 - fy) < 0.018] = frame
    return to_image(np.clip(img, 0, 1))


TEXTURES = {'concrete': concrete_texture, 'rooms': rooms_texture, 'glass': glass_texture, 'clad': clad_texture, 'stone': stone_texture, 'paving': paving_texture, 'hedge': hedge_texture,
            'metal': metal_texture, 'roof': roof_texture, 'lift': lift_texture}
MATERIALS = {
    'concrete': dict(tile=(6.0, 6.0), roughness=0.9),
    # undersides: the sky light the twin gives them comes back warm off the ground, which a pale surface shows as peach
    'soffit': dict(tile=(6.0, 6.0), texture='concrete', color=(0.78, 0.84, 0.95, 1.0), roughness=0.9),
    'rooms': dict(tile=(BAY_REPEAT, 4 * ROW_H), roughness=0.5),
    'glass': dict(tile=(4.0, 3.2), roughness=0.15, metallic=0.5),
    'lift': dict(tile=(1.2, STOREY), roughness=0.15, metallic=0.5),
    'clad': dict(tile=(4.8, 4.8), roughness=0.55, metallic=0.2),
    'stone': dict(tile=(6.4, 6.4), roughness=0.8),
    'wall': dict(tile=(6.4, 6.4), texture='stone', roughness=0.8),
    'paving': dict(tile=(6.4, 6.4), roughness=0.85),
    'hedge': dict(tile=(3.0, 3.0), roughness=1.0),
    'metal': dict(tile=(2.0, 2.0), roughness=0.4, metallic=0.5),
    'roof': dict(tile=(8.0, 8.0), roughness=0.95),
    'gravel': dict(tile=(8.0, 8.0), texture='roof', color=(1.32, 1.15, 0.94, 1.0), roughness=0.95),
    'painted': dict(tile=None, roughness=0.6),
}
ATTRIBUTION = {
    'hvide-hus-tegning-1967': {'text': 'Hotel ved Kilden, Aalborg: facades 8-13, K. Friis og E. Moltke Nielsen, arkitekter, 1967', 'licence': 'Aalborg Kommune building archive (byggesagsarkiv), weblager.dk', 'url': 'https://weblager.dk'},
    'hvide-hus-tegning-2005': {'text': 'Hotel Hvide Hus: udskiftning af facadepartier, plan and facades, Jørgen Braad A/S, 2005', 'licence': 'Aalborg Kommune building archive (byggesagsarkiv), weblager.dk', 'url': 'https://weblager.dk'},
    'hvide-hus-terrasse-2002': {'text': 'Hotel Hvide Hus: opholdsterrasse mod Kildeparken, LA.02-LA.06, Peter Sørensen, landskabsarkitekt, 2002', 'licence': 'Aalborg Kommune building archive (byggesagsarkiv), weblager.dk', 'url': 'https://weblager.dk'},
    'skraafoto-2021': {'text': 'Skråfoto 2021, Klimadatastyrelsen (colours only)', 'licence': 'CC BY 4.0 terms for free geographic data', 'url': 'https://dataforsyningen.dk'},
    'geodanmark': {'text': 'GeoDanmark Bygning (placement)', 'licence': 'CC BY 4.0', 'url': 'https://www.geodanmark.dk'},
}


def terrace_deck(frame):
    """The height (h) to lay the paving at: kote 8.83, or just over the twin's terrain where its terrain stands higher (its 1 m grid is smoothed)."""
    a = math.radians(AXIS_DEG)
    ca, sa = math.cos(a), math.sin(a)
    high = -99.0
    for u in np.arange(BLOCK_E + .5, TERR_E, 1.0):
        for v in np.arange(TERR_N + .5, TERR_S, 1.0):
            x, z = ORIGIN[0] + u * ca - v * sa, ORIGIN[1] + u * sa + v * ca
            high = max(high, frame.height_at(x, z) - GRADE_Y)
    return high


# ------------------------------------------------------------------------------------------------------------------------------------------------- walking
def terrace_ring():
    """The terrace's walkable outline (u, v): the paving, less the block and the stair wells."""
    (n_top, *_), (s_top, *_) = STAIRS
    return [(WALL_W + WALL_T, TERR_N), (WELL_U, TERR_N), (WELL_U, n_top), (TERR_E, n_top), (TERR_E, s_top), (WELL_U, s_top), (WELL_U, TERR_S), (WALL_W + WALL_T, TERR_S),
            (WALL_W + WALL_T, BLOCK_S), (BLOCK_E, BLOCK_S), (BLOCK_E, BLOCK_N), (WALL_W + WALL_T, BLOCK_N)]


def walk_surfaces(deck=0.02, levels=None):
    """What people walk on: (name, ring (u, v), axis [(u, v, h), ...]). A point's height is that of the nearest point of the axis, as on a bridge deck (js/deck-field.js)."""
    levels = levels or LEVELS
    mid = (WALL_W + TERR_E) / 2
    out = [('terrace', terrace_ring(), [(mid, TERR_N, deck), (mid, TERR_S, deck)])]
    uc = (WELL_U + TERR_E) / 2
    for name, (v_top, v_land, v_out, lower), (landing, foot) in zip(('north', 'south'), STAIRS, levels):
        a, b = sorted((v_top, v_out))
        out.append((f'{name}-well', [(WELL_U, a), (TERR_E, a), (TERR_E, b), (WELL_U, b)], [(uc, v_top, deck), (uc, v_land, landing), (uc, v_out, landing)]))
        c, d = lower
        out.append((f'{name}-flight', [(TERR_E, c), (TERR_E + STAIR_RUN, c), (TERR_E + STAIR_RUN, d), (TERR_E, d)], [(TERR_E, (c + d) / 2, landing), (TERR_E + STAIR_RUN, (c + d) / 2, foot)]))
    return out


def walk_solids(deck=0.02):
    """What stops them: (u0, u1, v0, v1, top h). The bank with its hedge, the terrace's walls from the ground up, the parapets of the wells, the seat."""
    v_n, v_s = STAIRS[0], STAIRS[1]
    return [
        (TERR_E, HEDGE[3] + .2, HEDGE[0], HEDGE[1], HEDGE_TOP),
        (WALL_W, TERR_E + STAIR_RUN, TERR_N - WALL_T, TERR_N, deck + 1.0),
        (WALL_W, TERR_E + STAIR_RUN, TERR_S, TERR_S + WALL_T, deck + 1.0),
        (WALL_W, WALL_W + WALL_T, TERR_N, GN, deck),
        (WALL_W, WALL_W + WALL_T, GS, TERR_S, deck),
        (WELL_U - WALL_T, WELL_U, TERR_N, v_n[0], deck + PARAPET),
        (WELL_U - WALL_T, WELL_U, v_s[0], TERR_S, deck + PARAPET),
        (TERR_E, TERR_E + WALL_T, v_n[1], v_n[0], deck + PARAPET),
        (PLINTH[0], PLINTH[1], PLINTH[2], PLINTH[3], deck + .45),
    ]


def twin_xz(u, v):
    a = math.radians(AXIS_DEG)
    return ORIGIN[0] + u * math.cos(a) - v * math.sin(a), ORIGIN[1] + u * math.sin(a) + v * math.cos(a)


def stair_levels(frame):
    """Per stair (landing h, foot h): kote 7.00 and the twin's ground at the foot, as the twin's smoothed terrain stands up to 0.7 m above kote 4.70 there; the landing stands
    just over its terrain, as the paving does."""
    terrain = lambda u, v: frame.height_at(*twin_xz(u, v)) - GRADE_Y
    out = []
    for v_top, v_land, v_out, (c, d) in STAIRS:
        a, b = sorted((v_land, v_out))
        high = max(terrain(u, v) for u in np.arange(WELL_U, TERR_E + .1, .5) for v in np.arange(a, b + .1, .5))
        foot = max(terrain(TERR_E + STAIR_RUN, v) for v in np.arange(c, d + .1, .5))
        out.append((max(LANDING, high + .03), max(PARK, foot + .03)))
    return tuple(out)


def walk_layer(frame, deck, levels):
    """The override entry's `walk`, in the twin's frame (docs/detail-overrides.md)."""
    decks = []
    for name, ring, axis in walk_surfaces(deck, levels):
        pts = []
        for u, v, h in axis:
            x, z = twin_xz(u, v)
            pts += [round(float(x), 3), round(float(z), 3), round(float(GRADE_Y + h), 3), round(float(frame.height_at(x, z)), 3)]
        decks.append({'id': f'{GDK_ID}:{name}', 'ring': [round(float(c), 3) for u, v in ring for c in twin_xz(u, v)], 'axes': [{'pts': pts}], 'solid': True})
    solids = []
    for u0, u1, v0, v1, top in walk_solids(deck):
        corners = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
        solids.append({'ring': [round(float(c), 3) for u, v in corners for c in twin_xz(u, v)], 'top': round(float(GRADE_Y + top), 3)})
    return {'decks': decks, 'solids': solids}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', default=str(ROOT / 'data'))
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    a = ap.parse_args()
    data, out = Path(a.data), Path(a.out)
    frame = TwinFrame(data)
    rec = frame.buildings(TILE)[GDK_ID]
    low = frame.ground_low(rec)
    hb = low - 0.25 - GRADE_Y
    high = terrace_deck(frame)
    deck = max(0.02, high + 0.03)
    print(f'ground low {low:.2f}, terrain at most {high:+.2f} against kote 8.83 under the terrace, paving at {deck:+.2f}')
    levels = stair_levels(frame)
    print('stairs (landing, foot):', [tuple(round(float(y), 2) for y in s) for s in levels])
    model = build(hb, deck, levels)
    body, mesh, lo, hi = model_to_glb(model, AXIS_DEG, (ORIGIN[0], GRADE_Y, ORIGIN[1]), MATERIALS, TEXTURES, SET,
                                      root_extras={'building_id': GDK_ID, 'source_ids': list(ATTRIBUTION)[:3], 'attribution': list(ATTRIBUTION), 'confidence': 'observed'},
                                      asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                                      attribution=list(ATTRIBUTION), generator='tools/overrides/hvide_hus.py')
    rel = 'meshes/gdk_1019237254.glb'
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    (out / rel).write_bytes(body)
    entry = {
        'tile': TILE, 'mode': 'replace', 'covers': [GDK_ID], 'footprint': {'use': 'gdk'}, 'walk': walk_layer(frame, deck, levels),
        'match': {'kind': '1:1', 'iou': 0.93, 'hausdorff': 1.0},
        'source': {'ids': list(ATTRIBUTION)[:3], 'kind': 'architect-drawing', 'reconstruction': 'tools/overrides/hvide_hus.py'},
        'confidence': 'observed', 'attribution': list(ATTRIBUTION),
        'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': rec['ground'], 'low': round(low, 2), 'sunk': 0.25,
        'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
    }
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': {GDK_ID: entry}})
    print(f'{out}: {mesh["triangles"]} triangles, {len(body) / 1e6:.2f} MB GLB, {mesh["textureBytes"] / 1e6:.1f} MB textures, top {hi[1]:.2f}')


if __name__ == '__main__':
    main()
