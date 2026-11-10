#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Aalborg Kongres & Kultur Center (Europa Plads 4, Aalborg): a detail override built without drawings (docs/akkc.md).

No drawings of the centre are public. The model is measured from three things: the LoD2 shells of its six GeoDanmark buildings (roof levels, eaves
and ridges), their footprints (every wall in plan), and the 2021 Skraafoto flight: the vertical photo laid over the roofs, and the four oblique photos
rectified onto each wall's plane, on which the bays, window rows, signs and the stage tower's tile picture were measured. Photographs on Wikimedia Commons
(2016-2022) settle what the oblique photos leave open: frame colours, the glazed link, the set-back top storey. Every measure is written out as a number
here, so the script runs without the photos and without the network. No pixel of a photograph is in the model.

The model's frame: u east along Aalborghallen, v south across it, from a point north-west of the centre; h is the twin's own height (local y), as the
LoD2 shells have it.

    PYTHONUTF8=1 uv run tools/overrides/akkc.py [--data data] [--out DIR]
    PYTHONUTF8=1 uv run tools/overrides/publish.py install     # with no --sets: every set, so the other overrides stay
"""
from __future__ import annotations

import argparse, hashlib, math, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from overrides_lib import SOURCE_FORMAT, TwinFrame, flat_to_pts, write_json
from override_model import Model, UP, WallFrame, albedo, model_to_glb, periodic_noise, to_image

SET = 'akkc'
GDK_ID = 'gdk:1210731072'  # Aalborghallen, the largest of the six
COVERS = ['gdk:1210731072', 'gdk:1210731068', 'gdk:1210731069', 'gdk:1210731070', 'gdk:1210731071', 'gdk:1210731073']
TILE = '1110_12645'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET

AXIS_DEG = 4.75  # the long edges of Aalborghallen's footprint
ORIGIN = (-692.0, 440.0)  # the frame's origin in the twin's x, z

# ------------------------------------------------------------------------------------------------------------------------------ the measures
# Plan (u, v) from the GeoDanmark footprints and the vertical photo; heights (local y) from the LoD2 shells; openings from the rectified oblique photos.
G_W, G_E, G_N = 1.5, 0.0, 0.7  # the ground: on the plaza and towards Vesterbro, around the hall, at the north wing
BAY = 4.6  # the 1953 buildings' column pitch, on every facade

HALL = (96.0, 165.0, 32.2, 66.2)  # Aalborghallen's high roof: u0, u1, v0, v1
HALL_EAVE, HALL_RIDGE, HALL_VENT = 17.4, 20.4, 21.0
HALL_WIN = (11.7, 14.7, 3.5)  # the clerestory windows: sill, head, width
N_STRIP = (96.7, 165.0, 23.7, 32.2, 6.6)  # the low strip along the hall's north side
S_WING = (96.0, 165.0, 66.2, 88.3, 12.3)  # the foyers towards Kildeparken
S_WING_GLASS = 10  # from this bay eastwards the south front is glass from floor to floor
TOWER = (165.0, 187.9, 34.8, 62.6)  # the stage tower
TOWER_EAVE, TOWER_RIDGE = 27.9, 30.5
TOWER_BAND = (46.5, 51.2)  # the flat band along its ridge, with the smoke vents
NE_BLOCK = (165.0, 185.6, 23.7, 34.8, 12.3)
E_LOW = (187.9, 196.1, 39.5, 62.6, 2.6, 7.6)  # behind the stage, on posts: u0, u1, v0, v1, soffit, top
SE_BLOCK = (165.0, 172.0, 62.6, 85.8, 12.3)
SE_BOX = (164.0, 170.5, 78.0, 85.2, 14.1)
WINTER = (172.0, 177.9, 72.0, 85.8, 5.0, 2.6)  # the glazed lean-to in the corner: its head and its eave
E_WING = (172.0, 215.8, 62.6, 72.0, 9.9)
E_WING_ROWS = ((0.3, 2.9), (3.5, 5.9), (6.5, 9.0))
E_WING_PIER = 174.2  # its first pier; the rest follow at BAY

UPPER = (77.0, 96.0, 27.9, 70.0, 12.3)  # the 1953 front building west of the hall, its high part
UPPER_BOX = (91.0, 96.0, 42.0, 56.0, 13.6)
S_BLOCK = (68.1, 96.1, 70.0, 92.6, 8.3, 11.4)  # its south end: a white block, a dark glazed storey set back on it
LINK = (60.9, 68.1, 73.5, 78.8, 9.0)  # the glazed link to Europahallen
FOYER = [(67.3, 27.9), (77.0, 27.9), (77.0, 73.5), (60.9, 73.5), (60.9, 64.0), (54.7, 57.6), (67.3, 45.1)]  # the low entrance hall on the plaza
FOYER_TOP = 5.6
NW_ROOM = (72.5, 81.7, 21.4, 27.9, 14.0)
N_WING = [(57.6, 4.8), (84.8, 11.5), (81.7, 23.7), (54.5, 16.9)]  # the office wing on the plaza's north side
N_WING_TOP = 11.8
N_WING_ROWS = ((1.7, 3.4), (5.1, 6.8), (8.5, 10.2))

# Europahallen (1990): the white body, the glazed lean-to along the plaza, the stair drum, the vault
EURO = [(19.2, 37.0), (30.7, 42.1), (30.7, 46.6), (38.9, 46.6), (60.9, 69.05), (60.9, 80.4), (14.8, 80.3), (13.3, 79.8), (12.0, 78.9), (10.9, 77.5),
        (10.2, 75.8), (9.9, 73.8)]
EURO_TOP = 12.3
LEAN_OUT = [(30.7, 43.05), (40.4, 43.0), (60.9, 64.0)]  # the foot of its glass, on the footprint
LEAN_IN = [(30.7, 46.6), (38.9, 46.6), (60.9, 69.05)]  # where its roof meets the body
LEAN_EAVE, LEAN_HEAD = 6.6, 11.7
EURO_BAYS = ((20.5, 25.5), (26.5, 31.5), (32.5, 37.5), (38.5, 43.5))  # the four glazed bays of the south front
EURO_BAY_H = (2.0, 9.7)
DRUM = (53.8, 81.6, 3.0, 12.9)  # the glazed stair: centre u, v, radius, top
VAULT = (61.5, 74.0, 17.5, 12.0, 3.0)  # v0, v1, its east end, springing, rise
PLANTERS = ((21.5, 84.5), (24.5, 84.5), (33.5, 84.5), (36.5, 84.5))  # the white drums on the terrace

# The tile picture on the stage tower's east face, ten by ten fields from v 60.4 (left) to 37.5 and from h 26.2 down to 13.0:
# g grey, r red, w white, b pale blue, y yellow. Classified field by field from the rectified photo.
PICTURE = ('grgrggrggr', 'gggbrgggrg', 'rbrggggbgb', 'gwgbgwgwgg', 'wbgbbgrbbw', 'bbgwbygbwb', 'rbgggygggw', 'gbggywgbrb', 'rwrbgggrgb', 'grgggrggrg')
PICTURE_BOX = (60.4, 37.5, 26.2, 13.0)
CATWALKS = (23.5, 20.5, 17.5, 14.3)


def col(*srgb):
    """A colour seen in a photograph as a vertex colour: the twin's albedo of it."""
    return tuple(float(c) for c in albedo(srgb)) + (1.0,)


