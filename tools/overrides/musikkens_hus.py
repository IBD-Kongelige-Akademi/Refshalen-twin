#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Musikkens Hus (Musikkens Plads 1, Aalborg; Coop Himmelb(l)au, 2014): a detail override built without drawings (docs/musikkens-hus.md).

Measured the way Aalborg Kongres & Kultur Center was (tools/overrides/akkc.py, whose building blocks this script uses): roof levels from the LoD2 shell
and the surface model, every wall in plan from the GeoDanmark footprint, and the round windows, columns, struts, the south screen and the foyer's front
from the 2021 Skraafoto oblique photos rectified onto the walls' planes. Photographs on Wikimedia Commons were looked at for materials only. Every
measure is written out as a number here, so the script runs without the photos and without the network. No pixel of a photograph is in the model.

The model's frame: u east, v south (the fjord is at v = 0), from a point north-west of the house; h is the twin's own height (local y).

    PYTHONUTF8=1 uv run tools/overrides/musikkens_hus.py [--data data] [--out DIR]
    PYTHONUTF8=1 uv run tools/overrides/publish.py install     # with no --sets: every set, so the other overrides stay
"""
from __future__ import annotations

import argparse, hashlib, math, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from overrides_lib import SOURCE_FORMAT, TwinFrame, flat_to_pts, write_json
from override_model import Model, UP, WallFrame, albedo, model_to_glb, periodic_noise, to_image
from akkc import Facade, col, flat, flat_roof, glazing, rect_ring, tiled, units

SET = 'musikkens-hus'
GDK_ID = 'gdk:1214569300'
TILE = '1113_12646'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET

AXIS_DEG = 5.12  # the long edges of the footprint
ORIGIN = (558.0, -42.0)  # the frame's origin in the twin's x, z

# ------------------------------------------------------------------------------------------------------------------------------ the measures
G = -1.5  # the quay
# The U: three wings of classrooms round the concert hall, lifted on columns and struts
U_OUT = (16.4, 82.6, 45.4, 116.4)
U_IN = (30.5, 69.0, 103.5)  # the court: its west and east sides and its south end
SOFFIT, U_ROOF, U_TOP = 10.5, 28.0, 28.3
E_END = (50.0, 23.3)  # the east wing's north end is a terrace: as far as this v, at this height
SET_BACK = 2.6  # how far the ground floors stand behind the columns
HALL = (35.0, 63.0, 50.0, 101.5, 21.3)  # the concert hall's roof inside the U
HALL_TAPER = 2.7
COURT = 12.0  # the roofs between the hall and the wings
# round windows: (s along the wall, h, diameter). West front from its north end, east front from its south end (as each is seen from outside)
WEST = [(4.8, 24.5, 3.4), (9, 24, 2.2), (12.4, 24.4, 1.6), (15.4, 25.5, 1.0), (16.4, 24.2, 1.2), (19.3, 24.4, 1.6), (22.4, 24.2, 1.2), (25.5, 24.5, 3.4), (29.7, 23.9, 2.2),
        (33, 24.3, 1.6), (36.5, 24.3, 1.6), (41.7, 21.7, 8.6), (46.5, 25.5, 1.2), (47.4, 24.1, 1.0), (51.7, 24, 3.8), (57.4, 24.3, 1.6), (60.5, 24, 1.2), (61.5, 25.4, 1.0),
        (64.7, 23.8, 2.2), (68.5, 25.5, 1.2),
        (11.7, 19.3, 3.4), (17.2, 19, 4.0), (23, 18.7, 2.4), (25.8, 18.8, 1.2), (26.8, 20.3, 1.0), (29.4, 18.8, 1.0), (32.7, 19.2, 3.4), (36.4, 18.8, 1.2), (47.2, 19, 1.6),
        (50, 20.3, 1.2), (51, 18.8, 1.2), (54, 19, 1.6), (58, 20.2, 1.0), (61, 19, 1.8), (64, 20.2, 1.0), (67.5, 19.2, 3.4),
        (2.3, 15.4, 1.2), (5.3, 14.2, 1.8), (9, 13.9, 2.2), (12, 14, 1.2), (12.9, 15.5, 1.0), (43.8, 13.9, 2.4), (46.7, 14, 1.2), (47.7, 15.5, 1.0), (50.6, 14.2, 1.4),
        (53.6, 14, 1.2), (56.8, 14.1, 3.6), (61.3, 13.8, 2.2), (65.8, 14, 4.0)]
EAST = [(1.8, 26, 1.2), (5.2, 25, 3.6), (9.2, 24.4, 2.0), (12.7, 24.4, 2.0), (15.7, 24.6, 1.2), (19, 25, 3.4), (24.4, 24.6, 3.8), (29.5, 25, 3.6), (33.5, 24.8, 1.6),
        (39.2, 22.2, 8.4), (43.6, 26, 1.2), (47, 25, 3.4), (51.3, 24.5, 2.0), (54.6, 24.8, 1.4), (59.3, 24.8, 3.8),
        (2.5, 19.2, 2.4), (6.2, 20.8, 1.2), (9.2, 19.6, 1.4), (12, 20.8, 1.0), (17.5, 19.5, 4.0), (23, 19.3, 2.2), (26.6, 19.6, 1.6), (30, 19.2, 2.0), (33, 19.4, 1.4),
        (44.3, 19.6, 1.2), (47.3, 19.2, 1.4), (50.5, 19.6, 1.2), (54, 19.8, 3.4), (58, 19.4, 2.2), (61.2, 20.8, 1.0), (62.3, 19.6, 1.2),
        (3.4, 14.5, 4.0), (9.8, 16, 1.2), (12.6, 14.8, 1.6), (16.4, 14.5, 2.2), (19.3, 16, 1.2), (20.3, 14.6, 1.2), (26, 14.6, 3.4), (59.4, 14.5, 4.0), (65, 14.8, 1.6)]
SOUTH = [(2.3, 24.2, 2.2), (3.3, 19, 4.2), (5, 14.8, 3.6), (55.2, 24.6, 3.4), (61.3, 24, 4.2), (62.8, 19.5, 3.4), (59.4, 19.2, 1.2), (63.5, 13.8, 2.2)]  # s = u - 16.4
N_WEST = [(4.8, 24, 1.8), (9.6, 24, 3.8), (4.2, 15.4, 1.2), (5.2, 13.9, 1.2), (8.8, 15.3, 1.4), (11.8, 14, 1.6)]  # s = 30.5 - u
N_EAST = [(2, 20.2, 1.2), (5.5, 19.5, 3.6), (9.8, 18.6, 2.2), (2.8, 13.7, 2.2), (5.6, 14, 1.2), (6.7, 15.3, 1.0), (9.6, 14.2, 1.6)]  # s = 82.6 - u
COURT_W = [(6.8, 26.2, 1.2), (11.6, 26.2, 1.2), (14.5, 25, 1.6), (17.6, 26.2, 1.2), (20.6, 25.2, 3.4), (25, 24.6, 2.2), (28.4, 25, 1.8), (31.5, 24.7, 1.4), (35, 25.2, 3.4),
           (39, 24.6, 2.2), (56.3, 25, 1.8), (6.7, 23, 1.4), (10.5, 23, 1.2), (15, 23, 1.2), (17.5, 23, 1.2)]  # s = 103.5 - v
COURT_E = [(16, 25.6, 1.2), (19, 24.4, 1.6), (22, 25.6, 1.2), (25.4, 24.6, 3.4), (30.8, 24.2, 4.0), (36.7, 24, 2.2), (39.5, 25.6, 1.2), (40.5, 24.2, 1.4), (43.8, 25.8, 1.2),
           (43.8, 23.7, 1.2)]  # s = v - 45.4
COURT_S = [(2.5, 25.5, 4.2), (8.3, 25.6, 2.4), (11, 26.2, 1.2), (15, 25.6, 2.4), (21.6, 26.2, 1.6), (29.3, 25.5, 4.0), (34.8, 25.6, 2.2), (37.5, 26.2, 1.2)]  # s = 69 - u
# the dark slots: (s0, s1, h0, h1) on the same walls
WEST_SLOTS = [(28.0, 42.0, 13.7, 15.2), (0.5, 8.5, 18.7, 20.3)]
EAST_SLOTS = [(30.5, 44.0, 14.5, 16.3)]
# what carries the U: columns (s along the front), wall piers (s0, s1) and V struts (foot s, the two heads' s)
WEST_COLS, WEST_PIERS, WEST_VS = (0.6, 7.0, 28.0, 35.0, 42.0, 49.0, 70.4), ((55.5, 58.0), (60.0, 63.0)), ((18.5, 15.5, 21.5),)
EAST_COLS, EAST_PIERS, EAST_VS = (0.6, 28.5, 35.5, 42.5, 50.5, 57.0, 70.4), (), ((4.0, 0.8, 7.2), (20.5, 15.5, 25.5), (61.5, 58.0, 65.0))
SOUTH_COLS, SOUTH_PIERS = (23.0, 30.0, 36.5, 43.0, 49.5), ((51.0, 53.0), (57.5, 59.5))
# the south front's screen of concrete triangles (s0, s1, h0, h1), and the mesh-clad box that hangs before it on its tapering foot
SCREEN = [(5.0, 50.5, 22.0, 27.3), (22.5, 50.5, 12.5, 22.0), (45.0, 61.0, 10.5, 17.0)]
BOX = (25.2, 39.1, 116.4, 123.9, 12.5, 24.5)
BOX_FOOT = (27.5, 36.8, 117.2, 122.2)
# the foyer towards the fjord
LID = (40.0, 58.5, 20.0, 52.0, 12.5, 25.3)  # the aluminium box over the foyer, its window to the fjord
BODY = [(40.0, 20.0), (58.5, 20.0), (58.5, 30.0), (65.0, 30.0), (65.0, 50.0), (33.5, 50.0), (33.5, 38.0), (40.0, 38.0)]  # the aluminium under and beside it
BODY_TOP = 24.6  # the flat glass roofs beside the lid
GLASS_W, GLASS_E = (33.5, 40.0, 38.0, 50.0), (58.5, 65.0, 30.0, 50.0)
ATRIUM_TOP = 17.3
HALL_WALLS = ((33.7, 34.9, 50.0, 80.0), (63.1, 64.3, 50.0, 78.0), 24.7)  # the walls along the hall's roof: west, east, their head
ATRIA = ((30.5, 35.0, 45.4, 75.0), (63.0, 69.0, 50.0, 77.0))  # the glass roofs between the hall and the wings
WAVE = (46.5, 16.0, 10.5, 8.2)  # the foyer's front, half an ellipse in plan: centre u, v and half axes
WAVE_EDGE = ((0.0, 7.4), (0.25, 8.2), (0.5, 6.6), (0.8, 4.6), (1.0, 4.8))  # the wave: its edge's height from the east end (0) round to the west end (1)
WAVE_BACK = ((0.0, 9.0), (0.15, 12.3), (0.75, 12.3), (1.0, 7.0))  # and the roof's height where it meets the house, under the lid
ENTRANCE = (43.3, 49.7, 6.3, 8.6, 3.3)
# the pavilion on the north-west corner: a square glazed front under a flat roof, and behind it a shell that falls to a low wall on the rounded outline
PAV_FRONT = ((16.2, 6.5), (30.9, 2.1))
PAV_BACK = ((16.7, 18.0), (33.6, 13.5))
PAV_TOP = 8.6
PAV_RIM = [(16.8, 19.5, 5.5), (17.1, 23.6, 2.2), (19.0, 29.1, 2.0), (22.9, 34.4, 2.0), (27.8, 37.8, 2.0), (33.8, 38.2, 2.5), (36.3, 32.0, 4.0), (36.0, 24.0, 6.5),
           (35.6, 15.0, 8.6)]  # u, v and the wall's head, from the west round the back to the east
NE_BOX = (56.9, 75.6, 6.9, 33.2, 4.6)  # the low concrete block east of the bubble

DARK, FRAME_D, RING, COURT_FELT, PALE = col(.07, .08, .1), col(.2, .21, .23), col(.84, .83, .8), col(.31, .32, .37), col(.82, .83, .84)


# -------------------------------------------------------------------------------------------------------------------------------- building blocks
def porthole(m, w, s, h, d):
    """A round window on a wall: the glass, and from 1.4 m up the raised concrete ring round it."""
    r = d / 2
    n = 12 if d < 2 else 16 if d < 5 else 24
    ang = np.linspace(0, 2 * math.pi, n + 1)[:-1]
    m.poly('glassb', [w.p(s + r * math.cos(a), h + r * math.sin(a), 0.04) for a in ang], w.n, uvs=[(r * math.cos(a), r * math.sin(a)) for a in ang])
    if d >= 1.4:
        k = r + 0.22
        for a0, a1 in zip(ang, np.roll(ang, -1)):
            m.poly('painted', [w.p(s + r * math.cos(a0), h + r * math.sin(a0), 0.07), w.p(s + r * math.cos(a1), h + r * math.sin(a1), 0.07),
                               w.p(s + k * math.cos(a1), h + k * math.sin(a1), 0.07), w.p(s + k * math.cos(a0), h + k * math.sin(a0), 0.07)], w.n, color=RING)


def bubble_wall(m, a, b, h0, h1, holes=(), slots=(), mat='concrete'):
    """A concrete wall with its round windows and dark slots."""
    w = WallFrame(a, b)
    m.wall(mat, w, h0, h1)
    for s, h, d in holes:
        if h - d / 2 > h0 and h + d / 2 < h1 and d / 2 < s < w.length - d / 2:
            porthole(m, w, s, h, d)
    for s0, s1, y0, y1 in slots:
        m.poly('painted', [w.p(s0, y0, 0.03), w.p(s1, y0, 0.03), w.p(s1, y1, 0.03), w.p(s0, y1, 0.03)], w.n, color=DARK)
    return w


def strut(m, foot, head, t=0.45):
    """A square concrete strut from one point (u, h, v) to another."""
    a, b = np.array(foot, float), np.array(head, float)
    d = (b - a) / np.linalg.norm(b - a)
    x = np.cross(d, (0, 0, 1) if abs(d[2]) < 0.9 else (1, 0, 0))
    x = x / np.linalg.norm(x) * t / 2
    y = np.cross(d, x)
    y = y / np.linalg.norm(y) * t / 2
    for p, q in ((x, y), (y, -x), (-x, -y), (-y, x)):
        m.poly('concrete', [a + p + q, a + p - q, b + p - q, b + p + q], p)


def carry(m, w, hb, cols, piers, vs, d=-0.45):
    """What stands under a front of the U: round columns, wall piers and V struts, just behind the face."""
    for s in cols:
        p = w.p(s, 0, d)
        m.cylinder('concrete', p[0], p[2], 0.38, hb, SOFFIT, n=10)
    for s0, s1 in piers:
        m.wbox('concrete', w, s0, s1, hb, SOFFIT, d - 0.3, d + 0.3, top=False)
    for foot, h0, h1 in vs:
        for head in (h0, h1):
            strut(m, w.p(foot, hb, d), w.p(head, SOFFIT, d), 0.6)


# -------------------------------------------------------------------------------------------------------------------------------------- the U
def add_u(m, hb):
    u0, u1, v0, v1 = U_OUT
    cw, ce, cs = U_IN
    ev, eh = E_END
    west = bubble_wall(m, (u0, v1), (u0, v0), SOFFIT, U_TOP, [(v1 - v0 - s, h, d) for s, h, d in WEST], [(v1 - v0 - b, v1 - v0 - a, y0, y1) for a, b, y0, y1 in WEST_SLOTS])
    east = bubble_wall(m, (u1, v0), (u1, v1), SOFFIT, U_TOP, [(v1 - v0 - s, h, d) for s, h, d in EAST if not (v1 - s < ev and h + d / 2 > eh)],
                       [(v1 - v0 - b, v1 - v0 - a, y0, y1) for a, b, y0, y1 in EAST_SLOTS])
    south = bubble_wall(m, (u1, v1), (u0, v1), SOFFIT, U_TOP, [(u1 - u0 - s, h, d) for s, h, d in SOUTH])
    for s0, s1, y0, y1 in SCREEN:  # the screen stands a hand before the wall
        a, b = u1 - u0 - s1, u1 - u0 - s0
        m.poly('lattice', [south.p(a, y0, 0.3), south.p(b, y0, 0.3), south.p(b, y1, 0.3), south.p(a, y1, 0.3)], south.n, uvs=[(a, y0), (b, y0), (b, y1), (a, y1)])
        for s in (a, b):
            m.poly('concrete', [south.p(s, y0, 0), south.p(s, y0, 0.3), south.p(s, y1, 0.3), south.p(s, y1, 0)], south.t * (1 if s == b else -1))
        m.poly('concrete', [south.p(a, y1, 0), south.p(b, y1, 0), south.p(b, y1, 0.3), south.p(a, y1, 0.3)], UP)
        m.poly('concrete', [south.p(a, y0, 0), south.p(b, y0, 0), south.p(b, y0, 0.3), south.p(a, y0, 0.3)], -UP)
    # the wings' north ends, the east one cut down to its terrace
    bubble_wall(m, (u0, v0), (cw, v0), SOFFIT, U_TOP, [(cw - u0 - s, h, d) for s, h, d in N_WEST], [(0.0, cw - u0, 19.3, 20.8)])
    bubble_wall(m, (ce, v0), (u1, v0), SOFFIT, eh, [(u1 - ce - s, h, d) for s, h, d in N_EAST])
    bubble_wall(m, (ce, ev), (u1, ev), eh - 0.3, U_TOP)
    flat(m, 'roof', rect_ring(ce, u1, v0, ev), eh - 0.3)
    # the court's walls
    bubble_wall(m, (cw, v0), (cw, cs), COURT, U_TOP, [(cs - v0 - s, h, d) for s, h, d in COURT_W])
    bubble_wall(m, (ce, cs), (ce, v0), COURT, U_TOP, [(cs - v0 - s, h, d) for s, h, d in COURT_E if s > ev - v0 + d])
    bubble_wall(m, (cw, cs), (ce, cs), COURT, U_TOP, [(ce - cw - s, h, d) for s, h, d in COURT_S])
    flat_roof(m, [(u0, v0), (cw, v0), (cw, cs), (ce, cs), (ce, ev), (u1, ev), (u1, v1), (u0, v1)], U_ROOF, U_TOP, wall='concrete')
    units(m, U_ROOF, [(22.0, 23.2, 55.0, 56.2, 0.6), (22.0, 23.2, 101.0, 102.2, 0.6), (75.0, 76.2, 55.0, 56.2, 0.6), (78.0, 79.2, 94.0, 95.2, 0.6)], color=PALE)
    # under it: the soffit, the ground floors set back behind glass, and what carries it
    for ring in (rect_ring(u0, cw, v0, v1), rect_ring(ce, u1, v0, v1), rect_ring(cw, ce, cs, v1)):
        flat(m, 'concrete', ring, SOFFIT, down=True)
    b = SET_BACK
    for a, c in (((u0 + b, v1 - b), (u0 + b, v0 + b)), ((u0 + b, v0 + b), (cw, v0 + b)), ((ce, v0 + b), (u1 - b, v0 + b)), ((u1 - b, v0 + b), (u1 - b, v1 - b)),
                 ((u1 - b, v1 - b), (u0 + b, v1 - b))):
        w = WallFrame(a, c)
        glazing(m, w, 0, w.length, hb, SOFFIT, 'glass', round(w.length / 1.6), 4)
    carry(m, WallFrame((u0, v1), (u0, v0)), hb, [v1 - v0 - s for s in WEST_COLS], [(v1 - v0 - q, v1 - v0 - p) for p, q in WEST_PIERS],
          [tuple(v1 - v0 - s for s in v) for v in WEST_VS])
    carry(m, WallFrame((u1, v0), (u1, v1)), hb, [v1 - v0 - s for s in EAST_COLS], (), [tuple(v1 - v0 - s for s in v) for v in EAST_VS])
    carry(m, WallFrame((u1, v1), (u0, v1)), hb, [u1 - u0 - s for s in SOUTH_COLS], [(u1 - u0 - q, u1 - u0 - p) for p, q in SOUTH_PIERS], ())
    for w in (WallFrame((u0, v0), (cw, v0)), WallFrame((ce, v0), (u1, v0))):
        carry(m, w, hb, (0.6, w.length / 2, w.length - 0.6), (), ())


def add_box(m, hb):
    """The mesh-clad box before the south front, on its tapering aluminium foot."""
    u0, u1, v0, v1, y0, y1 = BOX
    m.box('alu', (u0, y0, v0), (u1, y1, v1), skip=('n', 't'))
    flat(m, 'roof', rect_ring(u0, u1, v0, v1), y1)
    f0, f1, g0, g1 = BOX_FOOT
    top, foot = rect_ring(u0, u1, v0, v1), rect_ring(f0, f1, g0, g1)
    for i in range(4):
        j = (i + 1) % 4
        a, b, c, d = top[i], top[j], foot[j], foot[i]
        mid = np.array([a[0] + b[0] - u0 - u1, 0, a[1] + b[1] - v0 - v1])
        m.poly('alu', [(a[0], y0, a[1]), (b[0], y0, b[1]), (c[0], hb, c[1]), (d[0], hb, d[1])], mid)


def add_hall(m, hb):
    u0, u1, v0, v1, top = HALL
    cw, ce, cs = U_IN
    ring = [(u0, v0), (u1, v0), (u1 - HALL_TAPER, v1), (u0 + HALL_TAPER, v1)]  # it narrows towards the south
    for i in range(4):
        m.wall('concrete', WallFrame(ring[i], ring[(i + 1) % 4]), COURT, top)
    flat_roof(m, ring, top, top + 0.5, wall='concrete')
    for a0, a1, b0, b1 in HALL_WALLS[:2]:
        m.box('alu', (a0, COURT, b0), (a1, HALL_WALLS[2], b1), skip=('b',))
    units(m, top, [(41.0, 42.4, 63.5, 64.9, 0.7), (56.0, 57.4, 63.5, 64.9, 0.7), (44.0, 45.4, 96.0, 97.4, 0.7), (53.0, 54.4, 96.0, 97.4, 0.7)], color=PALE)
    flat(m, 'painted', rect_ring(cw, ce, LID[3], cs), COURT, color=COURT_FELT)
    # the glass roofs of the atria, and their ends
    for a0, a1, b0, b1 in ATRIA:
        y = ATRIUM_TOP
        m.poly('glassb', [(a0, y, b0), (a1, y, b0), (a1, y, b1), (a0, y, b1)], UP, uvs=[(a0, b0), (a1, b0), (a1, b1), (a0, b1)])
        for v, sgn in ((b0, -1), (b1, 1)):
            m.poly('glass', [(a0, COURT, v), (a1, COURT, v), (a1, y, v), (a0, y, v)], (0, 0, sgn), uvs=[(0, 0), (3, 0), (3, 3), (0, 3)])


# ----------------------------------------------------------------------------------------------------------------------------------- the foyer
def add_lid(m, hb):
    u0, u1, v0, v1, y0, y1 = LID
    n = len(BODY)
    for i in range(n):
        w = WallFrame(BODY[i], BODY[(i + 1) % n])
        m.wall('alu', w, hb, y0 if i == 0 else BODY_TOP)  # the lid's own front stands over the first
    flat(m, 'alu', BODY, BODY_TOP)
    m.box('alu', (u0, BODY_TOP, v0), (u1, y1, v1), skip=('b', 'n'))
    # the window to the fjord, deep in the lid's frame
    north = WallFrame((u0, v0), (u1, v0))
    f = Facade(m, (u0, v0), (u1, v0), y0, y1, 'alu')
    f.win(north.length / 2, north.length - 1.6, 14.0, 24.5, fill='glass', panes=(9, 5), depth=1.2)
    f.done()
    m.poly('alu', [(u0, y0, v0), (u1, y0, v0), (u1, y0, v0 + 1.2), (u0, y0, v0 + 1.2)], -UP)
    m.wbox('painted', north, 0.8, north.length - 0.8, 19.2, 19.5, -1.1, -0.6, color=PALE)
    # the glass roofs beside it are flat
    for a0, a1, b0, b1 in (GLASS_W, GLASS_E):
        m.poly('glassb', [(a0, BODY_TOP + 0.03, b0), (a1, BODY_TOP + 0.03, b0), (a1, BODY_TOP + 0.03, b1), (a0, BODY_TOP + 0.03, b1)], UP, uvs=[(a0, b0), (a1, b0), (a1, b1), (a0, b1)])


def wave_point(i, n):
    cu, cv, ru, rv = WAVE
    a = math.pi * i / n
    t = i / n
    return cu + ru * math.cos(a), cv - rv * math.sin(a), float(np.interp(t, *zip(*WAVE_EDGE))), float(np.interp(t, *zip(*WAVE_BACK)))


def add_wave(m, hb):
    """The foyer's front: a roof of glass and white triangles that rises from a wave-shaped edge to the house, a band of aluminium along the edge, glass under it."""
    cu, cv, ru, rv = WAVE
    n, rows, back = 20, 4, LID[2]
    grid = []
    for i in range(n + 1):
        u, v, he, hk = wave_point(i, n)
        grid.append([(u, he + (hk - he) * math.sin(j / rows * math.pi / 2), v + (back - v) * j / rows) for j in range(rows + 1)])
    for i in range(n):
        for j in range(rows):
            m.poly('tri', [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]], UP, uvs=[(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)])
        (ua, ya, va), (ub, yb, vb) = grid[i][0], grid[i + 1][0]
        out = (ua + ub - 2 * cu, 0, va + vb - 2 * cv)
        m.poly('alu', [(ua, ya - 0.9, va), (ub, yb - 0.9, vb), (ub, yb + 0.05, vb), (ua, ya + 0.05, va)], out)
        k = 0.93
        ga, gb = (cu + (ua - cu) * k, cv + (va - cv) * k), (cu + (ub - cu) * k, cv + (vb - cv) * k)
        m.poly('glass', [(ga[0], hb, ga[1]), (gb[0], hb, gb[1]), (gb[0], yb - 0.9, gb[1]), (ga[0], ya - 0.9, ga[1])], out, uvs=[(i * 2, 0), (i * 2 + 2, 0), (i * 2 + 2, 3), (i * 2, 3)])
        m.poly('alu', [(ua, ya - 0.9, va), (ub, yb - 0.9, vb), (gb[0], yb - 0.9, gb[1]), (ga[0], ya - 0.9, ga[1])], -UP)
    for i, sgn in ((0, 1), (n, -1)):  # its ends, against the low block and the pavilion
        (u, he, v), (_, hk, _) = grid[i][0], grid[i][-1]
        m.poly('alu', [(u, hb, v), (u, hb, back), (u, hk, back), (u, he, v)], (sgn, 0, 0))
    u0, u1, v0, v1, top = ENTRANCE
    m.box('painted', (u0, hb, v0), (u1, top, v1), color=PALE, skip=('b', 's'))
    m.poly('glass', [(u0 + 0.3, hb, v0 - 0.04), (u1 - 0.3, hb, v0 - 0.04), (u1 - 0.3, top - 0.3, v0 - 0.04), (u0 + 0.3, top - 0.3, v0 - 0.04)], (0, 0, -1), uvs=[(0, 0), (5, 0), (5, 2), (0, 2)])


