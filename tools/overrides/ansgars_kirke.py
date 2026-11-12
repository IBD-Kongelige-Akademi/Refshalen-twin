#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Ansgars Kirke (Vesterbro 1A, Aalborg): a detail override built from the architect's drawings of 1925 (docs/ansgars-kirke.md).

Every measure below is read from three sheets at 1:100: the side towards Hobrovejen (east, PDF page 38), the sides towards north and south (page 33)
and the first project's sides (page 32, which also gives the west side). The GeoDanmark footprint and the 2021 Skraafoto flight only place it and
colour it: the outline of the eaves lies within 0.2 m of the footprint.

The model is in the church's own frame while it is built: u east along the nave, v south across it, h up from the drawings' grade (kote 6.75), with the
crossing at u = v = 0. `to_local` puts it in the twin's frame.

    PYTHONUTF8=1 uv run tools/overrides/ansgars_kirke.py [--data data] [--out DIR]
    PYTHONUTF8=1 uv run tools/overrides/publish.py install --sets ~/.local/share/cph-twin/overrides/ansgars-kirke
"""
from __future__ import annotations

import argparse, hashlib, math, sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from overrides_lib import SOURCE_FORMAT, TwinFrame, write_json
from override_model import (Model, UP, WallFrame, albedo, arch, circle, half_width, model_to_glb, periodic_noise, rect, rgb, to_image)

SET = 'ansgars-kirke'
GDK_ID = 'gdk:1018922375'
TILE = '1110_12645'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET

# The church in the twin's frame. The axis and the crossing are the GeoDanmark footprint's: all its edges lie at 13.6 degrees, and the middle of its north
# and south arms is 0.55 m west of the middle of its box.
AXIS_DEG = 13.62
CROSSING = (-749.27, 525.21)
# Local height of h = 0. The drawings' kote 8.20 (top of the plinth, 1.45 m above their grade), less the twin's origin height of 3.85 m, gives 2.90. Their
# datum is not today's: the surface model puts all five ridges and the domes 0.3 to 0.45 m lower than that, so the church is set 0.3 m down.
GRADE_Y = 8.20 - 1.45 - 3.85 - 0.3


def to_local(u, h, v):
    """Church frame -> the twin's local frame (x east, y up, z south). A rotation about the vertical, so it keeps handedness."""
    a = math.radians(AXIS_DEG)
    ca, sa = math.cos(a), math.sin(a)
    return np.array([CROSSING[0] + u * ca - v * sa, GRADE_Y + h, CROSSING[1] + u * sa + v * ca])


# ------------------------------------------------------------------------------------------------------------------------- the drawings' measures
WALL_TOP = 12.0
EAVE = 12.1  # sheet 33: the tip of the eaves
RIDGE = 19.1
EAVE_OUT = 0.5  # how far the eaves stand out from the walls
ARM_HALF = 5.7  # half the width of an arm, wall to wall
NORTH, SOUTH = -16.85, 16.85  # the ends of the arms
WEST, EAST = -16.6, 17.57
BAY_V = 11.25  # the outer walls of the four corner bays under the domes
BAY_E, BAY_W = 11.4, -11.2
PLINTH = 1.45
TOWER_U, TOWER_HALF = 14.12, 4.03
PORTICO_U = 20.15
WIN_W, WIN_SILL, WIN_TOP = 1.75, 4.06, 9.6
BASE_W = 1.57
DOME_U, DOME_V, DOME_HALF, DOME_BASE, DOME_TOP = 7.85, 8.0, 2.92, 13.1, 16.4
COLUMN_U, COLUMNS_V = 19.16, (-2.5, 2.5)  # the entrance's two columns (sheets 33 and 38)

# The outline of the walls, clockwise seen from above, from the north arm's north-west corner.
WALL_RING = [(-ARM_HALF, NORTH), (ARM_HALF, NORTH), (ARM_HALF, -BAY_V), (BAY_E, -BAY_V), (BAY_E, -ARM_HALF), (EAST, -ARM_HALF), (EAST, ARM_HALF), (BAY_E, ARM_HALF),
             (BAY_E, BAY_V), (ARM_HALF, BAY_V), (ARM_HALF, SOUTH), (-ARM_HALF, SOUTH), (-ARM_HALF, BAY_V), (BAY_W, BAY_V), (BAY_W, ARM_HALF), (WEST, ARM_HALF),
             (WEST, -ARM_HALF), (BAY_W, -ARM_HALF), (BAY_W, -BAY_V), (-ARM_HALF, -BAY_V)]

# What stands in which wall: edge index in WALL_RING -> where along the wall (u or v of the church frame).
ARCHED = {0: (-2.3, 2.3), 2: (7.85,), 18: (-7.82,), 16: (-13.3,),  # north
          1: (-13.6,), 3: (-8.08,), 7: (8.08,), 9: (13.6,),  # east
          10: (2.37, -2.37), 8: (7.72,), 12: (-7.85,), 14: (-13.3,),  # south
          11: (13.6,), 13: (8.08,), 17: (-8.08,), 19: (-13.6,)}  # west
BASEMENT_NORTH = {0: (-2.3, 2.3), 18: (-7.82,), 16: (-13.3,), 1: (-13.6,), 3: (-8.08,), 17: (-8.08,), 19: (-13.6,)}
BASEMENT_SOUTH = {10: (2.37, -2.37), 8: (7.72,), 12: (-7.85,), 14: (-13.3,), 7: (8.08,), 9: (13.6,), 11: (13.6,), 13: (8.08,)}

# material -> size in metres of one repeat of its texture (None: vertex colours)
TILE_M = {'tile': (9.6, 9.6), 'wall': (5.28, 5.28), 'stone': (2.0, 2.0), 'copper': (4.0, 4.0), 'dome': (4.0, 4.0), 'glass': (1.74, 1.98), 'painted': None}


GOLD, DARK, CLOCK, DOOR, LOUVRE = rgb(.72, .56, .24), rgb(.06, .06, .07), rgb(.86, .85, .8), rgb(.20, .25, .19), rgb(.17, .17, .16)
LEAD = rgb(.47, .47, .46)  # the tops of the cornices, the bays' decks and the domes' attics are grey in the photographs