WHITE, DARK, FRAME_D, STEEL = col(.86, .86, .85), col(.07, .08, .1), col(.2, .21, .23), col(.42, .43, .45)
DUCT, UNIT, DOME, FELT = col(.3, .31, .34), col(.8, .8, .78), col(.72, .73, .74), col(.31, .32, .37)
SPANDREL, TERRACOTTA, DOOR_BLUE, SKY = col(.52, .57, .62), col(.72, .38, .27), col(.2, .27, .42), col(.8, .84, .86)
TILES = {'g': col(.64, .64, .63), 'r': col(.84, .27, .22), 'w': col(.9, .9, .88), 'b': col(.72, .8, .9), 'y': col(.88, .78, .36)}


# -------------------------------------------------------------------------------------------------------------------------------- building blocks
def rect_ring(u0, u1, v0, v1):
    """Clockwise seen from above (u east, v south): the north, east, south and west walls in that order."""
    return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]


def offset_ring(ring, d):
    """A clockwise ring moved d outwards (inwards when negative), corners mitred."""
    n = len(ring)
    r = np.array(ring, float)
    nor = []
    for i in range(n):
        t = r[(i + 1) % n] - r[i]
        t = t / np.linalg.norm(t)
        nor.append(np.array([t[1], -t[0]]))
    return [tuple(r[i] + d * (nor[i - 1] + nor[i]) / (1 + nor[i - 1] @ nor[i])) for i in range(n)]


def ear_clip(pts):
    """Triangles (index triples) of a simple polygon, convex or not."""
    n = len(pts)
    idx = list(range(n))
    if sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n)) < 0:
        idx.reverse()
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    tris = []
    while len(idx) > 3:
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = pts[i0], pts[i1], pts[i2]
            if cross(a, b, c) <= 1e-9:
                continue
            if any(cross(a, b, pts[j]) > 1e-9 and cross(b, c, pts[j]) > 1e-9 and cross(c, a, pts[j]) > 1e-9 for j in idx if j not in (i0, i1, i2)):
                continue
            tris.append((i0, i1, i2))
            idx.pop(k)
            break
        else:
            break
    if len(idx) == 3:
        tris.append(tuple(idx))
    return tris


def flat(m, mat, ring, h, color=None, down=False):
    """A level surface over any simple ring."""
    for t in ear_clip(ring):
        m.poly(mat, [(ring[i][0], h, ring[i][1]) for i in t], -UP if down else UP, color=color)


def flat_roof(m, ring, roof, top, t=0.3, wall='white'):
    """The felt behind a parapet: the parapet's cap and inner face, and the roof inside it."""
    inner = offset_ring(ring, -t)
    n = len(ring)
    for i in range(n):
        j = (i + 1) % n
        a, b, ia, ib = ring[i], ring[j], inner[i], inner[j]
        m.poly(wall, [(a[0], top, a[1]), (b[0], top, b[1]), (ib[0], top, ib[1]), (ia[0], top, ia[1])], UP)
        mid = np.array([ia[0] + ib[0] - a[0] - b[0], 0, ia[1] + ib[1] - a[1] - b[1]])
        m.poly(wall, [(ia[0], roof, ia[1]), (ib[0], roof, ib[1]), (ib[0], top, ib[1]), (ia[0], top, ia[1])], mid)
    flat(m, 'roof', inner, roof)


class Facade:
    """A wall whose openings are gathered first and cut when it is finished. Openings are in s along the wall; `at` turns an absolute u or v into s."""

    def __init__(self, m, a, b, h0, h1, mat='white'):
        self.m, self.w, self.h0, self.h1, self.mat, self.ops = m, WallFrame(a, b), h0, h1, mat, []

    def at(self, coord):
        return self.w.at(coord)

    def win(self, c, width, sill, head, fill='glass', panes=(2, 2), depth=0.22, color=None, spandrel=0.0):
        """A rectangular opening, c its centre in s: glass in a frame of `panes` (columns, rows), or a painted panel. spandrel: a panel this high under the glass."""
        m, w, a = self.m, self.w, width / 2
        sill, head = max(sill, self.h0 + 0.01), min(head, self.h1 - 0.01)
        self.ops.append((c, [(sill, a), (head, a)]))
        p = lambda s, h, d=0.0: w.p(s, h, d)
        m.poly(self.mat, [p(c - a, sill), p(c - a, head), p(c - a, head, -depth), p(c - a, sill, -depth)], w.t)
        m.poly(self.mat, [p(c + a, sill), p(c + a, head), p(c + a, head, -depth), p(c + a, sill, -depth)], -w.t)
        m.poly(self.mat, [p(c - a, sill), p(c + a, sill), p(c + a, sill, -depth), p(c - a, sill, -depth)], UP)
        m.poly(self.mat, [p(c - a, head), p(c + a, head), p(c + a, head, -depth), p(c - a, head, -depth)], -UP)
        foot = sill
        if spandrel:
            foot = sill + spandrel
            m.poly('painted', [p(c - a, sill, -depth), p(c + a, sill, -depth), p(c + a, foot, -depth), p(c - a, foot, -depth)], w.n, color=SPANDREL)
        back = [p(c - a, foot, -depth), p(c + a, foot, -depth), p(c + a, head, -depth), p(c - a, head, -depth)]
        if fill == 'painted':
            m.poly('painted', back, w.n, color=color or DARK)
        else:
            m.poly(fill, back, w.n, uvs=[(0, 0), (panes[0], 0), (panes[0], panes[1]), (0, panes[1])])

    def pentagon(self, c, width, sill, shoulder, tip, depth=0.25, color=DARK):
        """Europahallen's house-shaped doors and windows."""
        o = [(sill, width / 2), (shoulder, width / 2), (tip, 0.0)]
        self.ops.append((c, o))
        self.m.reveal(self.w, c, o, depth, fill='painted', color=color, side=self.mat)

    def bays(self, first, pitch, count, rows, pier=0.6, **kw):
        """`count` bays from s = first, each with the openings of `rows`: (sill, head, columns, rows of panes)."""
        for k in range(count):
            for sill, head, cols, rws in rows:
                self.win(first + pitch * (k + 0.5), pitch - pier, sill, head, panes=(cols, rws), **kw)

    def done(self):
        self.m.wall(self.mat, self.w, self.h0, self.h1, self.ops)
        return self


def faces(m, ring, h0, h1, mat='white', skip=()):
    """A facade on every edge of a clockwise ring; `skip`: edges that stand against another part."""
    n = len(ring)
    return [None if i in skip else Facade(m, ring[i], ring[(i + 1) % n], h0, h1, mat) for i in range(n)]


def finish(fs):
    for f in fs:
        if f:
            f.done()


def glazing(m, w, s0, s1, h0, h1, mat, cols, rows, d=0.0):
    """A sheet of glass on a wall plane, its frame in `cols` by `rows` panes."""
    m.poly(mat, [w.p(s0, h0, d), w.p(s1, h0, d), w.p(s1, h1, d), w.p(s0, h1, d)], w.n, uvs=[(0, 0), (cols, 0), (cols, rows), (0, rows)])


def sign(m, left, right, h0, h1, row, out):
    """Lettering from `left` to `right` (u, v) as it is read, standing 3 cm before the wall: `out` (du, dv). row: 0 the centre's name, 1 Aalborghallen, 2 AKKC."""
    u1 = (1.0, 0.5, 0.25)[row]
    q = lambda p, h: (p[0] + out[0] * 0.03, h, p[1] + out[1] * 0.03)
    m.poly('sign', [q(left, h0), q(right, h0), q(right, h1), q(left, h1)], (out[0], 0, out[1]),
           uvs=[(0, (row + 1) / 4), (u1, (row + 1) / 4), (u1, row / 4), (0, row / 4)])