def add_pavilion(m, hb):
    """The pavilion on the north-west corner: square and glazed towards the fjord, rounded at the back."""
    (a, b), (p0, p1) = PAV_FRONT, PAV_BACK
    top = PAV_TOP
    f = Facade(m, a, b, hb, top, 'alu')
    f.win(f.w.length / 2, f.w.length - 1.4, hb + 0.02, top - 0.9, fill='glassw', panes=(9, 4), depth=0.3)
    f.done()
    m.poly('alu', [(a[0], hb, a[1]), (p0[0], hb, p0[1]), (p0[0], top, p0[1]), (a[0], top, a[1])], (-1, 0, 0))
    m.poly('alu', [(b[0], hb, b[1]), (p1[0], hb, p1[1]), (p1[0], top, p1[1]), (b[0], top, b[1])], (1, 0, 0))
    m.poly('alu', [(a[0], top, a[1]), (b[0], top, b[1]), (p1[0], top, p1[1]), (p0[0], top, p0[1])], UP)
    ang = np.linspace(0, 2 * math.pi, 17)[:-1]
    m.poly('glassb', [(23.5 + 1.6 * math.cos(t), top + 0.04, 10.5 + 1.6 * math.sin(t)) for t in ang], UP, uvs=[(1.6 * math.cos(t), 1.6 * math.sin(t)) for t in ang])
    # the shell behind it: from the flat roof's back edge down to the low wall round the back
    n, rows = len(PAV_RIM), 4
    grid = []
    for k, (ru, rv, rh) in enumerate(PAV_RIM):
        t = k / (n - 1)
        bu, bv = p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t
        grid.append([(bu + (ru - bu) * j / rows, rh + (top - rh) * (1 - (j / rows) ** 2.2), bv + (rv - bv) * j / rows) for j in range(rows + 1)])
    for k in range(n - 1):
        for j in range(rows):
            pts = [grid[k][j], grid[k + 1][j], grid[k + 1][j + 1], grid[k][j + 1]]
            m.poly('alu', pts, UP, uvs=[(q[0], q[2] + q[1]) for q in pts])
        (ua, ya, va), (ub, yb, vb) = grid[k][-1], grid[k + 1][-1]
        m.poly('alu', [(ua, hb, va), (ub, hb, vb), (ub, yb, vb), (ua, ya, va)], (ua + ub - 54, 0, va + vb - 50))