# ---------------------------------------------------------------------------------------------------------------------------------------- the church
def add_roof(m):
    """The cross of tile roofs: four arms, each with a hip end, whose ridges meet over the crossing. The foot of every slope kicks out (sheet 33)."""
    w = ARM_HALF + EAVE_OUT
    levels = [(0.0, 0.0), (0.7, 0.42), (1.6, 1.05), (w, RIDGE - EAVE)]
    arms = [((0, -1), -NORTH + EAVE_OUT), ((0, 1), SOUTH + EAVE_OUT), ((1, 0), EAST + EAVE_OUT), ((-1, 0), -WEST + EAVE_OUT)]
    slope = [0.0]
    for (d0, r0), (d1, r1) in zip(levels, levels[1:]):
        slope.append(slope[-1] + math.hypot(d1 - d0, r1 - r0))
    for (dx, dz), L in arms:
        D, P = np.array([dx, 0, dz], float), np.array([-dz, 0, dx], float)
        pt = lambda a, b, r: tuple(D * a + P * b + UP * (EAVE + r))
        for k in range(len(levels) - 1):
            (d0, r0), (d1, r1) = levels[k], levels[k + 1]
            sa, sb = slope[-1] - slope[k], slope[-1] - slope[k + 1]
            for sgn in (-1, 1):
                pts = [pt(w - d0, sgn * (w - d0), r0), pt(L - d0, sgn * (w - d0), r0), pt(L - d1, sgn * (w - d1), r1), pt(w - d1, sgn * (w - d1), r1)]
                uvs = [(w - d0, sa), (L - d0, sa), (L - d1, sb), (w - d1, sb)]
                m.poly('tile', pts, UP, uvs=uvs)
            pts = [pt(L - d0, -(w - d0), r0), pt(L - d0, w - d0, r0), pt(L - d1, w - d1, r1), pt(L - d1, -(w - d1), r1)]
            m.poly('tile', pts, UP, uvs=[(-(w - d0), sa), (w - d0, sa), (w - d1, sb), (-(w - d1), sb)])
        # ridge and hips get a row of ridge tiles
        ridge_cap(m, [pt(0, 0, RIDGE - EAVE), pt(L - w, 0, RIDGE - EAVE)])
        for sgn in (-1, 1):
            ridge_cap(m, [pt(L - d, sgn * (w - d), r) for d, r in reversed(levels)])


def ridge_cap(m, pts, half=0.13, rise=0.07, mat='tile'):
    pts = [np.array(p, float) for p in pts]
    for a, b in zip(pts, pts[1:]):
        d = b - a
        side = np.cross(d, UP)
        side = side / np.linalg.norm(side)
        top = UP * rise
        for sgn in (-1, 1):
            m.poly(mat, [a + side * sgn * half - UP * 0.02, b + side * sgn * half - UP * 0.02, b + top, a + top], UP + side * sgn,
                   uvs=[(0.0, 0.05), (np.linalg.norm(d), 0.05), (np.linalg.norm(d), 0.2), (0.0, 0.2)])


def opening_list(edge, wf, table, outline_fn):
    return [(wf.at(c), outline_fn()) for c in table.get(edge, ())]


def add_walls(m, hb):
    n = len(WALL_RING)
    plinth_ring = offset_ring(WALL_RING, 0.16)
    for i in range(n):
        a, b = WALL_RING[i], WALL_RING[(i + 1) % n]
        w = WallFrame(a, b)
        wl = WallFrame(plinth_ring[i], plinth_ring[(i + 1) % n])
        # the plinth, with the basement windows
        north = opening_list(i, wl, BASEMENT_NORTH, lambda: rect(0.0, 1.0, BASE_W))
        south = opening_list(i, wl, BASEMENT_SOUTH, lambda: rect(0.5, 0.95, BASE_W))
        m.wall('stone', wl, hb, PLINTH - 0.2, north + south)
        for c, o in north + south:
            m.reveal(wl, c, o, 0.14)
        # the wall above it
        ops = opening_list(i, w, ARCHED, lambda: arch(WIN_SILL, WIN_TOP, WIN_W))
        extra = []
        if i == 4:  # the east arm's north wall: bull's-eye, slits
            extra = [(w.at(14.15), circle(8.74, 0.56))] + [(w.at(c), rect(3.1, 4.4, 0.16)) for c in (15.72, 14.15, 12.55)]
        if i == 6:  # the east arm's south wall: as the north, with a slit beside the eye
            extra = [(w.at(14.15), circle(8.74, 0.56)), (w.at(12.4), rect(8.1, 9.3, 0.16))] + [(w.at(c), rect(3.1, 4.4, 0.16)) for c in (15.72, 14.15, 12.55)]
        if i == 15:  # the west wall: the round window in its cartouche (sheet 32)
            extra = [(w.at(0.0), circle(8.73, 0.62))]
        m.wall('wall', w, PLINTH - 0.2, WALL_TOP, ops + extra)
        for c, o in ops:
            m.reveal(w, c, o, 0.35)
            m.frame('stone', w, c, o, 0.1, 0.07)
            m.wbox('stone', w, c - WIN_W / 2 - 0.12, c + WIN_W / 2 + 0.12, WIN_SILL - 0.14, WIN_SILL, -0.01, 0.12)
        for c, o in extra:
            if len(o) > 2:
                m.reveal(w, c, o, 0.3)
                m.frame('stone', w, c, o, 0.18 if i != 15 else 0.26, 0.08, closed=True)
            else:
                m.reveal(w, c, o, 0.16, fill='painted', color=DARK)
        # pilasters at both ends of the wall (their bases are stone), not on the east wall behind the portico
        if i != 5:
            add_pilasters(m, w, i)
    m.band('stone', WALL_RING, [(0.16, PLINTH - 0.2), (0.0, PLINTH)])
    m.band('wall', WALL_RING, [(0.0, 10.55), (0.17, 10.6), (0.17, 10.8), (0.0, 10.85)])
    m.band('stone', WALL_RING, [(0.0, 11.45), (0.18, 11.5), (0.18, 11.72), (0.34, 11.82), (EAVE_OUT, 12.0), (EAVE_OUT, EAVE)])