def units(m, top, items, color=UNIT):
    """What stands on a roof: (u0, u1, v0, v1, height)."""
    for u0, u1, v0, v1, h in items:
        m.box('painted', (u0, top, v0), (u1, top + h, v1), color=color, skip=('b',))


def domes(m, top, pts, r=0.55):
    for u, v in pts:
        m.cylinder('painted', u, v, r, top, top + 0.3, n=8, color=DOME, r1=r * 0.55)
        m.poly('painted', [(u + r * 0.55 * math.cos(a), top + 0.3, v + r * 0.55 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 9)[:-1]], UP, color=DOME)


# --------------------------------------------------------------------------------------------------------------------------- Aalborghallen (1953)
def add_hall(m, hb):
    u0, u1, v0, v1 = HALL
    vm = (v0 + v1) / 2
    sill, head, wide = HALL_WIN
    n = round((u1 - u0) / BAY)
    for a, b, foot in (((u0, v0), (u1, v0), N_STRIP[4] - 0.2), ((u1, v1), (u0, v1), S_WING[4] - 0.5)):
        f = Facade(m, a, b, foot, HALL_EAVE)
        f.bays(0.0, BAY, n, [(sill, head, 2, 2)], pier=BAY - wide)
        f.done()
    sign(m, (118.5, v0), (101.0, v0), 15.25, 16.3, 0, (0, -1))
    # the gables, the roof standing 0.4 m out over them and over the eaves
    for u, sgn, foot in ((u0, -1, UPPER[4] - 0.3), (u1, 1, SE_BLOCK[4] - 0.5)):
        m.poly('white', [(u, foot, v0), (u, foot, v1), (u, HALL_EAVE, v1), (u, HALL_EAVE, v0)], (sgn, 0, 0))
        m.poly('white', [(u, HALL_EAVE, v0), (u, HALL_EAVE, v1), (u, HALL_RIDGE, vm)], (sgn, 0, 0))
    sign(m, (u0, vm - 4.0), (u0, vm + 4.0), 18.25, 19.25, 1, (-1, 0))
    o = 0.4
    drop = o * (HALL_RIDGE - HALL_EAVE) / (vm - v0)
    for sgn, ve in ((-1, v0 - o), (1, v1 + o)):
        m.poly('roof', [(u0 - o, HALL_EAVE - drop, ve), (u1 + o, HALL_EAVE - drop, ve), (u1 + o, HALL_RIDGE, vm), (u0 - o, HALL_RIDGE, vm)], UP + (0, 0, sgn))
        m.poly('painted', [(u0 - o, HALL_EAVE - drop - 0.3, ve), (u1 + o, HALL_EAVE - drop - 0.3, ve), (u1 + o, HALL_EAVE - drop, ve), (u0 - o, HALL_EAVE - drop, ve)],
               (0, 0, sgn), color=FELT)
        m.poly('painted', [(u0 - o, HALL_EAVE - drop - 0.3, ve), (u1 + o, HALL_EAVE - drop - 0.3, ve), (u1 + o, HALL_EAVE - drop - 0.3, ve - sgn * o), (u0 - o, HALL_EAVE - drop - 0.3, ve - sgn * o)],
               -UP, color=WHITE)
    for u, sgn in ((u0 - o, -1), (u1 + o, 1)):  # the verges
        for ve, vs in ((v0 - o, 1), (v1 + o, -1)):
            m.poly('painted', [(u, HALL_EAVE - drop - 0.3, ve), (u, HALL_RIDGE - 0.3, vm), (u, HALL_RIDGE, vm), (u, HALL_EAVE - drop, ve)], (sgn, 0, 0), color=WHITE)
    # the ventilator along the ridge and its cowls
    m.box('painted', (u0 + 2, HALL_RIDGE - 0.4, vm - 1.4), (u1 - 7, HALL_VENT, vm + 1.4), color=FELT, skip=('b', 't'))
    m.poly('roof', [(u0 + 2, HALL_VENT, vm - 1.4), (u1 - 7, HALL_VENT, vm - 1.4), (u1 - 7, HALL_VENT, vm + 1.4), (u0 + 2, HALL_VENT, vm + 1.4)], UP)
    units(m, HALL_VENT, [(u - 0.5, u + 0.5, vm - 1.2, vm - 0.2, 0.6) for u in (100, 109, 113, 121.5, 131, 140.5, 150)], color=DOME)


def add_north_strip(m, hb):
    u0, u1, v0, v1, top = N_STRIP
    f = Facade(m, (u0, v0), (u1, v0), hb, top)
    first = HALL[0] + BAY - u0  # the piers stand on the hall's bays
    f.win(first / 2, first - 0.6, 0.3, 5.4, fill='glassd', panes=(3, 3), depth=0.4)
    f.bays(first, BAY, 14, [(0.3, 5.4, 4, 3)], pier=0.6, fill='glassd', depth=0.4)
    f.done()
    Facade(m, (u0, v1), (u0, v0), hb, top).done()
    flat_roof(m, rect_ring(u0, u1, v0, v1), top - 0.25, top)


def add_south_wing(m, hb):
    u0, u1, v0, v1, top = S_WING
    f = Facade(m, (u1, v1), (u0, v1), hb, top)
    n = round((u1 - u0) / BAY)
    for k in range(n):
        c = f.at(u0 + BAY * (k + 0.5))
        f.win(c, BAY - 0.6, 0.5, 1.5, panes=(4, 1))
        if k in (6, 7):  # behind the outside stair: its door, and the windows over the landing
            f.win(c, BAY - 0.6, 8.6, 11.2, panes=(4, 2))
            if k == 6:
                f.win(c, 1.8, 7.5, 8.4, fill='painted', color=FRAME_D)
        elif k < S_WING_GLASS:
            f.win(c, BAY - 0.6, 3.0, 5.8, panes=(4, 2))
            f.win(c, BAY - 0.6, 8.6, 11.2, panes=(4, 2))
        else:
            f.win(c, BAY - 0.6, 2.2, 6.4, panes=(4, 3))
            f.win(c, BAY - 0.6, 8.2, 11.4, panes=(4, 2))
    f.done()
    Facade(m, (u0, v1), (u0, v0), S_BLOCK[5] - 0.2, top).done()
    Facade(m, (u1, v0), (u1, v1), hb, top).done()
    flat_roof(m, rect_ring(u0, u1, v0, v1), top - 0.4, top)
    roof = top - 0.4
    # the ventilation on the roof: the main duct and its four branches, the units under the hall's wall, the row of vents
    units(m, roof, [(105.0, 157.0, 72.5, 73.5, 0.8)] + [(u - 0.45, u + 0.45, 73.5, 83.5, 0.7) for u in (107.0, 121.0, 136.5, 156.5)], color=DUCT)
    units(m, roof, [(99.0, 101.0, 67.2, 69.0, 1.0), (108.0, 110.0, 67.2, 69.0, 1.0), (122.0, 124.0, 67.2, 69.0, 1.0), (133.5, 140.0, 66.9, 70.0, 1.6),
                    (143.0, 145.0, 67.2, 69.0, 1.0), (149.5, 151.5, 67.2, 69.0, 1.0)])
    domes(m, roof, [(u, 71.0) for u in np.arange(99.0, 160.0, 4.7)], r=0.5)
    # the steel stair to the park: a landing at the upper foyer's door, a flight east along the wall, and two small canopies over the lower doors
    y = 7.4
    m.box('painted', (123.8, y - 0.12, v1), (127.6, y, v1 + 1.9), color=STEEL)
    run = (y - hb) * 1.45
    for a, b in ((v1 + 0.1, v1 + 1.8),):
        m.poly('painted', [(127.6, y, a), (127.6, y, b), (127.6 + run, hb, b), (127.6 + run, hb, a)], UP, color=STEEL)
        m.poly('painted', [(127.6, y - 0.12, a), (127.6, y - 0.12, b), (127.6 + run, hb - 0.12, b), (127.6 + run, hb - 0.12, a)], -UP, color=FRAME_D)
    for v in (v1 + 0.1, v1 + 1.85):
        m.poly('painted', [(123.8, y + 0.95, v), (127.6, y + 0.95, v), (127.6, y + 1.0, v), (123.8, y + 1.0, v)], (0, 0, 1), color=FRAME_D)
        m.poly('painted', [(127.6, y + 0.95, v), (127.6 + run, hb + 0.95, v), (127.6 + run, hb + 1.0, v), (127.6, y + 1.0, v)], (0, 0, 1), color=FRAME_D)
    for u in (124.0, 127.4):
        m.box('painted', (u - 0.06, hb, v1 + 1.75), (u + 0.06, y, v1 + 1.87), color=FRAME_D, skip=('t', 'b'))
    for a, b in ((110.0, 114.0), (153.0, 157.0)):
        m.box('painted', (a, 2.9, v1), (b, 3.08, v1 + 2.2), color=WHITE)
        for u in (a + 0.15, b - 0.15):
            m.box('painted', (u - 0.05, hb, v1 + 2.0), (u + 0.05, 2.9, v1 + 2.1), color=WHITE, skip=('t', 'b'))