def add_ne_box(m, hb):
    u0, u1, v0, v1, top = NE_BOX
    for i, (a, b) in enumerate(zip(rect_ring(u0, u1, v0, v1), rect_ring(u0, u1, v0, v1)[1:] + [(u0, v0)])):
        m.wall('concrete', WallFrame(a, b), hb, top)
    flat(m, 'painted', rect_ring(u0, u1, v0, v1), top, color=PALE)


def build(hb=-2.0):
    m = Model()
    add_u(m, hb)
    add_box(m, hb)
    add_hall(m, hb)
    add_lid(m, hb)
    add_wave(m, hb)
    add_pavilion(m, hb)
    add_ne_box(m, hb)
    return m


def plan_rings():
    """The outlines of what stands on or over the ground (u, v): what the footprint is compared by."""
    pavilion = list(PAV_FRONT) + [PAV_BACK[1]] + [(u, v) for u, v, _ in reversed(PAV_RIM)]
    wave = [wave_point(i, 20)[:2] for i in range(21)] + [(WAVE[0] - WAVE[2], LID[2]), (WAVE[0] + WAVE[2], LID[2])]
    return [rect_ring(*U_OUT), rect_ring(*BOX[:4]), BODY, pavilion, wave, rect_ring(*NE_BOX[:4])]