def offset_ring(ring, d):
    n = len(ring)
    ring = np.array(ring, float)
    out = []
    for i in range(n):
        a = ring[i] - ring[i - 1]
        b = ring[(i + 1) % n] - ring[i]
        a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
        out.append(tuple(ring[i] + (np.array([a[1], -a[0]]) + np.array([b[1], -b[0]])) * d))
    return out


def add_pilasters(m, w, i, width=1.15):
    n = len(WALL_RING)
    r = np.array(WALL_RING, float)
    def convex(k):
        a, b = r[k] - r[k - 1], r[(k + 1) % n] - r[k]
        return a[0] * b[1] - a[1] * b[0] > 0  # clockwise on screen, v south
    for at_start in (True, False):
        vx = convex(i if at_start else (i + 1) % n)
        grow = 0.13 if vx else 0.0
        s0, s1 = (-grow, width) if at_start else (w.length - width, w.length + grow)
        m.wbox('wall', w, s0, s1, PLINTH - 0.2, 10.6, -0.01, 0.13, top=False)
        grow = 0.24 if vx else 0.0
        s0, s1 = (-grow, width + 0.1) if at_start else (w.length - width - 0.1, w.length + grow)
        m.wbox('stone', w, s0, s1, 0.0, 1.75, 0.1, 0.24)


def add_doors(m):
    # north: down to the basement, under the north-east bay's window (sheet 33)
    w = WallFrame((ARM_HALF, -BAY_V), (BAY_E, -BAY_V))
    door(m, w, w.at(7.85), 0.0, 1.9, 1.45, 2.06)
    # south: the door in the middle of the arm, with a round pediment and eye over it
    w = WallFrame((ARM_HALF, SOUTH), (-ARM_HALF, SOUTH))
    c = w.at(0.0)
    door(m, w, c, 0.5, 3.1, 1.6, 3.3)
    m.frame('stone', w, c, arch(3.52, 4.75, 2.1, 6), 0.14, 0.2)
    m.wbox('stone', w, c - 1.05, c + 1.05, 3.52, 3.62, 0.0, 0.14)
    m.poly('painted', [w.p(c + 0.3 * math.cos(a), 4.06 + 0.3 * math.sin(a), 0.02) for a in np.linspace(0, 2 * math.pi, 13)[:-1]], w.n, color=DARK)
    # the east arm: the small door with chevrons, south side
    w = WallFrame((EAST, ARM_HALF), (BAY_E, ARM_HALF))
    door(m, w, w.at(12.4), 0.5, 2.4, 1.2, 2.5, color=rgb(.40, .33, .25))


def door(m, w, c, h0, h1, width, head, color=DOOR, proud=0.2):
    m.wbox('stone', w, c - width / 2 - 0.2, c + width / 2 + 0.2, h0, head, 0.0, proud)
    m.wbox('stone', w, c - width / 2 - 0.34, c + width / 2 + 0.34, head, head + 0.22, 0.0, proud + 0.14)
    gap = 0.03
    for sgn in (-1, 1):
        a, b = c + sgn * gap, c + sgn * width / 2
        m.poly('painted', [w.p(a, h0, proud + 0.01), w.p(b, h0, proud + 0.01), w.p(b, h1, proud + 0.01), w.p(a, h1, proud + 0.01)], w.n, color=color)
        for q0, q1 in ((0.12, 0.45), (0.55, 0.9)):
            t0, t1 = h0 + (h1 - h0) * q0, h0 + (h1 - h0) * q1
            aa, bb = a + (b - a) * 0.2, a + (b - a) * 0.8
            shade = tuple(k * 0.55 for k in color[:3]) + (1.0,)
            m.poly('painted', [w.p(aa, t0, proud + 0.02), w.p(bb, t0, proud + 0.02), w.p(bb, t1, proud + 0.02), w.p(aa, t1, proud + 0.02)], w.n, color=shade)


def square_faces(cu, cv, hw):
    """The four outward wall frames of a square, N, E, S, W."""
    return [WallFrame((cu - hw, cv - hw), (cu + hw, cv - hw)), WallFrame((cu + hw, cv - hw), (cu + hw, cv + hw)),
            WallFrame((cu + hw, cv + hw), (cu - hw, cv + hw)), WallFrame((cu - hw, cv + hw), (cu - hw, cv - hw))]


def square_ring(cu, cv, hw):
    return [(cu - hw, cv - hw), (cu + hw, cv - hw), (cu + hw, cv + hw), (cu - hw, cv + hw)]