def add_tower(m, hb):
    u0, u1, v0, v1 = TOWER
    b0, b1 = TOWER_BAND
    top = lambda v: TOWER_EAVE + 0.3 + (TOWER_RIDGE - TOWER_EAVE) * min(1.0, (v - v0) / (b0 - v0), (v1 - v) / (v1 - b1))
    for a, b in (((u0, v0), (u1, v0)), ((u1, v1), (u0, v1))):
        Facade(m, a, b, 6.0, TOWER_EAVE + 0.3, 'concrete').done()
    for u, sgn, mat, foot in ((u0, -1, 'concrete', HALL_EAVE - 0.5), (u1, 1, 'white', E_LOW[5] - 0.3)):
        pts = [(u, foot, v0), (u, foot, v1)] + [(u, top(v), v) for v in (v1, b1, b0, v0)]
        m.poly(mat, pts, (sgn, 0, 0))
    # the roof: two slopes up to the flat band, whose smoke vents lie in three rows
    for a, b, ha, hb_ in ((v0, b0, TOWER_EAVE, TOWER_RIDGE), (b0, b1, TOWER_RIDGE, TOWER_RIDGE), (b1, v1, TOWER_RIDGE, TOWER_EAVE)):
        m.poly('roof', [(u0 + .3, ha, a), (u1 - .3, ha, a), (u1 - .3, hb_, b), (u0 + .3, hb_, b)], UP)
    for u, sgn in ((u0 + .3, 1), (u1 - .3, -1)):  # the gable walls' backs, above the roof
        m.poly('concrete', [(u, TOWER_EAVE, v0), (u, TOWER_EAVE, v1)] + [(u, top(v), v) for v in (v1, b1, b0, v0)], (sgn, 0, 0))
    for k in range(7):
        for j in range(3):
            a, b = 166.6 + k * 2.4, b0 + 0.25 + j * 1.5
            m.box('painted', (a, TOWER_RIDGE, b), (a + 2.1, TOWER_RIDGE + 0.3, b + 1.3), color=SKY, skip=('b',))
    # the east face: the tile picture, the catwalks before it, the letters over it
    pv0, pv1, ph0, ph1 = PICTURE_BOX
    for j, line in enumerate(PICTURE):
        for i, c in enumerate(line):
            a, b = pv0 + (pv1 - pv0) * i / 10, pv0 + (pv1 - pv0) * (i + 1) / 10
            c0, c1 = ph0 + (ph1 - ph0) * j / 10, ph0 + (ph1 - ph0) * (j + 1) / 10
            m.poly('painted', [(u1 + 0.03, c1, a), (u1 + 0.03, c1, b), (u1 + 0.03, c0, b), (u1 + 0.03, c0, a)], (1, 0, 0), color=TILES[c])
    for h in CATWALKS:
        m.box('painted', (u1, h - 0.06, pv1), (u1 + 0.5, h + 0.06, pv0), color=DARK)
    sign(m, (u1, 51.0), (u1, 47.0), 26.9, 27.9, 2, (1, 0))


def add_ne_block(m, hb):
    u0, u1, v0, v1, top = NE_BLOCK
    f = Facade(m, (u0, v0), (u1, v0), hb, top)
    for u in (184.8, 181.0, 177.2, 173.5, 169.7, 166.2):
        f.win(f.at(u), 0.7, 10.4, 11.1, panes=(1, 1), depth=0.15)
    for u in (181.0, 173.5, 169.7):
        f.win(f.at(u), 0.8, 1.8, 2.5, panes=(1, 1), depth=0.15)
    f.win(f.at(178.5), 2.0, 0.1, 2.3, fill='painted', color=STEEL, depth=0.12)
    f.win(f.at(166.6), 2.2, 0.3, 4.2, fill='painted', color=DOOR_BLUE, depth=0.2)
    f.done()
    Facade(m, (u1, v0), (u1, v1), hb, top).done()
    Facade(m, (u0, v1), (u0, v0), N_STRIP[4] - 0.3, top).done()
    flat_roof(m, rect_ring(u0, u1, v0, v1), top - 0.4, top)


def add_east_low(m, hb):
    u0, u1, v0, v1, soffit, top = E_LOW
    f = Facade(m, (u1, v0), (u1, v1), soffit, top)
    f.win(f.at(56.5), 3.0, 5.0, 6.0, panes=(2, 1))
    f.done()
    Facade(m, (u0, v0), (u1, v0), soffit, top).done()
    flat(m, 'painted', rect_ring(u0, u1, v0, v1), soffit, color=WHITE, down=True)
    flat_roof(m, rect_ring(u0, u1, v0, v1), top - 0.25, top)
    # open under it: posts along the front, a dark wall set back
    for k in range(6):
        v = v0 + 0.2 + k * (v1 - v0 - 0.4) / 5
        m.box('painted', (u1 - 0.35, hb, v - 0.15), (u1 - 0.05, soffit, v + 0.15), color=WHITE, skip=('t', 'b'))
    m.poly('painted', [(u0 + 1.6, hb, v0), (u0 + 1.6, hb, v1), (u0 + 1.6, soffit, v1), (u0 + 1.6, soffit, v0)], (1, 0, 0), color=FRAME_D)
    m.poly('painted', [(u0 + 1.6, hb, v0), (u1, hb, v0), (u1, soffit, v0), (u0 + 1.6, soffit, v0)], (0, 0, -1), color=FRAME_D)
    units(m, top - 0.25, [(190.2, 191.8, v - 0.6, v + 0.6, 0.9) for v in (41.5, 46.2, 50.8, 55.4, 60.0)])