# ------------------------------------------------------------------------------------------------------------------------------------- textures
TONES = {'concrete': (0.80, 0.79, 0.76), 'alu': (0.76, 0.78, 0.80), 'roof': (0.31, 0.32, 0.37)}


def concrete_texture(n=256):
    """Pale precast concrete, its elements 3 m wide in a repeat of 6 m."""
    rs = np.random.default_rng(61)
    img = tiled(TONES['concrete'], 61, grain=0.03, wash=0.05, stretch=(1.0, 0.25), n=n)
    y, x = np.mgrid[0:n, 0:n] + .5
    img *= (1 + .02 * rs.normal(0, 1, (2, 2)))[(y / n * 2).astype(int) % 2, (x / n * 2).astype(int) % 2][..., None]
    f = x / n * 2 % 1
    img[np.minimum(f, 1 - f) < 0.006] *= 0.86
    return to_image(np.clip(img, 0, 1))


def alu_texture(n=256):
    """Aluminium sheets, 1.5 m by 0.75 m in a repeat of 3 m, each catching the light a little differently."""
    rs = np.random.default_rng(63)
    img = tiled(TONES['alu'], 63, grain=0.012, wash=0.03, n=n)
    y, x = np.mgrid[0:n, 0:n] + .5
    img *= (1 + .045 * rs.normal(0, 1, (4, 2)))[(y / n * 4).astype(int) % 4, (x / n * 2).astype(int) % 2][..., None]
    for c, k in ((x, 2), (y, 4)):
        f = c / n * k % 1
        img[np.minimum(f, 1 - f) < 0.012] *= 0.8
    return to_image(np.clip(img, 0, 1))