def add_tower(m, hb):
    cu = TOWER_U
    # The shaft, to the main cornice (sheet 33: 8.06 m wide), with a slit in three faces.
    for k, w in enumerate(square_faces(cu, 0, TOWER_HALF)):
        ops = [] if k == 3 else [(w.length / 2, rect(14.5, 17.6, 0.2))]
        m.wall('wall', w, hb, 19.4, ops)
        for c, o in ops:
            m.reveal(w, c, o, 0.2, fill='painted', color=DARK)
    ring = square_ring(cu, 0, TOWER_HALF)
    m.band('stone', ring, [(0.0, 19.38), (0.2, 19.45), (0.3, 19.62), (0.54, 19.76), (0.54, 19.85)])
    m.band('painted', ring, [(0.54, 19.85), (-0.25, 20.25)], color=LEAD)
    # Plinth of the belfry
    m.loft('stone', cu, 0, [(3.78, 19.85), (3.78, 21.03), (3.65, 21.1)], smooth=False)
    # The belfry: arch with louvres in the foot, the clock over it, pilasters at the corners
    hw = 3.65
    for w in square_faces(cu, 0, hw):
        c = hw
        o = arch(21.1, 25.2, 1.5, 6)
        m.wall('wall', w, 21.03, 27.1, [(c, o)])
        m.reveal(w, c, o, 0.5, fill='painted', color=DARK)
        m.frame('stone', w, c, o, 0.22, 0.1)
        for k in range(9):  # the grille in the arch's foot
            s = c - 0.68 + 0.17 * k
            m.wbox('painted', w, s - 0.025, s + 0.025, 21.1, 22.2, -0.25, -0.2, color=LOUVRE, top=False)
        m.wbox('stone', w, c - 1.0, c + 1.0, 25.25, 25.5, 0.0, 0.26)
        for sgn in (-1, 1):  # the scrolls over the arch
            m.wbox('stone', w, c + sgn * 0.68 - 0.17, c + sgn * 0.68 + 0.17, 25.5, 25.72, 0.0, 0.2)
        for s0, s1 in ((-0.07, 0.76), (2 * hw - 0.76, 2 * hw + 0.07)):
            m.wbox('wall', w, s0, s1, 21.03, 27.1, -0.01, 0.07, top=False)
        add_clock(m, w, c, 26.3)
    m.band('wall', square_ring(cu, 0, hw), [(0.0, 27.08), (0.1, 27.12), (0.1, 28.25), (0.2, 28.32), (0.42, 28.68), (0.42, 28.8)])
    m.band('painted', square_ring(cu, 0, hw), [(0.42, 28.8), (-0.09, 29.0)], color=LEAD)
    # Attic and the copper hood
    m.loft('copper', cu, 0, [(3.56, 28.8), (3.56, 29.8)], smooth=False, seams=14)
    m.loft('copper', cu, 0, [(3.56, 29.8), (3.44, 29.86), (3.14, 30.1), (2.92, 30.6), (2.78, 31.2), (2.62, 31.9), (2.38, 32.5), (2.12, 32.95), (1.95, 33.2)], seams=14)
    hood = [(3.56, 29.8), (3.44, 29.86), (3.14, 30.1), (2.92, 30.6), (2.78, 31.2), (2.62, 31.9), (2.38, 32.5), (2.12, 32.95), (1.95, 33.2)]
    for f in square_faces(cu, 0, 1.0):
        hood_dormer(m, f.t2, f.n2, cu)
    for sx in (-1, 1):
        for sz in (-1, 1):  # the ribs up its corners, and a second pair inside them (sheet 33)
            ridge_cap(m, [(cu + sx * r, h, sz * r) for r, h in hood], 0.11, 0.1, mat='copper')
            for (a, b) in ((0.72, 1.0), (1.0, 0.72)):
                ridge_cap(m, [(cu + sx * r * a, h + 0.02, sz * r * b) for r, h in hood], 0.05, 0.06, mat='copper')
    for sx in (-1, 1):
        for sz in (-1, 1):
            q = (cu + sx * 2.9, sz * 2.9)
            m.loft('copper', q[0], q[1], [(0.15, 29.85), (0.11, 31.0), (0.11, 32.4), (0.17, 32.45), (0.15, 33.2), (0.2, 33.26)], smooth=False, seams=2)
            m.ball(q[0], 33.4, q[1], 0.14, color=rgb(.55, .70, .62), n=6, st=4)
    # The lantern: round windows, three to a face
    m.loft('copper', cu, 0, [(1.95, 33.2), (1.95, 34.3)], smooth=False, seams=8)
    hw = 1.84
    for w in square_faces(cu, 0, hw):
        ops = [(hw + d, circle(35.2, 0.3, 10)) for d in (-1.21, 0.0, 1.21)]
        m.wall('copper', w, 34.3, 36.15, ops)
        for c, o in ops:
            m.reveal(w, c, o, 0.14, side='copper')
            m.frame('copper', w, c, o, 0.06, 0.04, closed=True)
        for s0, s1 in ((-0.04, 0.2), (0.53, 0.74), (2.94, 3.15), (2 * hw - 0.2, 2 * hw + 0.04)):
            m.wbox('copper', w, s0, s1, 34.3, 36.15, -0.01, 0.04, top=False)
    m.loft('copper', cu, 0, [(1.84, 36.1), (2.0, 36.2), (2.14, 36.36), (2.14, 36.45)], smooth=False, seams=8)
    # The spire: eight sides, flared at the foot with its garland (sheet 33)
    prof = [(2.09, 36.45), (1.98, 36.62), (1.80, 36.82), (1.62, 37.2), (1.32, 37.75), (1.13, 38.3), (0.98, 39.0), (0.82, 40.0), (0.67, 41.2), (0.54, 42.5), (0.44, 43.7), (0.36, 44.9)]
    m.loft('copper', cu, 0, prof, sides=8, rot=0.0, seams=3)
    m.loft('copper', cu, 0, [(0.36, 44.9), (0.04, 45.25)], sides=8, smooth=False, seams=1)
    add_garlands(m, cu, prof)
    m.ball(cu, 45.67, 0, 0.35, n=12, st=8)
    m.box('painted', (cu - 0.03, 45.2, -0.03), (cu + 0.03, 48.67, 0.03), color=GOLD)
    m.box('painted', (cu - 0.28, 48.07, -0.025), (cu + 0.28, 48.14, 0.025), color=GOLD)  # the cross
    m.box('painted', (cu + 0.03, 47.05, -0.012), (cu + 0.72, 47.32, 0.012), color=GOLD)  # the vane
    m.ball(cu, 46.75, 0, 0.1, n=8, st=4)
    m.ball(cu, 47.65, 0, 0.06, n=6, st=4)


def add_garlands(m, cu, prof, sides=8):
    """The swags hung around the spire's foot (sheet 33): one to a side, sagging from its corners."""
    p = np.array(prof)
    rad = lambda h: float(np.interp(h, p[:, 1], p[:, 0]))
    k = 1 / math.cos(math.pi / sides)
    for i in range(sides):
        a0 = i * 2 * math.pi / sides - math.pi / sides - math.pi / 2
        a1 = a0 + 2 * math.pi / sides
        last = None
        for q in np.linspace(0, 1, 7):
            h = 37.35 - 0.5 * math.sin(q * math.pi)
            r = rad(h) * k + 0.05
            ca, sa = math.cos(a0), math.sin(a0)
            cb, sb = math.cos(a1), math.sin(a1)
            x, z = (ca * (1 - q) + cb * q) * r, (sa * (1 - q) + sb * q) * r
            cur = (cu + x, h, z), (cu + x, h + 0.14, z)
            if last:
                mid = (a0 + a1) / 2
                m.poly('copper', [last[0], cur[0], cur[1], last[1]], (math.cos(mid), 0.1, math.sin(mid)))
            last = cur