def add_south_east(m, hb):
    u0, u1, v0, v1, top = SE_BLOCK
    fs = faces(m, rect_ring(u0, u1, v0, v1), hb, top, skip=(0, 3))
    finish(fs)
    flat_roof(m, rect_ring(u0, u1, v0, v1), top - 0.4, top)
    bu0, bu1, bv0, bv1, btop = SE_BOX
    m.box('white', (bu0, top - 0.4, bv0), (bu1, btop, bv1), skip=('b', 't'))
    flat(m, 'roof', rect_ring(bu0, bu1, bv0, bv1), btop)
    units(m, top - 0.4, [(165.6 + i * 2.2, 167.2 + i * 2.2, 64.0 + j * 2.6, 65.6 + j * 2.6, 0.5) for i in range(3) for j in range(4)], color=DOME)
    # the glazed lean-to in the corner towards the park
    wu0, wu1, wv0, wv1, head, eave = WINTER
    m.poly('glass', [(wu0, head, wv0), (wu1, eave, wv0), (wu1, eave, wv1), (wu0, head, wv1)], UP, uvs=[(0, 0), (5, 0), (5, 11), (0, 11)])
    east = WallFrame((wu1, wv0), (wu1, wv1))
    glazing(m, east, 0, east.length, hb, eave, 'glass', 11, 2)
    m.poly('glass', [(wu1, hb, wv1), (wu0, hb, wv1), (wu0, head, wv1), (wu1, eave, wv1)], (0, 0, 1), uvs=[(0, 0), (5, 0), (5, 3.5), (0, 2)])


def add_east_wing(m, hb):
    u0, u1, v0, v1, top = E_WING
    rows = [(a, b, 4, 2) for a, b in E_WING_ROWS]
    north = Facade(m, (u0, v0), (u1, v0), hb, top)
    north.bays(north.at(E_WING_PIER + 5 * BAY), BAY, 4, rows, pier=0.5)
    south = Facade(m, (u1, v1), (u0, v1), hb, top)
    south.bays(south.at(E_WING_PIER + 9 * BAY), BAY, 8, rows, pier=0.5)
    east = Facade(m, (u1, v0), (u1, v1), hb, top)
    for a, b in ((0.8, 1.6), (3.3, 4.1), (6.3, 7.1)):
        east.win(east.at(64.4), 0.8, a, b, panes=(1, 1), depth=0.15)
    finish([north, south, east])
    # a low hipped roof behind the fascia
    e, r, vm, hip = top - 0.3, top + 0.4, (v0 + v1) / 2, 4.2
    ring = rect_ring(u0, u1, v0, v1)
    inner = offset_ring(ring, -0.3)
    for i in range(4):
        a, b, ia, ib = ring[i], ring[(i + 1) % 4], inner[i], inner[(i + 1) % 4]
        m.poly('white', [(a[0], top, a[1]), (b[0], top, b[1]), (ib[0], top, ib[1]), (ia[0], top, ia[1])], UP)
    (a0, b0), (a1, b1) = inner[0], inner[2]
    m.poly('roof', [(a0, e, b0), (a1, e, b0), (a1 - hip, r, vm), (a0 + hip, r, vm)], UP + (0, 0, -1))
    m.poly('roof', [(a0, e, b1), (a1, e, b1), (a1 - hip, r, vm), (a0 + hip, r, vm)], UP + (0, 0, 1))
    m.poly('roof', [(a0, e, b0), (a0, e, b1), (a0 + hip, r, vm)], UP + (-1, 0, 0))
    m.poly('roof', [(a1, e, b0), (a1, e, b1), (a1 - hip, r, vm)], UP + (1, 0, 0))


# ------------------------------------------------------------------------------------------------------------------- the 1953 front building
def add_upper(m, hb):
    u0, u1, v0, v1, top = UPPER
    west = Facade(m, (u0, v1), (u0, v0), FOYER_TOP - 0.3, top)
    for a, b in ((28.5, 32.0), (33.0, 37.3), (37.8, 42.0), (42.3, 46.5), (47.0, 51.0), (61.0, 65.0), (65.5, 69.5)):
        west.win(west.at((a + b) / 2), b - a, 9.0, 10.8, panes=(3, 2))
    west.done()
    sign(m, (u0, 40.0), (u0, 58.0), 11.0, 12.1, 0, (-1, 0))
    Facade(m, (u0, v0), (u1, v0), N_STRIP[4] - 0.3, top).done()
    flat_roof(m, rect_ring(u0, u1, v0, v1), top - 0.3, top)
    bu0, bu1, bv0, bv1, btop = UPPER_BOX
    m.box('white', (bu0, top - 0.3, bv0), (bu1, btop, bv1), skip=('b', 't'))
    flat(m, 'roof', rect_ring(bu0, bu1, bv0, bv1), btop)
    units(m, top - 0.3, [(84.0, 86.0, 33.0, 35.0, 1.0), (79.8, 81.8, 46.0, 50.0, 1.2), (83.0, 86.0, 56.0, 61.0, 1.4), (87.5, 89.5, 49.5, 52.5, 0.9)])
    units(m, top - 0.3, [(79.3, 79.7, 30.0, 68.0, 0.35)], color=WHITE)
    domes(m, top - 0.3, [(86.5, 40.5), (86.5, 43.5), (86.5, 46.5), (86.5, 54.0), (86.5, 57.0), (89.5, 64.0), (89.5, 67.0), (82.5, 64.5), (82.5, 67.5)])
    # the room between it and the north wing
    nu0, nu1, nv0, nv1, ntop = NW_ROOM
    finish(faces(m, rect_ring(nu0, nu1, nv0, nv1), hb, ntop))
    flat_roof(m, rect_ring(nu0, nu1, nv0, nv1), ntop - 0.3, ntop)


def add_south_block(m, hb):
    u0, u1, v0, v1, mid, top = S_BLOCK
    rows = [(0.3, 1.3, 4, 1)]
    south = Facade(m, (u1, v1), (u0, v1), hb, mid)
    pitch = (u1 - u0 - 0.2) / 6
    south.bays(0.1, pitch, 6, rows, fill='glassd')
    south.bays(0.1, pitch, 6, [(2.2, 5.8, 4, 2)], fill='glassd', spandrel=0.9)
    west = Facade(m, (u0, v1), (u0, LINK[3]), hb, mid)
    wp = (v1 - LINK[3]) / 3
    west.bays(0.0, wp, 3, rows, fill='glassd')
    west.bays(0.0, wp, 3, [(2.2, 5.8, 4, 2)], fill='glassd', spandrel=0.9)
    north = Facade(m, (u0, v0), (UPPER[0], v0), FOYER_TOP - 0.3, mid)  # over the foyer's roof
    finish([south, west, north, Facade(m, (u1, S_WING[3]), (u1, v1), hb, mid)])
    # the terrace's edge, and the glazed storey set back on it
    s = 0.8
    ring = rect_ring(u0, u1, v0, v1)
    upper = [(u0 + s, v0), (u1, v0), (u1, v1 - s), (u0 + s, v1 - s)]
    for a, b, c, d in ((ring[3], ring[2], upper[2], upper[3]), (ring[0], ring[3], upper[3], upper[0])):
        m.poly('white', [(a[0], mid, a[1]), (b[0], mid, b[1]), (c[0], mid, c[1]), (d[0], mid, d[1])], UP)
    for a, b in ((upper[2], upper[3]), (upper[3], upper[0]), (upper[0], (UPPER[0], v0))):
        w = WallFrame(a, b)
        glazing(m, w, 0, w.length, mid, top - 0.35, 'glassd', round(w.length / 1.15), 2)
        m.wbox('painted', w, -0.05, w.length + 0.05, top - 0.35, top, -0.05, 0.08, color=FRAME_D)
    flat(m, 'roof', upper, top)