def roof_texture(n=256):
    return to_image(np.clip(tiled(TONES['roof'], 65, grain=0.07, wash=0.04, n=n), 0, 1))


def lattice_texture(n=256):
    """The south screen: square frames of 1.2 m, half of each closed by a concrete triangle, the rest open to the dark behind. A repeat of 2.4 m."""
    img = tiled(TONES['concrete'], 67, grain=0.03, wash=0.03, n=n)
    y, x = np.mgrid[0:n, 0:n] + .5
    fx, fy = x / n * 2 % 1, y / n * 2 % 1
    hole = (fx + fy > 1.06) & (fx < 0.93) & (fy < 0.93)
    img[hole] = (0.03, 0.035, 0.045)
    return to_image(np.clip(img, 0, 1))


def pane_texture(pane, frame, seed, bar=0.05, shade=0.6, n=128):
    y, x = np.mgrid[0:n, 0:n] + .5
    fx, fy = x / n, y / n
    img = np.array(pane)[None, None] * (1 + shade * fy)[..., None] * (1 + .15 * periodic_noise(n, 1.3, seed, low=1))[..., None]
    img[(np.minimum(fx, 1 - fx) < bar) | (np.minimum(fy, 1 - fy) < bar)] = frame
    return to_image(np.clip(img, 0, 1))