def add_clock(m, w, c, h):
    m.wbox('stone', w, c - 0.68, c + 0.68, h - 0.68, h + 0.68, 0.0, 0.08)
    disc = lambda r, d, col, n=20: m.poly('painted', [w.p(c + r * math.cos(a), h + r * math.sin(a), d) for a in np.linspace(0, 2 * math.pi, n + 1)[:-1]], w.n, color=col)
    disc(0.58, 0.09, GOLD)
    disc(0.52, 0.1, CLOCK)
    for k in range(12):
        a = k / 12 * 2 * math.pi
        for r0, r1 in ((0.42, 0.5),):
            dx, dy = math.cos(a), math.sin(a)
            px, py = -dy * 0.018, dx * 0.018
            m.poly('painted', [w.p(c + dx * r0 + px, h + dy * r0 + py, 0.11), w.p(c + dx * r1 + px, h + dy * r1 + py, 0.11),
                               w.p(c + dx * r1 - px, h + dy * r1 - py, 0.11), w.p(c + dx * r0 - px, h + dy * r0 - py, 0.11)], w.n, color=DARK)
    m.poly('painted', [w.p(c - 0.02, h, 0.12), w.p(c + 0.02, h, 0.12), w.p(c + 0.02, h + 0.4, 0.12), w.p(c - 0.02, h + 0.4, 0.12)], w.n, color=DARK)
    m.poly('painted', [w.p(c, h - 0.02, 0.12), w.p(c + 0.28, h - 0.02, 0.12), w.p(c + 0.28, h + 0.02, 0.12), w.p(c, h + 0.02, 0.12)], w.n, color=DARK)


def hood_dormer(m, t, n, cu):
    """A dormer in the hood, pedimented, one to a face (sheet 33): t along the face, n out of it."""
    o = np.array([cu, 0.0])
    w = WallFrame(o + n * 3.0 - t * 0.82, o + n * 3.0 + t * 0.82)
    c = w.length / 2
    ow = rect(30.95, 32.25, 1.16)
    m.wall('copper', w, 30.6, 32.45, [(c, ow)])
    m.reveal(w, c, ow, 0.1)
    m.frame('stone', w, c, ow, 0.06, 0.05)
    for s, d in ((0, -t), (w.length, t)):
        m.poly('copper', [w.p(s, 30.6), w.p(s, 30.6, -1.6), w.p(s, 32.45, -1.6), w.p(s, 32.45)], np.array([d[0], 0, d[1]]))
    # pediment
    m.wbox('stone', w, -0.08, w.length + 0.08, 32.45, 32.55, -1.6, 0.1)
    top = (c, 33.05)
    m.poly('copper', [w.p(0, 32.55), w.p(w.length, 32.55), w.p(*top)], w.n)
    for sgn, s in ((-1, -0.12), (1, w.length + 0.12)):
        h = UP + w.t * sgn
        m.poly('copper', [w.p(s, 32.5, 0.12), w.p(s, 32.5, -1.6), w.p(c, 33.1, -1.6), w.p(c, 33.1, 0.12)], h, uvs=[(0, 0), (1.72, 0), (1.72, 1.1), (0, 1.1)])


def add_domes(m):
    for su in (-1, 1):
        for sv in (-1, 1):
            cu = su * DOME_U
            cv = sv * DOME_V
            # the flat copper deck of the bay, under the arms' eaves
            bu = (BAY_E if su > 0 else -BAY_W) + EAVE_OUT
            bv = BAY_V + EAVE_OUT
            u0, u1 = sorted((su * 5.0, su * bu))
            v0, v1 = sorted((sv * 5.0, sv * bv))
            m.poly('painted', [(u0, EAVE - 0.01, v0), (u1, EAVE - 0.01, v0), (u1, EAVE - 0.01, v1), (u0, EAVE - 0.01, v1)], UP, color=LEAD)
            # its attic and the pavilion dome, a pointed vault on a square foot
            m.loft('painted', cu, cv, [(DOME_HALF + 0.08, EAVE), (DOME_HALF + 0.08, DOME_BASE - 0.12), (DOME_HALF + 0.16, DOME_BASE - 0.04), (DOME_HALF + 0.16, DOME_BASE), (DOME_HALF, DOME_BASE)],
                   smooth=False, color=LEAD)
            prof = []
            for k in range(11):
                th = k / 10 * math.pi / 2
                prof.append((DOME_HALF * math.cos(th) ** 0.92 + 0.08 * (1 - k / 10), DOME_BASE + (DOME_TOP - DOME_BASE) * math.sin(th) ** 1.05))
            m.loft('dome', cu, cv, prof, seams=12)
            for sx in (-1, 1):
                for sz in (-1, 1):  # the four ridges of the vault
                    ridge_cap(m, [(cu + sx * r, h, cv + sz * r) for r, h in prof], 0.07, 0.05, mat='dome')
            # the finial: a stem, a knob and the cross in its ring
            col = rgb(.55, .46, .24)
            m.box('painted', (cu - 0.035, DOME_TOP - 0.05, cv - 0.035), (cu + 0.035, 18.55, cv + 0.035), color=col)
            m.ball(cu, DOME_TOP + 0.28, cv, 0.1, color=col, n=8, st=4)
            m.box('painted', (cu - 0.4, 18.08, cv - 0.02), (cu + 0.4, 18.14, cv + 0.02), color=col)
            ring = [(cu + 0.4 * math.cos(a), 18.11 + 0.4 * math.sin(a), cv) for a in np.linspace(0, 2 * math.pi, 17)]
            inner = [(cu + 0.35 * math.cos(a), 18.11 + 0.35 * math.sin(a), cv) for a in np.linspace(0, 2 * math.pi, 17)]
            for i in range(16):
                m.poly('painted', [ring[i], ring[i + 1], inner[i + 1], inner[i]], (0, 0, -1), color=col)