def add_link(m, hb):
    u0, u1, v0, v1, top = LINK
    for a, b in (((u0, v0), (u1, v0)), ((u1, v1), (u0, v1))):
        f = Facade(m, a, b, hb, top)
        f.win(f.w.length / 2, f.w.length - 0.5, G_W + 0.2, 4.9, fill='glassd', panes=(5, 2))
        f.win(f.w.length / 2, f.w.length - 0.5, 5.6, 8.6, fill='glassd', panes=(5, 2))
        f.done()
    flat(m, 'roof', rect_ring(u0, u1, v0, v1), top)
    for v in (v0 + 0.05, v1 - 0.05):
        m.poly('painted', [(u0, top + 0.9, v), (u1, top + 0.9, v), (u1, top + 0.95, v), (u0, top + 0.95, v)], (0, 0, 1), color=FRAME_D)


def add_foyer(m, hb):
    fs = faces(m, FOYER, hb, FOYER_TOP, skip=(1, 3, 4))
    for i in (5, 6):  # the glass towards the plaza, under a white fascia
        f = fs[i]
        n = round(f.w.length / 3.0)
        f.bays(0.0, f.w.length / n, n, [(G_W + 0.1, 4.7, 3, 2)], pier=0.3, fill='glassd')
    finish(fs)
    flat_roof(m, FOYER, FOYER_TOP - 0.3, FOYER_TOP)
    domes(m, FOYER_TOP - 0.3, [(61.5, 53.5), (62.2, 56.2), (60.0, 58.8), (62.3, 60.8), (62.3, 63.2), (62.3, 66.5), (65.0, 51.0), (69.5, 44.0), (72.0, 38.0), (72.0, 32.0), (70.0, 58.0),
                               (72.5, 64.0), (66.0, 69.5)])
    # the entrance: a dark canopy on two posts, in the middle of the slanting front
    w = fs[5].w
    c = w.length * 0.3  # nearer Europahallen, as the photos have it
    m.wbox('painted', w, c - 3.6, c + 3.6, 3.7, 4.0, 0.0, 3.2, color=FRAME_D)
    for s in (c - 3.4, c + 3.4):
        m.wbox('painted', w, s - 0.08, s + 0.08, hb, 3.7, 3.0, 3.16, color=FRAME_D, top=False)
    m.wbox('painted', w, c - 2.2, c + 2.2, G_W, 3.6, 0.0, 0.06, color=DARK, top=False)


def add_north_wing(m, hb):
    fs = faces(m, N_WING, hb, N_WING_TOP)
    rows = [(a, b, 4, 1) for a, b in N_WING_ROWS]
    for i in (0, 2):
        f = fs[i]
        f.bays(0.2, (f.w.length - 0.4) / 6, 6, rows, pier=0.7)
    for a, b in N_WING_ROWS[1:]:
        fs[3].win(fs[3].w.length / 2, 2.0, a, b, panes=(2, 1))
    finish(fs)
    flat_roof(m, N_WING, N_WING_TOP - 0.3, N_WING_TOP)
    cu, cv = np.mean(N_WING, axis=0)
    units(m, N_WING_TOP - 0.3, [(cu - 6, cu - 4.5, cv - 0.6, cv + 0.6, 0.7), (cu + 5, cu + 6.2, cv + 0.5, cv + 1.7, 0.6)])


# ----------------------------------------------------------------------------------------------------------------------- Europahallen (1990)
def west_u(v):
    """The west wall's u at v: it leans towards Vesterbro."""
    (u0, v0), (u1, v1) = EURO[0], EURO[-1]
    return u0 + (u1 - u0) * (v - v0) / (v1 - v0)


def add_europahallen(m, hb):
    fs = faces(m, EURO, hb, EURO_TOP)
    south = fs[5]
    lo, hi = EURO_BAY_H
    for a, b in EURO_BAYS:
        south.win(south.at((a + b) / 2), b - a, lo, hi, fill='glassd', panes=(4, 6), depth=0.3)
    south.pentagon(south.at(47.0), 1.0, G_W + 0.1, 3.3, 3.9)
    south.pentagon(south.at(47.0), 0.8, 8.4, 8.9, 9.3, depth=0.2)
    fs[0].pentagon(3.0, 1.0, G_W + 0.1, 3.3, 3.9)
    finish(fs)
    flat_roof(m, EURO, EURO_TOP - 0.35, EURO_TOP)
    sign(m, (15.2, 80.3), (31.5, 80.3), 10.4, 11.4, 0, (0, 1))
    n0 = fs[0].w
    sign(m, tuple(n0.a + n0.t2 * 12.3), tuple(n0.a + n0.t2 * 1.2), 10.8, 11.5, 0, tuple(n0.n2))
    # the dark line under the parapet, round the white walls
    for i in (0, 5, 6, 7, 8, 9, 10, 11):
        w = fs[i].w
        m.poly('painted', [w.p(0, 11.45, 0.02), w.p(w.length, 11.45, 0.02), w.p(w.length, 11.6, 0.02), w.p(0, 11.6, 0.02)], w.n, color=FRAME_D)
    # the west front: the terracotta relief under its arched head
    w = fs[11].w
    s0, s1 = w.length - 14.5, w.length - 6.2
    pts = [w.p(s0, 2.0, 0.06), w.p(s1, 2.0, 0.06)] + [w.p(s1 + (s0 - s1) * k / 8, 8.6 + 0.9 * math.sin(math.pi * k / 8), 0.06) for k in range(9)]
    m.poly('painted', pts, w.n, color=TERRACOTTA)
    add_vault(m)
    add_lean_to(m, hb)
    add_drum(m, hb)
    roof = EURO_TOP - 0.35
    units(m, roof, [(24.5, 26.0, 42.5, 44.0, 0.6), (33.0, 34.2, 64.0, 65.0, 0.5), (42.0, 43.2, 64.0, 65.0, 0.5), (33.5, 34.7, 72.3, 73.3, 0.5), (42.0, 43.2, 72.3, 73.3, 0.5),
                    (20.8, 21.8, 65.0, 70.5, 1.0), (21.8, 27.0, 64.4, 64.9, 0.5)] + [(53.5, 54.5, 68.6 + k * 1.3, 69.6 + k * 1.3, 0.5) for k in range(5)]
          + [(36.0 + k * 1.1, 36.8 + k * 1.1, 54.6 + k * 1.1, 55.4 + k * 1.1, 0.4) for k in range(4)])
    for u, v in PLANTERS:
        m.cylinder('painted', u, v, 0.75, hb, G_W + 1.3, n=14, color=WHITE)
        m.poly('painted', [(u + 0.75 * math.cos(a), G_W + 1.3, v + 0.75 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 15)[:-1]], UP, color=WHITE)