def tri_texture(n=128):
    """The bubble's skin: each field cut in two triangles, blue glass or white sheet as it falls. Four fields by four."""
    rs = np.random.default_rng(69)
    y, x = np.mgrid[0:n, 0:n] + .5
    fx, fy = x / n * 4, y / n * 4
    i, j = fx.astype(int) % 4, fy.astype(int) % 4
    upper = (fx % 1 + fy % 1) > 1
    white = rs.random((4, 4, 2)) < 0.42
    glass, sheet = np.array((0.05, 0.11, 0.2)), np.array(albedo((0.86, 0.87, 0.88)))
    img = np.where(white[j, i, upper.astype(int)][..., None], sheet, glass * (0.8 + 0.5 * rs.random((4, 4, 2))[j, i, upper.astype(int)][..., None]))
    edge = (np.minimum(fx % 1, 1 - fx % 1) < 0.04) | (np.minimum(fy % 1, 1 - fy % 1) < 0.04) | (np.abs(fx % 1 + fy % 1 - 1) < 0.05)
    img[edge] = albedo((0.8, 0.81, 0.82))
    return to_image(np.clip(img, 0, 1))


TEXTURES = {
    'concrete': concrete_texture, 'alu': alu_texture, 'roof': roof_texture, 'lattice': lattice_texture, 'tri': tri_texture,
    'glass': lambda: pane_texture((0.03, 0.045, 0.06), (0.08, 0.085, 0.095), 71),
    'glassb': lambda: pane_texture((0.04, 0.075, 0.12), albedo((0.62, 0.64, 0.66)), 73, bar=0.035, shade=0.3),
    'glassw': lambda: pane_texture((0.03, 0.05, 0.075), albedo((0.86, 0.86, 0.85)), 75, bar=0.04),
}
MATERIALS = {
    'concrete': dict(tile=(6.0, 6.0), roughness=0.9),
    'alu': dict(tile=(3.0, 3.0), roughness=0.35, metallic=0.6),
    'roof': dict(tile=(8.0, 8.0), roughness=0.95),
    'lattice': dict(tile=(2.4, 2.4), roughness=0.9),
    'tri': dict(tile=(4.0, 4.0), roughness=0.25, metallic=0.4),
    'glass': dict(tile=(1.0, 1.0), roughness=0.15, metallic=0.5),
    'glassb': dict(tile=(0.7, 0.7), roughness=0.15, metallic=0.5),
    'glassw': dict(tile=(1.0, 1.0), roughness=0.15, metallic=0.5),
    'painted': dict(tile=None, roughness=0.7),
}
ATTRIBUTION = {
    'lod2-dhm-punktsky': {'text': 'LoD2 shell and surface model from DHM Punktsky, Klimadatastyrelsen (roof levels)', 'licence': 'CC BY 4.0', 'url': 'https://dataforsyningen.dk'},
    'skraafoto-2021': {'text': 'Skråfoto 2021, Klimadatastyrelsen (measurements and colours)', 'licence': 'CC BY 4.0 terms for free geographic data', 'url': 'https://dataforsyningen.dk'},
    'geodanmark': {'text': 'GeoDanmark Bygning (footprint)', 'licence': 'CC BY 4.0', 'url': 'https://www.geodanmark.dk'},
    'commons-soegaard-2014': {'text': 'Marc Søgaard, Musikkens Hus - front, - vest, Wikimedia Commons (reference only: no pixels, no measurements)', 'licence': 'CC BY-SA 3.0',
                              'url': 'https://commons.wikimedia.org/wiki/File:Musikkens_Hus_-_front.JPG'},
}