def add_portico(m, hb):
    """The entrance front (sheets 33 and 38): stairs and landing, two Ionic columns on pedestals, entablature and pediment against the tower."""
    hw = TOWER_HALF
    u0, u1 = TOWER_U + TOWER_HALF, PORTICO_U
    m.box('stone', (u0, hb, -hw), (19.85, PLINTH, hw), skip=('b',))  # landing
    for k in range(5):
        a = 19.85 + k * 0.45
        top = PLINTH - (k + 1) * 0.29
        m.box('stone', (a, hb, -3.75), (a + 0.45, top, 3.75), skip=('b', 'w'))
    for v in COLUMNS_V:
        cu = COLUMN_U
        m.box('stone', (cu - 0.62, PLINTH, v - 0.72), (cu + 0.62, 2.15, v + 0.72))  # pedestal
        m.box('stone', (cu - 0.57, 2.15, v - 0.6), (cu + 0.57, 2.3, v + 0.6))
        m.cylinder('stone', cu, v, 0.57, 2.3, 2.42, n=20)  # base
        m.cylinder('stone', cu, v, 0.51, 2.42, 9.93, n=20, r1=0.46)  # shaft, tapering (sheet 33)
        ionic_capital(m, cu, v)
    # entablature around the portico: architrave, frieze and cornice (sheet 33)
    m.box('stone', (u0, 10.56, -hw), (19.73, 10.86, hw))
    m.box('stone', (u0, 10.86, -hw), (19.65, 11.55, hw))
    m.box('stone', (u0, 11.55, -hw - 0.1), (19.9, 11.82, hw + 0.1))
    m.box('stone', (u0, 11.82, -hw - 0.27), (u1, 12.1, hw + 0.27), skip=('w',))
    # pediment with its raking cornices, tile laid over it
    apex = 13.7
    m.poly('wall', [(u1 - 0.1, 12.1, -hw), (u1 - 0.1, 12.1, hw), (u1 - 0.1, apex - 0.1, 0)], (1, 0, 0))
    for sgn in (-1, 1):
        v1 = sgn * (hw + 0.3)
        m.poly('painted', [(u0, 12.08, v1), (u1 + 0.1, 12.08, v1), (u1 + 0.1, apex, 0), (u0, apex, 0)], UP, color=LEAD)
        m.poly('stone', [(u1 + 0.1, 12.08, v1), (u1 + 0.1, apex, 0), (u1 + 0.1, apex - 0.2, 0), (u1 + 0.1, 12.12, sgn * (hw - 0.05))], (1, 0, 0))
    # the tower's front behind the columns: main door with its cartouche, the arched window over it (sheet 38)
    w = WallFrame((u0, -hw), (u0, hw))
    c = hw
    for v in COLUMNS_V:  # the pilaster behind each column, with its half capital
        m.wbox('stone', w, c + v - 0.6, c + v + 0.6, PLINTH, 10.3, 0.0, 0.22, top=False)
        m.wbox('stone', w, c + v - 0.72, c + v + 0.72, 10.3, 10.56, 0.0, 0.3)
    o = arch(7.6, 10.2, 1.58, 6)
    for (h0, a0), (h1, a1) in zip(o, o[1:]):
        m.poly('glass', [w.p(c - a0, h0, 0.02), w.p(c + a0, h0, 0.02), w.p(c + a1, h1, 0.02), w.p(c - a1, h1, 0.02)], w.n, uvs=[(-a0, h0), (a0, h0), (a1, h1), (-a1, h1)])
    m.frame('stone', w, c, o, 0.12, 0.1)
    door(m, w, c, PLINTH, 4.4, 2.05, 4.7, color=rgb(.27, .2, .14))
    # the cartouche over the door: a raised panel, scrolls and a segment
    m.wbox('stone', w, c - 0.82, c + 0.82, 4.92, 7.3, 0.0, 0.14)
    m.frame('stone', w, c, arch(5.0, 7.45, 1.7, 8), 0.12, 0.26)
    for sgn in (-1, 1):
        m.wbox('stone', w, c + sgn * 0.98 - 0.14, c + sgn * 0.98 + 0.14, 4.92, 6.35, 0.0, 0.3)
        m.wbox('stone', w, c + sgn * 0.98 - 0.2, c + sgn * 0.98 + 0.2, 6.35, 6.6, 0.0, 0.34)


def ionic_capital(m, cu, cv):
    """A capital as sheet 33 draws it from the side: a bolster with a waist running front to back, ending in a scroll on the entrance side and behind."""
    m.cylinder('stone', cu, cv, 0.47, 9.93, 10.12, n=20, r1=0.6)  # echinus
    m.box('stone', (cu - 0.44, 10.08, cv - 0.5), (cu + 0.44, 10.46, cv + 0.5))  # the band between the scrolls
    m.box('stone', (cu - 0.6, 10.46, cv - 0.72), (cu + 0.6, 10.56, cv + 0.72))  # abacus
    groove = rgb(.40, .38, .33)
    ch, end, half = 10.2, 0.26, 0.5
    for sgn in (-1, 1):
        cz = cv + sgn * 0.5
        radius = lambda t: 0.13 + (end - 0.13) * abs(t) ** 1.6
        ts = np.linspace(-1, 1, 9)
        n = 14
        for t0, t1 in zip(ts, ts[1:]):
            for i in range(n):
                a0, a1 = i / n * 2 * math.pi, (i + 1) / n * 2 * math.pi
                d0, d1 = np.array([0, math.sin(a0), math.cos(a0)]), np.array([0, math.sin(a1), math.cos(a1)])
                q = lambda t, a: (cu + t * half, ch + radius(t) * math.sin(a), cz + radius(t) * math.cos(a))
                m.poly('stone', [q(t0, a0), q(t1, a0), q(t1, a1), q(t0, a1)], d0 + d1, nors=[d0, d0, d1, d1],
                       uvs=[(t0 * half, a0 * end), (t1 * half, a0 * end), (t1 * half, a1 * end), (t0 * half, a1 * end)])
        for side in (-1, 1):
            face = cu + side * half
            normal = (side, 0, 0)
            disc = [(face, ch + end * math.sin(a), cz + end * math.cos(a)) for a in np.linspace(0, 2 * math.pi, 15)[:-1]]
            m.poly('stone', disc, normal)
            # the scroll: a spiral cut in the face, winding in from the rim to the eye
            turns = np.linspace(0, 3 * 2 * math.pi, 37)
            rr = end * 0.94 * (1 - turns / turns[-1]) + 0.05
            for k in range(len(turns) - 1):
                a, b = turns[k], turns[k + 1]
                ra, rb = rr[k], rr[k + 1]
                out = lambda r, q: (face + side * 0.006, ch + r * math.sin(q), cz + sgn * r * math.cos(q))
                m.poly('painted', [out(ra, a), out(rb, b), out(rb - 0.016, b), out(ra - 0.016, a)], normal, color=groove)