def add_vault(m):
    """The ribbed metal vault over the west end of the roof, its west end an arched gable over the facade."""
    v0, v1, ue, spring, rise = VAULT
    half = (v1 - v0) / 2
    R = (half * half + rise * rise) / (2 * rise)
    vm = (v0 + v1) / 2
    ang = math.asin(half / R)
    n = 14
    prof = [(vm + R * math.sin(a), spring + R * math.cos(a) - (R - rise), R * (a + ang)) for a in np.linspace(-ang, ang, n + 1)]
    for (va, ha, la), (vb, hb_, lb) in zip(prof, prof[1:]):
        ua, ub = west_u(va), west_u(vb)
        na, nb = np.array([0, R * math.cos(math.asin((va - vm) / R)), va - vm]), np.array([0, R * math.cos(math.asin((vb - vm) / R)), vb - vm])
        m.poly('metal', [(ua, ha, va), (ue, ha, va), (ue, hb_, vb), (ub, hb_, vb)], UP, uvs=[(ua, la), (ue, la), (ue, lb), (ub, lb)], nors=[na, na, nb, nb])
    for u_of, sgn in ((west_u, -1), (lambda v: ue, 1)):
        pts = [(u_of(v), h, v) for v, h, _ in prof]
        for i in range(n):
            m.poly('white', [pts[i], pts[i + 1], (pts[i + 1][0], EURO_TOP - 0.35, pts[i + 1][2]), (pts[i][0], EURO_TOP - 0.35, pts[i][2])], (sgn, 0, 0))


def add_lean_to(m, hb):
    """The glass along the plaza: a glazed wall on the footprint's edge, and a glass roof from its head up to the body's parapet."""
    for (a, b), (ia, ib) in zip(zip(LEAN_OUT, LEAN_OUT[1:]), zip(LEAN_IN, LEAN_IN[1:])):
        w = WallFrame(a, b)
        cols = round(w.length / 1.25)
        glazing(m, w, 0, w.length, hb, LEAN_EAVE, 'glass', cols, 3)
        m.wbox('painted', w, 0, w.length, LEAN_EAVE - 0.1, LEAN_EAVE + 0.12, -0.08, 0.1, color=WHITE)
        m.wbox('painted', w, 0, w.length, (LEAN_EAVE + G_W) / 2 - 0.08, (LEAN_EAVE + G_W) / 2 + 0.08, -0.04, 0.06, color=WHITE, top=False)
        m.poly('skyglass', [(a[0], LEAN_EAVE, a[1]), (b[0], LEAN_EAVE, b[1]), (ib[0], LEAN_HEAD, ib[1]), (ia[0], LEAN_HEAD, ia[1])], UP + w.n,
               uvs=[(0, 0), (cols, 0), (cols, 4), (0, 4)])
    # its east end, glazed over the foyer's roof
    (a, ia), y = (LEAN_OUT[-1], LEAN_IN[-1]), FOYER_TOP - 0.3
    m.poly('glass', [(a[0], y, a[1]), (a[0], y, ia[1]), (a[0], LEAN_HEAD, ia[1]), (a[0], LEAN_EAVE, a[1])], (1, 0, 0), uvs=[(0, 0), (4, 0), (4, 4), (0, 1)])


def add_drum(m, hb):
    """The glazed stair on the south front, a white band at its head."""
    cu, cv, r, top = DRUM
    n = 16
    for i in range(n):
        a0, a1 = i / n * 2 * math.pi, (i + 1) / n * 2 * math.pi
        n0, n1 = np.array([math.cos(a0), 0, math.sin(a0)]), np.array([math.cos(a1), 0, math.sin(a1)])
        q = lambda a, h, rr=r: (cu + rr * math.cos(a), h, cv + rr * math.sin(a))
        m.poly('glass', [q(a0, hb), q(a1, hb), q(a1, top - 0.5), q(a0, top - 0.5)], n0 + n1, nors=[n0, n1, n1, n0], uvs=[(i, 0), (i + 1, 0), (i + 1, 8), (i, 8)])
        m.poly('white', [q(a0, top - 0.5, r + .04), q(a1, top - 0.5, r + .04), q(a1, top, r + .04), q(a0, top, r + .04)], n0 + n1, nors=[n0, n1, n1, n0])
    m.poly('painted', [(cu + (r + .04) * math.cos(a), top, cv + (r + .04) * math.sin(a)) for a in np.linspace(0, 2 * math.pi, n + 1)[:-1]], UP, color=FELT)


def build(hb=-1.0):
    """The centre's model in its own frame. hb: how far its walls go down."""
    m = Model()
    add_hall(m, hb)
    add_north_strip(m, hb)
    add_south_wing(m, hb)
    add_tower(m, hb)
    add_ne_block(m, hb)
    add_east_low(m, hb)
    add_south_east(m, hb)
    add_east_wing(m, hb)
    add_upper(m, hb)
    add_south_block(m, hb)
    add_link(m, hb)
    add_foyer(m, hb)
    add_north_wing(m, hb)
    add_europahallen(m, hb)
    return m


def plan_rings():
    """The outlines of the model's parts that stand on the ground (u, v): what its footprint is compared by."""
    r = lambda p: rect_ring(*p[:4])
    return [r(HALL), r(N_STRIP), r(S_WING), r(TOWER), r(NE_BLOCK), r(E_LOW), r(SE_BLOCK), r(E_WING), r(UPPER), r(S_BLOCK), r(LINK), FOYER, r(NW_ROOM), N_WING,
            EURO, LEAN_OUT + LEAN_IN[::-1]]


# ------------------------------------------------------------------------------------------------------------------------------------- textures
TONES = {'white': (0.86, 0.86, 0.85), 'concrete': (0.63, 0.63, 0.61), 'roof': (0.31, 0.32, 0.37), 'metal': (0.80, 0.81, 0.82)}


def tiled(tone, seed, grain=0.03, wash=0.06, stretch=(1.0, 1.0), n=256):
    lum = 1 + wash * periodic_noise(n, 1.7, seed, stretch=stretch, low=1) + grain * periodic_noise(n, 0.5, seed + 1, low=16)
    return lum[..., None] * np.array(albedo(tone))


def white_texture(n=256):
    """White-painted concrete and render: pale, with the run-off that streaks down it."""
    return to_image(np.clip(tiled(TONES['white'], 41, grain=0.02, wash=0.045, stretch=(1.0, 0.2), n=n), 0, 1))


def concrete_texture(n=256):
    """The stage tower's grey panels, 2.3 m wide and high in a repeat of 4.6 m, weathered from the top."""
    rs = np.random.default_rng(43)
    img = tiled(TONES['concrete'], 43, grain=0.035, wash=0.1, stretch=(1.0, 0.15), n=n)
    y, x = np.mgrid[0:n, 0:n] + .5
    img *= (1 + .03 * rs.normal(0, 1, (2, 2)))[(y / n * 2).astype(int) % 2, (x / n * 2).astype(int) % 2][..., None]
    for c in (x, y):
        f = c / n * 2 % 1
        img[np.minimum(f, 1 - f) < 0.012] *= 0.8
    return to_image(np.clip(img, 0, 1))


def roof_texture(n=256):
    return to_image(np.clip(tiled(TONES['roof'], 45, grain=0.07, wash=0.04, n=n), 0, 1))


def metal_texture(n=256):
    """The vault's ribbed metal: a standing rib every 0.5 m of the 2 m repeat."""
    img = tiled(TONES['metal'], 47, grain=0.015, wash=0.04, n=n)
    x = (np.arange(n) + .5) / n * 4 % 1
    prof = 0.86 + 0.2 * np.exp(-((np.minimum(x, 1 - x)) / 0.07) ** 2) - 0.2 * np.exp(-((np.minimum(x, 1 - x) - 0.11) / 0.05) ** 2)
    img *= prof[None, :, None]
    return to_image(np.clip(img, 0, 1))