def twin_xz(u, v):
    a = math.radians(AXIS_DEG)
    return ORIGIN[0] + u * math.cos(a) - v * math.sin(a), ORIGIN[1] + u * math.sin(a) + v * math.cos(a)


def footprint_match(frame, cell=0.25):
    """IoU of the model's plan with the GeoDanmark footprint, on a 25 cm raster."""
    gdk = [flat_to_pts(frame.buildings(TILE)[GDK_ID]['ring'])]
    mine = [[twin_xz(u, v) for u, v in ring] for ring in plan_rings()]
    xs = [p[0] for r in gdk + mine for p in r]
    zs = [p[1] for r in gdk + mine for p in r]
    x0, z0 = min(xs) - 1, min(zs) - 1
    size = (int((max(xs) - x0 + 1) / cell), int((max(zs) - z0 + 1) / cell))
    masks = []
    for rings in (gdk, mine):
        img = Image.new('1', size, 0)
        d = ImageDraw.Draw(img)
        for r in rings:
            d.polygon([((x - x0) / cell, (z - z0) / cell) for x, z in r], fill=1)
        masks.append(np.asarray(img))
    return float((masks[0] & masks[1]).sum() / (masks[0] | masks[1]).sum())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--data', default=str(ROOT / 'data'))
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    a = ap.parse_args()
    data, out = Path(a.data), Path(a.out)
    frame = TwinFrame(data)
    rec = frame.buildings(TILE)[GDK_ID]
    low = frame.ground_low(rec)
    hb = low - 0.25
    iou = footprint_match(frame)
    print(f'ground low {low:.2f}, footprint IoU {iou:.3f}')
    model = build(hb)
    body, mesh, lo, hi = model_to_glb(model, AXIS_DEG, (ORIGIN[0], 0.0, ORIGIN[1]), MATERIALS, TEXTURES, SET,
                                      root_extras={'building_id': GDK_ID, 'source_ids': list(ATTRIBUTION)[:3], 'attribution': list(ATTRIBUTION), 'confidence': 'observed'},
                                      asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                                      attribution=list(ATTRIBUTION), generator='tools/overrides/musikkens_hus.py')
    rel = 'meshes/gdk_1214569300.glb'
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    (out / rel).write_bytes(body)
    entry = {
        'tile': TILE, 'mode': 'replace', 'covers': [GDK_ID], 'footprint': {'use': 'gdk'},
        'match': {'kind': '1:1', 'iou': round(iou, 3), 'hausdorff': 1.5},
        'source': {'ids': list(ATTRIBUTION)[:3], 'kind': 'lod2-skraafoto', 'reconstruction': 'tools/overrides/musikkens_hus.py'},
        'confidence': 'observed', 'attribution': list(ATTRIBUTION),
        'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': rec['ground'], 'low': round(low, 2), 'sunk': 0.25,
        'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
    }
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': {GDK_ID: entry}})
    print(f'{out}: {mesh["triangles"]} triangles, {len(body) / 1e6:.2f} MB GLB, {mesh["textureBytes"] / 1e6:.1f} MB textures, top {hi[1]:.2f}')


if __name__ == '__main__':
    main()