def build(hb=-2.0):
    """The church's model in the church frame. `hb`: how far (h) its walls go down: into the ground, under the terrain's lowest point along them."""
    m = Model()
    add_walls(m, hb)
    add_doors(m)
    add_roof(m)
    add_domes(m)
    add_tower(m, hb)
    add_portico(m, hb)
    return m


# ---------------------------------------------------------------------------------------------------------------------------------------- textures
def tile_texture(n=1024, cols=40, rows=32, seed=1):
    """Red clay pantiles, as the ribs of the drawings and the 2021 photographs show them: each tile its own tone, a rib down it, the course above's shadow."""
    rs = np.random.default_rng(seed)
    y, x = np.mgrid[0:n, 0:n] + 0.5
    cx, cy = x / n * cols, y / n * rows
    ci, cj = np.floor(cx).astype(int), np.floor(cy).astype(int)
    fx, fy = cx - ci, cy - cj
    jit = rs.normal(0, 1, (rows, cols, 3))
    shade = 1 + 0.13 * jit[cj, ci, 0]
    hue = 0.035 * jit[cj, ci, 1]
    rib = 0.80 + 0.28 * np.sin(np.pi * fx) ** 0.7 - 0.06 * np.cos(2 * np.pi * (fx + 0.15))
    course = 0.55 + 0.45 * np.clip(fy / 0.14, 0, 1) ** 0.6
    moss = periodic_noise(n, 1.5, seed + 1, low=2)
    grime = 1 + 0.2 * moss + 0.06 * periodic_noise(n, 1.0, seed + 2, low=8)
    lum = shade * rib * course * grime
    lum = lum / lum.mean()
    base = albedo(TONES['tile'])
    img = np.stack([base[0] * (1 + hue), base[1] * (1 - hue * 0.5), base[2] * (1 - hue)], -1) * lum[..., None]
    # old tile goes grey-brown where the lichen sits
    lich = np.clip(moss - 0.2, 0, 1)[..., None] * 0.7
    img = img * (1 - lich) + np.array(albedo([0.42, 0.34, 0.27])) * lum[..., None] * lich
    return to_image(np.clip(img, 0, 1))


def wall_texture(n=1024, rows=78, cols=22, seed=3):
    """Mursten: pale yellow brick in running bond, 24 cm by 6.8 cm to a repeat of 5.28 m. Each brick has its own tone and the bed joints shade most. The courses
    are laid by hand, each a little off the half-brick, so that from afar the head joints do not line up in stripes."""
    rs = np.random.default_rng(seed)
    y, x = np.mgrid[0:n, 0:n] + 0.5
    cy = y / n * rows
    cj = np.floor(cy).astype(int)
    shift = 0.5 * (np.arange(rows) % 2) + rs.uniform(-0.09, 0.09, rows)
    cx = x / n * cols + shift[cj]
    ci = np.floor(cx).astype(int) % cols
    fy, fx = cy - cj, cx % 1
    jit = rs.normal(0, 1, (rows, cols))
    warm = rs.normal(0, 1, (rows, cols))
    bed = np.minimum(fy, 1 - fy) < 0.085
    head = np.minimum(fx, 1 - fx) < 0.024
    lum = 1 + 0.055 * jit[cj, ci]
    lum = lum * (1 + 0.035 * periodic_noise(n, 0.9, seed + 3, low=30))
    lum = np.where(bed, 0.86, np.where(head, 0.92, lum))
    lum = lum * (1 + 0.05 * periodic_noise(n, 1.7, seed + 1, stretch=(1.0, 0.45), low=1))
    lum = lum / lum.mean()
    tint = np.where(bed | head, 0.0, 0.018 * warm[cj, ci])
    img = np.array(albedo(TONES['wall'])) * lum[..., None] * np.stack([1 + tint, np.ones_like(tint), 1 - tint * 1.5], -1)
    return to_image(np.clip(img, 0, 1))


def stone_texture(n=256, seed=5):
    lum = 1 + 0.05 * periodic_noise(n, 1.0, seed, low=2) + 0.025 * periodic_noise(n, 0.3, seed + 1, low=20)
    return to_image(np.clip(np.array(albedo(TONES['stone'])) * lum[..., None], 0, 1))


def copper_texture(n=512, seams=8, seed=7):
    """Verdigris: standing seams every half metre (8 to a repeat), streaks running down from them, brown where the rain does not wash it."""
    y, x = np.mgrid[0:n, 0:n] + 0.5
    fx = (x / n * seams) % 1
    seam = np.exp(-(np.minimum(fx, 1 - fx) / 0.035) ** 2)
    edge = np.exp(-((np.minimum(fx, 1 - fx) - 0.075) / 0.03) ** 2)
    streak = periodic_noise(n, 1.2, seed, stretch=(1.0, 0.09), low=3)
    cloud = periodic_noise(n, 1.7, seed + 1, low=1)
    base = np.array(albedo(TONES['copper']))
    dark = np.array(albedo([0.24, 0.30, 0.27]))
    mix = np.clip(0.28 + 0.75 * cloud + 0.35 * streak, 0, 1)[..., None] * 0.6
    img = base * (1 - mix) + dark * mix
    img = img * (1 + 0.24 * seam - 0.28 * edge)[..., None] * (1 + 0.1 * streak)[..., None]
    return to_image(np.clip(img, 0, 1))