def pane_texture(pane, frame, seed, bar=0.045, shade=0.9, n=128):
    """One pane in its frame; the faces repeat it by their count of panes."""
    y, x = np.mgrid[0:n, 0:n] + .5
    fx, fy = x / n, y / n
    img = np.array(pane)[None, None] * (1 + shade * fy)[..., None] * (1 + .15 * periodic_noise(n, 1.3, seed, low=1))[..., None]
    img[(np.minimum(fx, 1 - fx) < bar) | (np.minimum(fy, 1 - fy) < bar)] = frame
    return to_image(np.clip(img, 0, 1))


def sign_texture(w=512, h=128):
    """The three pieces of lettering, dark on the wall's white, one per row of 32 px: 512, 256 and 128 px long."""
    try:
        font = ImageFont.load_default(size=64)
    except TypeError:  # Pillow before 10.1: its small bitmap font, scaled up
        font = ImageFont.load_default()
    ground = tuple(int(c) for c in np.asarray(to_image(np.array(albedo(TONES['white']))[None, None]))[0, 0])
    ink = (52, 54, 58)
    img = Image.new('RGB', (w, h), ground)
    for row, (text, length) in enumerate((('Aalborg Kongres & Kultur Center', 512), ('Aalborghallen', 256), ('AKKC', 128))):
        box = font.getbbox(text)
        line = Image.new('RGB', (box[2] - box[0] + 8, box[3] - box[1] + 8), ground)
        ImageDraw.Draw(line).text((4 - box[0], 4 - box[1]), text, font=font, fill=ink)
        img.paste(line.resize((length, 32), Image.LANCZOS), (0, row * 32))
    return img


TEXTURES = {
    'white': white_texture, 'concrete': concrete_texture, 'roof': roof_texture, 'metal': metal_texture, 'sign': sign_texture,
    'glass': lambda: pane_texture((0.028, 0.04, 0.06), albedo((0.86, 0.86, 0.85)), 51),
    'glassd': lambda: pane_texture((0.03, 0.045, 0.055), (0.05, 0.053, 0.06), 53),
    'skyglass': lambda: pane_texture(albedo((0.66, 0.74, 0.8)), albedo((0.88, 0.88, 0.87)), 55, bar=0.06, shade=0.12),
}
MATERIALS = {
    'white': dict(tile=(6.0, 6.0), roughness=0.9),
    'concrete': dict(tile=(4.6, 4.6), roughness=0.9),
    'roof': dict(tile=(8.0, 8.0), roughness=0.95),
    'metal': dict(tile=(2.0, 2.0), roughness=0.4, metallic=0.5),
    'glass': dict(tile=(1.0, 1.0), roughness=0.15, metallic=0.5),
    'glassd': dict(tile=(1.0, 1.0), roughness=0.15, metallic=0.5),
    'skyglass': dict(tile=(1.0, 1.0), roughness=0.2, metallic=0.3),
    'sign': dict(tile=(1.0, 1.0), roughness=0.9),
    'painted': dict(tile=None, roughness=0.7),
}
ATTRIBUTION = {
    'lod2-dhm-punktsky': {'text': 'LoD2 shells from DHM Punktsky, Klimadatastyrelsen (roof levels, eaves, ridges)', 'licence': 'CC BY 4.0', 'url': 'https://dataforsyningen.dk'},
    'skraafoto-2021': {'text': 'Skråfoto 2021, Klimadatastyrelsen (measurements and colours)', 'licence': 'CC BY 4.0 terms for free geographic data', 'url': 'https://dataforsyningen.dk'},
    'geodanmark': {'text': 'GeoDanmark Bygning (footprints)', 'licence': 'CC BY 4.0', 'url': 'https://www.geodanmark.dk'},
    'commons-lenz-2022': {'text': 'Leonhard Lenz, Aalborg Kongres- og Kulturcenter 2022-08-16 01-03, Wikimedia Commons (reference for the south fronts)', 'licence': 'CC0',
                          'url': 'https://commons.wikimedia.org/wiki/File:Aalborg_Kongres-_og_Kulturcenter_2022-08-16_01.jpg'},
    'commons-drlady-2016': {'text': 'Drlady, Aalborg Kongres & Kultur Center 01-02, Wikimedia Commons (reference only: no pixels, no measurements)', 'licence': 'CC BY-SA 4.0',
                            'url': 'https://commons.wikimedia.org/wiki/File:Aalborg_Kongres_%26_Kultur_Center_01.jpg'},
    'commons-liberaler-humanist-2018': {'text': 'Liberaler Humanist, Aalborg Kongres & Kultur Center seen from Prinsensgade, Wikimedia Commons (reference only: no pixels, no measurements)',
                                        'licence': 'CC BY-SA 3.0',
                                        'url': 'https://commons.wikimedia.org/wiki/File:Aalborg_Kongres_%26_Kultur_Center,_seen_from_Prinsensgade,_Photo_1,Aalborg.jpg'},
}


def twin_xz(u, v):
    a = math.radians(AXIS_DEG)
    return ORIGIN[0] + u * math.cos(a) - v * math.sin(a), ORIGIN[1] + u * math.sin(a) + v * math.cos(a)


def footprint_match(frame, cell=0.25):
    """IoU of the model's plan with the six GeoDanmark footprints it covers, on a 25 cm raster."""
    recs = frame.buildings(TILE)
    gdk = [flat_to_pts(recs[i]['ring']) for i in COVERS]
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
    recs = frame.buildings(TILE)
    low = min(frame.ground_low(recs[i]) for i in COVERS)
    hb = low - 0.25
    iou = footprint_match(frame)
    print(f'ground low {low:.2f}, footprint IoU {iou:.3f}')
    model = build(hb)
    body, mesh, lo, hi = model_to_glb(model, AXIS_DEG, (ORIGIN[0], 0.0, ORIGIN[1]), MATERIALS, TEXTURES, SET,
                                      root_extras={'building_id': GDK_ID, 'source_ids': list(ATTRIBUTION)[:3], 'attribution': list(ATTRIBUTION), 'confidence': 'observed'},
                                      asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                                      attribution=list(ATTRIBUTION), generator='tools/overrides/akkc.py')
    rel = 'meshes/gdk_1210731072.glb'
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    (out / rel).write_bytes(body)
    entry = {
        'tile': TILE, 'mode': 'replace', 'covers': COVERS, 'footprint': {'use': 'gdk'},
        'match': {'kind': 'split', 'iou': round(iou, 3), 'hausdorff': 1.0},
        'source': {'ids': list(ATTRIBUTION)[:3], 'kind': 'lod2-skraafoto', 'reconstruction': 'tools/overrides/akkc.py'},
        'confidence': 'observed', 'attribution': list(ATTRIBUTION),
        'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': recs[GDK_ID]['ground'], 'low': round(low, 2), 'sunk': 0.25,
        'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
    }
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': {GDK_ID: entry}})
    print(f'{out}: {mesh["triangles"]} triangles, {len(body) / 1e6:.2f} MB GLB, {mesh["textureBytes"] / 1e6:.1f} MB textures, top {hi[1]:.2f}')


if __name__ == '__main__':
    main()