def glass_texture(n=384, cols=6, rows=6, seed=9):
    """Dark small-paned glass in light glazing bars: 6 panes of 0.29 m by 6 of 0.33 m to a repeat (sheet 33)."""
    rs = np.random.default_rng(seed)
    y, x = np.mgrid[0:n, 0:n] + 0.5
    cx, cy = x / n * cols, y / n * rows
    ci, cj = np.floor(cx).astype(int), np.floor(cy).astype(int)
    jit = rs.normal(0, 1, (rows, cols))
    bar = (np.minimum(cx % 1, 1 - cx % 1) < 0.045) | (np.minimum(cy % 1, 1 - cy % 1) < 0.04)
    pane = np.array([0.018, 0.024, 0.032]) * (1 + 0.22 * jit[cj, ci])[..., None] * (1 + 0.6 * (cy % 1))[..., None]
    img = np.where(bar[..., None], np.array([0.46, 0.45, 0.42]), pane)
    return to_image(np.clip(img, 0, 1))


# The real church's colours, sRGB as seen in sunlight on the 2021 Skraafoto flight. Haze takes a third of the chroma from these views, as it does elsewhere
# (docs/aalborg-phase5.md): the values are for the sunlit faces, with the haze taken back out of the tile by the same rule as the city's tegl roofs.
TONES = {'wall': (0.84, 0.78, 0.65), 'stone': (0.81, 0.77, 0.68), 'tile': (0.76, 0.41, 0.27), 'copper': (0.55, 0.71, 0.63)}
DOME_TINT = (1.03, 0.98, 0.78, 1.0)  # the domes are the same copper, a paler sage: no wash from the tower's run-off

TEXTURES = {'tile': tile_texture, 'wall': wall_texture, 'stone': stone_texture, 'copper': copper_texture, 'glass': glass_texture}
PBR = {'tile': dict(roughness=0.8), 'wall': dict(roughness=0.9), 'stone': dict(roughness=0.85), 'copper': dict(roughness=0.55, metallic=0.15), 'dome': dict(roughness=0.6, metallic=0.1),
       'glass': dict(roughness=0.12, metallic=0.5), 'painted': dict(roughness=0.55)}

ATTRIBUTION = {
    'ansgars-tegning-1925': {'text': 'Kirke til Budolfi Sogns sydvestre del / Ny Sognekirke, Aalborg: facade drawings, Aalborg, 1925', 'licence': 'Aalborg Kommune building archive (byggesagsarkiv), weblager.dk', 'url': 'https://weblager.dk'},
    'skraafoto-2021': {'text': 'Skråfoto 2021, Klimadatastyrelsen (colours only)', 'licence': 'CC BY 4.0 terms for free geographic data', 'url': 'https://dataforsyningen.dk'},
    'geodanmark': {'text': 'GeoDanmark Bygning (placement)', 'licence': 'CC BY 4.0', 'url': 'https://www.geodanmark.dk'},
}


def walk_ring():
    """Where colliders and walk space have the church: its walls with the portico in front, as a flat x, z ring wound as the GeoDanmark rings are."""
    r = []
    for u, v in WALL_RING:
        if (u, v) == (EAST, -ARM_HALF):
            r += [(EAST, -ARM_HALF), (EAST, -TOWER_HALF), (PORTICO_U, -TOWER_HALF), (PORTICO_U, TOWER_HALF), (EAST, TOWER_HALF)]
        else:
            r.append((u, v))
    flat = []
    for u, v in reversed(r):
        p = to_local(u, 0, v)
        flat += [round(float(p[0]), 2), round(float(p[2]), 2)]
    return flat


def write_glb(model):
    """The GLB and its entry's mesh block, in the twin's frame."""
    materials = {name: {'tile': TILE_M[name], 'texture': 'copper' if name == 'dome' else name, 'color': DOME_TINT if name == 'dome' else (1, 1, 1, 1), **PBR[name]}
                 for name in TILE_M}
    return model_to_glb(model, AXIS_DEG, (CROSSING[0], GRADE_Y, CROSSING[1]), materials, TEXTURES, 'ansgars-kirke',
                        root_extras={'building_id': GDK_ID, 'source_ids': ['ansgars-tegning-1925'], 'attribution': list(ATTRIBUTION), 'confidence': 'observed'},
                        asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                        attribution=['ansgars-tegning-1925', 'skraafoto-2021'], generator='tools/overrides/ansgars_kirke.py')


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
    model = build(hb)
    body, mesh, lo, hi = write_glb(model)
    rel = 'meshes/gdk_1018922375.glb'
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    (out / rel).write_bytes(body)
    entry = {
        'tile': TILE, 'mode': 'replace', 'covers': [GDK_ID], 'footprint': {'use': 'override', 'ring': walk_ring(), 'holes': []},
        'match': {'kind': '1:1', 'iou': 0.94, 'hausdorff': 0.6},
        'source': {'ids': ['ansgars-tegning-1925'], 'kind': 'architect-drawing', 'reconstruction': 'tools/overrides/ansgars_kirke.py'},
        'confidence': 'observed', 'attribution': list(ATTRIBUTION),
        'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': rec['ground'], 'low': round(low, 2), 'sunk': 0.25,
        'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
    }
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': {GDK_ID: entry}})
    print(f'{out}: {mesh["triangles"]} triangles, {len(body) / 1e6:.2f} MB GLB, {mesh["textureBytes"] / 1e6:.1f} MB textures, walls down to {low - 0.25:.2f}, top {hi[1]:.2f}')


if __name__ == '__main__':
    main()
