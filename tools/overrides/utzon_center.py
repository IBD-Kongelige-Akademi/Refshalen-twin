#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "mapbox-earcut"]
# ///
"""Utzon Center (Slotspladsen 4, Aalborg; Jørn and Kim Utzon, 2008): a detail override built from the Skraafoto flight (docs/utzon-center.md).

No drawings: every measure comes from the 2021 Skraafoto flight and what is derived from the same survey. The GeoDanmark
footprint places every wall. The surface model of the flight (1 m) gives the roofs: the two halls on the fjord, the tower with its lantern, the
galleries' curved roof modules and the flat roofs between them. The four oblique photos, rectified onto the planes of the walls, give the eaves,
cornices, columns and windows, and settle what the surface model rounds off. The building blocks are those of tools/overrides/akkc.py. Every measure
is written out as a number here, so the script runs without the photos and without the network. No pixel of a photograph is in the model. Two photographs on
Wikimedia Commons were looked at for what the flight cannot show: that the walls' infill is brick, and how the galleries' lanterns are made.

The model's frame: u east-south-east along the footprint's long edges (23° from east), v across them towards the town (the fjord is at v = 0); h is the
twin's own height (local y).

    PYTHONUTF8=1 uv run tools/overrides/utzon_center.py [--data data] [--out DIR]
    PYTHONUTF8=1 uv run tools/overrides/publish.py install     # with no --sets: every set, so the other overrides stay
"""
from __future__ import annotations

import argparse, hashlib, math, sys
from pathlib import Path

import mapbox_earcut as earcut
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from overrides_lib import SOURCE_FORMAT, TwinFrame, flat_to_pts, write_json
from override_model import Model, UP, WallFrame, albedo, model_to_glb, periodic_noise, to_image
from akkc import Facade, col, flat, glazing, rect_ring, tiled

SET = 'utzon-center'
GDK_ID = 'gdk:1019266816'
TILE = '1112_12646'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET

AXIS_DEG = 23.0  # the footprint's long edges
ORIGIN = (184.99, -218.38)  # the frame's origin in the twin's x, z

# ------------------------------------------------------------------------------------------------------------------------------ the measures
# The footprint (GeoDanmark), in the model's frame, going round clockwise seen from above, and the court in the middle.
RING = [(15.1, 5.0), (26.2, 5.0), (26.2, 7.4), (28.4, 7.4), (28.4, 8.7), (31.1, 8.7), (31.1, 13.3), (28.6, 13.3), (28.6, 17.9), (37.8, 17.9), (37.8, 7.3),
        (53.7, 7.3), (53.8, 23.3), (53.8, 24.7), (61.6, 24.7), (61.6, 48.5), (49.1, 48.5), (49.1, 50.1), (56.5, 50.1), (56.5, 66.3), (40.4, 66.3), (40.4, 51.5),
        (36.3, 51.5), (36.3, 61.3), (12.4, 61.4), (12.4, 46.3), (5.0, 46.3), (5.0, 30.1), (15.1, 30.1), (15.1, 23.6), (10.1, 23.6), (10.1, 8.6), (15.1, 8.6)]
COURT = [(31.2, 26.0), (42.9, 26.0), (43.0, 42.7), (31.2, 42.7)]
LINK_TOP = 3.2  # the flat roofs of the corridors round the court and of the entrance
ENTRANCE = (28.6, 37.8, 17.9)  # its glass front between the halls, facing the fjord: u0, u1, v
CANOPY = (31.1, 37.8, 13.3, 17.9)  # the canopy before it: u0, u1, its front, its back

# The galleries: square bays under curved roofs that rise from the eaves to a point, a glazed triangle in each north face
GAL_EAVE, GAL_APEX = 4.3, 8.9
GAL_BOX = (1.7, 0.9, 2.6, 6.3)  # the lantern on each bay's roof: how far it reaches west and east of the bay's middle, its width, its foot; its window looks east
GALLERIES = [((5.0, 27.8), (30.1, 46.3), 3, 2), ((12.4, 36.3), (46.3, 61.4), 3, 2), ((44.8, 61.6), (24.7, 48.5), 2, 3)]  # u range, v range, bays across, bays deep
GAL_GLASS = {(5.0, 46.3): ((33.0, 46.0), -1.9, 2.8)}  # west front of the first: glass between the columns (v range, sill, head)

# The west hall on the fjord: its north face rises as a quarter ellipse to a glazed top, and its roof falls south in a concave curve
NW = (12.5, 28.4, 8.6, 23.6)
NW_FOOT, NW_TOP, NW_TOP_V, NW_END = (9.0, 8.3), 17.0, (10.4, 11.6), 7.9  # the north face's foot (v, h), the top and its extent in v, the roof's south end
NW_AISLES = [(10.1, 12.5, 8.6, 14.5, 6.8), (10.1, 12.5, 14.5, 23.6, 4.3), (28.4, 31.1, 8.7, 13.3, 6.8), (15.1, 26.8, 23.6, 30.1, 7.0)]
NW_SIDE = 7.0  # its side walls are frame and brick as far up as this
PORCH = (15.1, 26.2, 5.0, 8.6, 8.0)  # the portico before its north face
PORCH_COLS = (15.5, 19.2, 22.6, 25.8)

# The east hall on the fjord: curved on both sides of a narrow slope that carries the solar panels
NE = (37.8, 53.7, 7.3, 23.3)
# its roof across u: a concave sweep up from the west eave, the slope under the solar panels to the crest, a drop, a concave sweep down to the east eave
NE_W_EAVE, NE_WEST, NE_CREST, NE_DROP, NE_EAST = 4.3, (41.8, 13.7), (47.3, 17.0), (47.8, 11.5), 4.4
NE_SLOT = (44.0, 46.0, 0.5, 14.6)  # the tall window in its north gable: u0, u1, sill, head

# The tower on the town side: walls to a cornice, a roof of four concave faces rising to the lantern in its south-east corner
TOWER = (40.4, 56.5, 50.1, 66.3)
TOWER_EAVE, LANTERN, LANTERN_FOOT, LANTERN_TOP = 7.2, (50.8, 55.6, 60.8, 65.6), 16.8, 18.6
# windows from the rectified walls: wall (n, e, s, w), from and to (absolute u or v), sill, head
TOWER_WIN = [('s', 55.8, 54.2, 3.5, 5.6), ('s', 53.3, 51.8, 3.5, 5.6), ('s', 48.5, 46.8, 5.4, 6.4), ('s', 45.8, 44.0, 5.4, 6.4), ('s', 45.8, 44.0, 1.3, 2.4), ('s', 43.4, 41.9, 1.3, 2.4),
             ('e', 53.3, 54.8, 5.2, 6.3), ('e', 55.7, 57.4, 5.2, 6.3), ('e', 58.3, 60.2, 1.0, 2.0), ('e', 60.8, 62.6, 1.0, 2.0), ('e', 61.5, 63.4, 3.6, 5.2),
             ('e', 64.2, 66.0, 3.6, 5.2), ('w', 63.2, 61.4, 5.2, 6.3), ('w', 61.0, 59.3, 5.2, 6.3), ('w', 59.0, 57.5, 5.2, 6.3), ('w', 57.2, 55.2, -2.0, 1.0),
             ('n', 51.0, 49.5, 3.8, 5.6), ('n', 45.5, 43.8, 4.0, 5.0), ('n', 43.5, 42.0, 4.0, 5.0)]
GAL_WIN = [((61.6, 24.7), (61.6, 48.5), [(28.2, 29.8), (30.0, 31.6), (31.8, 33.4), (33.6, 35.2), (43.4, 45.0), (45.2, 46.8)], 1.7, 2.5),
           ((36.3, 61.3), (12.4, 61.4), [(34.0, 36.0), (13.2, 15.8)], -1.9, 2.6)]

WHITE, DARK, STEP = col(.86, .86, .84), col(.06, .07, .09), col(.66, .66, .64)


# -------------------------------------------------------------------------------------------------------------------------------- building blocks
def module(m, u0, u1, v0, v1):
    """One gallery bay's roof: a low pyramid of metal from the eaves to the foot of its lantern, a box whose upright east face is a window in a white frame and
    whose top falls away to the west."""
    uc, vc = (u0 + u1) / 2, (v0 + v1) / 2
    back, front, width, base = GAL_BOX
    b0, b1, hw, top = uc - back, uc + front, width / 2, GAL_APEX
    eave = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    head = [(b0, vc - hw), (b1, vc - hw), (b1, vc + hw), (b0, vc + hw)]
    g = lambda t: GAL_EAVE + (base - GAL_EAVE) * t ** 1.3
    pt = lambda e, f_, t: (e[0] + (f_[0] - e[0]) * t, g(t), e[1] + (f_[1] - e[1]) * t)
    for i, o in enumerate(((0, -1), (1, 0), (0, 1), (-1, 0))):
        a, b, c, d = eave[i], eave[(i + 1) % 4], head[(i + 1) % 4], head[i]
        for k in range(2):
            q = [pt(a, d, k / 2), pt(b, c, k / 2), pt(b, c, (k + 1) / 2), pt(a, d, (k + 1) / 2)]
            m.poly('metal', q, (o[0], 2.0, o[1]), uvs=[(p[0] * abs(o[1]) + p[2] * abs(o[0]), p[0] * abs(o[0]) + p[2] * abs(o[1]) + p[1]) for p in q])
    m.poly('painted', [(b1, base, vc - hw), (b1, base, vc + hw), (b1, top, vc + hw), (b1, top, vc - hw)], (1, 0, 0), color=WHITE)
    m.poly('glass', [(b1 + .03, base + .35, vc - hw + .3), (b1 + .03, base + .35, vc + hw - .3), (b1 + .03, top - .3, vc + hw - .3), (b1 + .03, top - .3, vc - hw + .3)], (1, 0, 0),
           uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
    q = [(b1, top, vc - hw), (b1, top, vc + hw), (b0, base, vc + hw), (b0, base, vc - hw)]
    m.poly('metal', q, (-0.5, 1, 0), uvs=[(p[2], p[0] + p[1]) for p in q])
    for v, sgn in ((vc - hw, -1), (vc + hw, 1)):
        m.poly('painted', [(b1, base, v), (b1, top, v), (b0, base, v)], (0, 0, sgn), color=WHITE)


def cornice(m, ring, h, depth=0.3, band=0.45):
    """The white eaves band round a ring: a fascia standing `depth` out, its underside and top."""
    n = len(ring)
    for i in range(n):
        w = WallFrame(ring[i], ring[(i + 1) % n])
        m.wbox('painted', w, -depth, w.length + depth, h - band, h + 0.05, 0.0, depth, color=WHITE)


def walls(m, ring, h0, h1, mat='wall', skip=()):
    n = len(ring)
    for i in range(n):
        if i not in skip:
            m.wall(mat, WallFrame(ring[i], ring[(i + 1) % n]), h0, h1)


def _fill(m, pts, to3, hint, mat, color=None):
    verts = np.array(pts, float)
    for t in earcut.triangulate_float64(verts, np.array([len(pts)], np.uint32)).reshape(-1, 3):
        m.poly(mat, [to3(verts[j]) for j in t], hint, color=color)


def profile_wall(m, u, pts, sgn, mat='wall', color=None):
    """A gable along v at u, its outline [(v, h)] given round from one foot to the other."""
    _fill(m, pts, lambda p: (u, p[1], p[0]), (sgn, 0, 0), mat, color)


def profile_wall_v(m, v, pts, sgn, mat='wall', color=None):
    """The same across u at v: pts [(u, h)]."""
    _fill(m, pts, lambda p: (p[0], p[1], v), (0, 0, sgn), mat, color)


# ----------------------------------------------------------------------------------------------------------------------------- the low parts
def parts():
    """The rectangles that build their own walls, (u0, u1, v0, v1): footprint edges along them are not drawn again as the links' walls."""
    out = [(a, b, c, d) for (a, b), (c, d), _, _ in GALLERIES]
    out += [NW, NE, TOWER, PORCH[:4]] + [x[:4] for x in NW_AISLES]
    return out


def on_part(a, b):
    mu, mv = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    for u0, u1, v0, v1 in parts():
        if u0 - 0.15 <= mu <= u1 + 0.15 and v0 - 0.15 <= mv <= v1 + 0.15:
            if min(abs(mu - u0), abs(mu - u1)) < 0.2 or min(abs(mv - v0), abs(mv - v1)) < 0.2:
                return True
    return False


def add_links(m, hb):
    """The corridors round the court and the entrance between the halls: walls where no other part stands, a flat roof over the footprint, glass to the court."""
    n = len(RING)
    for i in range(n):
        a, b = RING[i], RING[(i + 1) % n]
        if on_part(a, b):
            continue
        w = WallFrame(a, b)
        if abs(a[1] - ENTRANCE[2]) < 0.05 and abs(b[1] - ENTRANCE[2]) < 0.05:
            glazing(m, w, 0, w.length, hb, LINK_TOP - 0.25, 'glass', round(w.length / 1.5), 2)
        else:
            m.wall('wall', w, hb, LINK_TOP)
        m.wbox('painted', w, 0.0, w.length, LINK_TOP - 0.25, LINK_TOP + 0.05, 0.0, 0.1, color=WHITE)
    # the roof: the footprint less the court
    verts = np.array(RING + COURT[::-1], float)
    tri = earcut.triangulate_float64(verts, np.array([len(RING), len(RING) + len(COURT)], np.uint32)).reshape(-1, 3)
    for t in tri:
        m.poly('metal', [(verts[j][0], LINK_TOP, verts[j][1]) for j in t], UP, uvs=[(verts[j][0], verts[j][1]) for j in t])
    # the canopy over the entrance stair, between the halls, the name on its edge towards the fjord
    c0, c1, cn, cs = CANOPY
    m.box('painted', (c0, LINK_TOP - 0.05, cn), (c1, LINK_TOP + 0.5, cs), color=WHITE)
    front = WallFrame((c0, cn), (c1, cn))
    sign(m, front, front.length / 2 - 2.3, front.length / 2 + 2.3, LINK_TOP + 0.0, LINK_TOP + 0.46)
    for k in range(5):  # the stair up from the quay
        m.box('painted', (c0 + 0.3, hb, cn + 0.4 + k * 0.45), (c1 - 0.3, hb + 0.45 + (k + 1) * 0.16, cs), color=STEP, skip=('b', 's'))
    # the court: glass all round, between slim white posts
    for a, b in zip(COURT, COURT[1:] + COURT[:1]):
        w = WallFrame(b, a)  # facing into the court
        glazing(m, w, 0, w.length, hb, LINK_TOP - 0.4, 'glass', round(w.length / 1.4), 2)
        m.wbox('painted', w, 0, w.length, LINK_TOP - 0.4, LINK_TOP, 0.0, 0.05, color=WHITE)


def sign(m, w, s0, s1, h0, h1, d=0.03):
    m.poly('sign', [w.p(s0, h0, d), w.p(s1, h0, d), w.p(s1, h1, d), w.p(s0, h1, d)], w.n, uvs=[(0, 1), (1, 1), (1, 0), (0, 0)])


def add_galleries(m, hb):
    for (u0, u1), (v0, v1), nu, nv in GALLERIES:
        ring = rect_ring(u0, u1, v0, v1)
        for i in range(4):
            a, b = ring[i], ring[(i + 1) % 4]
            f = Facade(m, a, b, hb, GAL_EAVE, 'wall')
            if a in GAL_GLASS:
                (g0, g1), sill, head = GAL_GLASS[a]
                n = round(abs(g1 - g0) / 2.6)
                for k in range(n):
                    c0 = f.at(g0 + (g1 - g0) * k / n)
                    c1 = f.at(g0 + (g1 - g0) * (k + 1) / n)
                    f.win((c0 + c1) / 2, abs(c1 - c0) - 0.45, sill, head, panes=(2, 2), depth=0.3)
            for p, q, wins, sill, head in GAL_WIN:
                if abs(WallFrame(p, q).t2 @ f.w.t2 - 1) < 1e-3 and abs(f.w.n2 @ (np.array(p) - np.array(a))) < 0.2:
                    for c0, c1 in wins:
                        s0, s1 = sorted((f.at(c0), f.at(c1)))
                        if 0 < s0 and s1 < f.w.length:
                            f.win((s0 + s1) / 2, s1 - s0, sill, head, panes=(2, 1), depth=0.25)
            f.done()
        cornice(m, ring, GAL_EAVE, band=0.7)  # the concrete beam over the piers, and the eaves
        for cu, cv in ring:
            m.box('painted', (cu - .24, hb, cv - .24), (cu + .24, GAL_EAVE - 0.7, cv + .24), color=WHITE, skip=('t', 'b'))
        du, dv = (u1 - u0) / nu, (v1 - v0) / nv
        for i in range(nu):
            for j in range(nv):
                module(m, u0 + i * du, u0 + (i + 1) * du, v0 + j * dv, v0 + (j + 1) * dv)


# --------------------------------------------------------------------------------------------------------------------------- the west hall
def nw_profile(n=12):
    """The west hall's outline along v: [(v, h)] from the north face's foot over the top to the south end."""
    (fv, fh), top, (t0, t1) = NW_FOOT, NW_TOP, NW_TOP_V
    north = [(fv + (t0 - fv) * math.sin(a), top - (top - fh) * math.cos(a)) for a in np.linspace(0, math.pi / 2, n)]
    south = [(t1 + (NW[3] - t1) * t, NW_END + (top - NW_END) * (1 - t) ** 2) for t in np.linspace(0, 1, n)]
    return north, south


def add_nw_hall(m, hb):
    u0, u1, v0, v1 = NW
    north, south = nw_profile()
    for prof, mat in ((north, 'metal'), (south, 'metal')):
        for (va, ha), (vb, hb_) in zip(prof, prof[1:]):
            q = [(u0 - 0.2, ha, va), (u1 + 0.2, ha, va), (u1 + 0.2, hb_, vb), (u0 - 0.2, hb_, vb)]
            nrm = (0, vb - va, -(hb_ - ha))
            if nrm[1] < 0:
                nrm = (0, -nrm[1], -nrm[2])
            m.poly(mat, q, nrm, uvs=[(p[0], math.hypot(p[1], p[2])) for p in q])
    (t0, t1), top = NW_TOP_V, NW_TOP
    m.poly('skyglass', [(u0, top, t0), (u1, top, t0), (u1, top, t1), (u0, top, t1)], UP, uvs=[(u0 / 1.6, t0), (u1 / 1.6, t0), (u1 / 1.6, t1), (u0 / 1.6, t1)])
    # the gables follow the roof
    outline = [(v0, NW_SIDE), (v0, NW_FOOT[1])] + north + south + [(v1, NW_SIDE)]
    for u, sgn in ((u0, -1), (u1, 1)):  # concrete frame and brick below, plain above
        m.poly('wall', [(u, hb, v0), (u, hb, v1), (u, NW_SIDE, v1), (u, NW_SIDE, v0)], (sgn, 0, 0))
        profile_wall(m, u, outline, sgn, 'painted', WHITE)
    m.wall('wall', WallFrame((u0, v0), (u1, v0)), hb, NW_FOOT[1])
    m.poly('metal', [(u0, NW_FOOT[1], v0), (u1, NW_FOOT[1], v0), (u1, NW_FOOT[1], NW_FOOT[0]), (u0, NW_FOOT[1], NW_FOOT[0])], UP)
    m.wall('wall', WallFrame((u1, v1), (u0, v1)), hb, NW_END)
    for a0, a1, b0, b1, top in NW_AISLES:
        ring = rect_ring(a0, a1, b0, b1)
        walls(m, ring, hb, top)
        flat(m, 'metal', ring, top)
        cornice(m, ring, top, depth=0.15, band=0.3)
    # the glazed corner beside the portico, two storeys in a concrete frame
    for w in (WallFrame((28.4, 8.7), (31.1, 8.7)), WallFrame((31.1, 8.7), (31.1, 13.3))):
        for y0, y1 in ((hb + 0.4, 2.3), (3.0, 6.2)):
            glazing(m, w, 0.35, w.length - 0.35, y0, y1, 'glass', max(1, round(w.length / 1.4)), 2, d=0.04)
        m.wbox('painted', w, 0, w.length, 2.3, 3.0, 0.0, 0.08, color=WHITE, top=False)
    add_porch(m, hb)


def add_porch(m, hb):
    """The two-storey portico before the hall's north face: four columns, a beam at the floor, glass behind."""
    u0, u1, v0, v1, top = PORCH
    m.box('wall', (u0, top - 0.5, v0), (u1, top, v1), skip=('b', 't'))
    flat(m, 'metal', rect_ring(u0, u1, v0, v1), top)
    flat(m, 'painted', rect_ring(u0, u1, v0, v1), top - 0.5, color=WHITE, down=True)
    for u in PORCH_COLS:
        m.box('wall', (u - 0.3, hb, v0), (u + 0.3, top - 0.5, v0 + 0.6), skip=('t', 'b'))
    m.box('painted', (u0, 2.3, v0), (u1, 2.9, v0 + 0.5), color=WHITE)
    glass = WallFrame((u0, v0 + 1.4), (u1, v0 + 1.4))
    glazing(m, glass, 0, glass.length, hb, top - 0.5, 'glass', 8, 4)
    for u, sgn in ((u0, -1), (u1, 1)):
        m.poly('wall', [(u, hb, v0), (u, hb, v1), (u, top - 0.5, v1), (u, top - 0.5, v0)], (sgn, 0, 0))


# --------------------------------------------------------------------------------------------------------------------------- the east hall
def ne_profile(n=10):
    """The east hall's outline across u: [(u, h)] from the west eave over the crest to the east eave."""
    u0, u1 = NE[0], NE[1]
    (wu, wh), crest, (du, dh) = NE_WEST, NE_CREST, NE_DROP
    west = [(wu - (wu - u0) * (1 - math.cos(a)), NE_W_EAVE + (wh - NE_W_EAVE) * (1 - math.sin(a))) for a in np.linspace(math.pi / 2, 0, n)]
    east = [(du + (u1 - du) * (1 - math.cos(a)), NE_EAST + (dh - NE_EAST) * (1 - math.sin(a))) for a in np.linspace(0, math.pi / 2, n)]
    return west + [crest] + east


def add_ne_hall(m, hb):
    u0, u1, v0, v1 = NE
    prof = ne_profile()
    for (ua, ha), (ub, hb_) in zip(prof, prof[1:]):
        q = [(ua, ha, v0 - 0.2), (ub, hb_, v0 - 0.2), (ub, hb_, v1 + 0.2), (ua, ha, v1 + 0.2)]
        nrm = np.array((-(hb_ - ha), ub - ua, 0.0))
        m.poly('metal', q, nrm if nrm[1] >= 0 else -nrm, uvs=[(p[2], math.hypot(p[0], p[1])) for p in q])
    # the solar panels on the slope up to the crest
    (wu, wh), (cu, ch) = NE_WEST, NE_CREST
    sp = lambda t, v: (wu + (cu - wu) * t, wh + (ch - wh) * t + 0.07, v)
    q = [sp(0.04, v0 + 1.2), sp(0.96, v0 + 1.2), sp(0.96, v1 - 0.8), sp(0.04, v1 - 0.8)]
    m.poly('solar', q, (-(ch - wh), cu - wu, 0), uvs=[(p[2], math.hypot(p[0] - wu, p[1]) / 1.6) for p in q])
    # the side walls under the two eaves, and the gables: concrete frame and brick below the eaves, plain above
    m.wall('wall', WallFrame((u0, v1), (u0, v0)), hb, NE_W_EAVE)
    m.wall('wall', WallFrame((u1, v0), (u1, v1)), hb, NE_EAST)
    upper = prof + [(u1, NE_W_EAVE)]
    for v, sgn in ((v0, -1), (v1, 1)):
        m.poly('wall', [(u0, hb, v), (u1, hb, v), (u1, NE_W_EAVE, v), (u0, NE_W_EAVE, v)], (0, 0, sgn))
        profile_wall_v(m, v, upper, sgn, 'painted', WHITE)
    # the north gable's tall window between two fins, a beam over the door
    a, b, sill, head = NE_SLOT
    m.poly('glass', [(a, hb, v0 - 0.05), (b, hb, v0 - 0.05), (b, head, v0 - 0.05), (a, head, v0 - 0.05)], (0, 0, -1), uvs=[(0, 0), (2, 0), (2, 9), (0, 9)])
    for u in (a - 0.5, b):
        m.box('painted', (u, hb, v0 - 0.9), (u + 0.5, head + 0.9, v0), color=WHITE, skip=('b',))
    m.box('painted', (a, 2.5, v0 - 0.7), (b, 3.0, v0), color=WHITE)
    for c0, c1 in ((u0, a - 0.5), (b + 0.5, u1)):  # the eaves line on the gable
        m.box('painted', (c0, NE_W_EAVE - 0.5, v0 - 0.12), (c1, NE_W_EAVE + 0.05, v0), color=WHITE)
    for w, y in ((WallFrame((u0, v1), (u0, v0)), NE_W_EAVE), (WallFrame((u1, v0), (u1, v1)), NE_EAST)):
        m.wbox('painted', w, -0.2, w.length + 0.2, y - 0.5, y + 0.05, 0.0, 0.2, color=WHITE)


# --------------------------------------------------------------------------------------------------------------------------------- the tower
def add_tower(m, hb):
    u0, u1, v0, v1 = TOWER
    ring = rect_ring(u0, u1, v0, v1)
    fs = {k: Facade(m, ring[i], ring[(i + 1) % 4], hb, TOWER_EAVE, 'wall') for i, k in enumerate('nesw')}
    for side, a, b, sill, head in TOWER_WIN:
        f = fs[side]
        s0, s1 = sorted((f.at(a), f.at(b)))
        f.win((s0 + s1) / 2, s1 - s0, sill, head, panes=(2, 2), depth=0.3)
    for f in fs.values():
        f.done()
    cornice(m, ring, TOWER_EAVE, depth=0.35, band=0.6)
    # the roof: four concave faces from the eaves to the lantern's foot
    l0, l1, k0, k1 = LANTERN
    top = rect_ring(l0, l1, k0, k1)
    g = lambda t: TOWER_EAVE + (LANTERN_FOOT - TOWER_EAVE) * t ** 3
    rows = 8
    for i in range(4):
        a, b, c, d = ring[i], ring[(i + 1) % 4], top[(i + 1) % 4], top[i]
        for k in range(rows):
            t0, t1 = k / rows, (k + 1) / rows
            pt = lambda e, f_, t: (e[0] + (f_[0] - e[0]) * t, g(t), e[1] + (f_[1] - e[1]) * t)
            q = [pt(a, d, t0), pt(b, c, t0), pt(b, c, t1), pt(a, d, t1)]
            out = np.array((b[1] - a[1], 0, a[0] - b[0]), float)
            m.poly('metal', q, out * 0.3 + np.array(UP), uvs=[(p[0] * (b[0] - a[0]) / max(math.dist(a, b), 1e-9) + p[2] * (b[1] - a[1]) / max(math.dist(a, b), 1e-9), p[1] * 1.6) for p in q])
    # the lantern: a white collar, a glazed pyramid
    m.box('painted', (l0, LANTERN_FOOT, k0), (l1, LANTERN_FOOT + 0.5, k1), color=WHITE, skip=('b',))
    cu, cv = (l0 + l1) / 2, (k0 + k1) / 2
    y = LANTERN_FOOT + 0.5
    for i in range(4):
        a, b = top[i], top[(i + 1) % 4]
        m.poly('skyglass', [(a[0], y, a[1]), (b[0], y, b[1]), (cu, LANTERN_TOP, cv)], (b[1] - a[1], 2.0, a[0] - b[0]), uvs=[(0, 0), (3, 0), (1.5, 2)])


def build(hb=-2.5):
    m = Model()
    add_links(m, hb)
    add_galleries(m, hb)
    add_nw_hall(m, hb)
    add_ne_hall(m, hb)
    add_tower(m, hb)
    return m


# ------------------------------------------------------------------------------------------------------------------------------------- textures
TONES = {'brick': (0.62, 0.60, 0.55), 'mortar': (0.75, 0.74, 0.71), 'pier': (0.85, 0.85, 0.84), 'metal': (0.80, 0.82, 0.84)}


def wall_texture(w=512, h=256):
    """The walls: a concrete frame filled with grey-beige brick. Piers 0.45 m wide every 2.52 m; between them brick in running bond, 24 cm by 6.4 cm with its joints.
    A repeat of 5.04 m by 2.56 m."""
    rs = np.random.default_rng(81)
    y, x = np.mgrid[0:h, 0:w] + .5
    course = (y / h * 40).astype(int)
    bx = x / w * 21 + 0.5 * (course % 2)
    tone = rs.normal(0, 1, (40, 21))[course, bx.astype(int) % 21][..., None]
    warm = rs.random((40, 21))[course, bx.astype(int) % 21][..., None]
    brick = np.array(albedo(TONES['brick'])) * (1 + 0.09 * tone) * (1 + np.array((0.05, 0.0, -0.06)) * (warm - 0.5))
    joint = ((y / h * 40) % 1 < 0.17) | (bx % 1 < 0.05)
    img = np.where(joint[..., None], np.array(albedo(TONES['mortar'])), brick)
    grain = np.tile(periodic_noise(h, 0.6, 82, low=12), (1, w // h))
    img = img * (1 + 0.04 * grain)[..., None]
    px = x / w * 2 % 1  # two piers to the repeat
    pier = px < 0.45 / 2.52
    img[pier] = (np.array(albedo(TONES['pier'])) * (1 + 0.025 * grain)[..., None])[pier]
    img[(px >= 0.45 / 2.52) & (px < 0.47 / 2.52)] *= 0.72
    img[px > 1 - 0.02 / 2.52] *= 0.72
    return to_image(np.clip(img, 0, 1))


def metal_texture(n=256):
    """Standing-seam aluminium, a seam every 0.5 m of the 2 m repeat."""
    img = tiled(TONES['metal'], 83, grain=0.012, wash=0.035, stretch=(0.2, 1.0), n=n)
    x = (np.arange(n) + .5) / n * 4 % 1
    prof = 0.95 + 0.12 * np.exp(-((np.minimum(x, 1 - x)) / 0.04) ** 2) - 0.12 * np.exp(-((np.minimum(x, 1 - x) - 0.07) / 0.035) ** 2)
    img *= prof[None, :, None]
    return to_image(np.clip(img, 0, 1))


def pane_texture(pane, frame, seed, bar=0.05, shade=0.6, n=128):
    y, x = np.mgrid[0:n, 0:n] + .5
    fx, fy = x / n, y / n
    img = np.array(pane)[None, None] * (1 + shade * fy)[..., None] * (1 + .15 * periodic_noise(n, 1.3, seed, low=1))[..., None]
    img[(np.minimum(fx, 1 - fx) < bar) | (np.minimum(fy, 1 - fy) < bar)] = frame
    return to_image(np.clip(img, 0, 1))


def solar_texture(n=128):
    """Solar panels, 1.0 m by 1.6 m, in their silver frames."""
    return pane_texture((0.035, 0.05, 0.09), albedo((0.62, 0.64, 0.66)), 85, bar=0.025, shade=0.15, n=n)


def sign_texture(w=256, h=64):
    """'Utzon' in dark letters on the fascia's white."""
    try:
        font = ImageFont.load_default(size=56)
    except TypeError:
        font = ImageFont.load_default()
    ground = tuple(int(c) for c in np.asarray(to_image(np.array(albedo((0.86, 0.86, 0.84)))[None, None]))[0, 0])
    img = Image.new('RGB', (w, h), ground)
    box = ImageDraw.Draw(img).textbbox((0, 0), 'Utzon', font=font)
    line = Image.new('RGB', (box[2] - box[0] + 8, box[3] - box[1] + 8), ground)
    ImageDraw.Draw(line).text((4 - box[0], 4 - box[1]), 'Utzon', font=font, fill=(40, 42, 46))
    line = line.resize((int(h * 0.8 * line.size[0] / line.size[1]), int(h * 0.8)), Image.LANCZOS)
    img.paste(line, ((w - line.size[0]) // 2, (h - line.size[1]) // 2))
    return img


TEXTURES = {
    'wall': wall_texture, 'metal': metal_texture, 'solar': solar_texture, 'sign': sign_texture,
    'glass': lambda: pane_texture((0.03, 0.045, 0.06), albedo((0.86, 0.86, 0.84)), 87),
    'skyglass': lambda: pane_texture((0.05, 0.08, 0.11), albedo((0.86, 0.86, 0.84)), 89, bar=0.04, shade=0.25),
}
MATERIALS = {
    'wall': dict(tile=(5.04, 2.56), roughness=0.85),
    'metal': dict(tile=(2.0, 2.0), roughness=0.35, metallic=0.55),
    'solar': dict(tile=(1.0, 1.0), roughness=0.2, metallic=0.4),
    'sign': dict(tile=(1.0, 1.0), roughness=0.85),
    'glass': dict(tile=(1.0, 1.0), roughness=0.15, metallic=0.5),
    'skyglass': dict(tile=(1.0, 1.0), roughness=0.15, metallic=0.5),
    'painted': dict(tile=None, roughness=0.7),
}
ATTRIBUTION = {
    'skraafoto-2021': {'text': 'Skråfoto 2021, Klimadatastyrelsen (measurements and colours), and its surface model (roof levels)', 'licence': 'CC BY 4.0 terms for free geographic data',
                       'url': 'https://dataforsyningen.dk'},
    'geodanmark': {'text': 'GeoDanmark Bygning (footprint)', 'licence': 'CC BY 4.0', 'url': 'https://www.geodanmark.dk'},
    'commons-liberaler-humanist-2018': {'text': 'Liberaler Humanist, Utzon Center, Eastern side, Aalborg and Utzon Center, Aalborg, 20.07.2018, Wikimedia Commons (reference only for the brick '
                                                'infill and the lanterns: no pixels, no measurements)', 'licence': 'CC BY-SA 3.0',
                                        'url': 'https://commons.wikimedia.org/wiki/File:Utzon_Center,_Eastern_side,_Aalborg.jpg'},
}


def twin_xz(u, v):
    a = math.radians(AXIS_DEG)
    return ORIGIN[0] + u * math.cos(a) - v * math.sin(a), ORIGIN[1] + u * math.sin(a) + v * math.cos(a)


def footprint_match(frame, cell=0.25):
    """IoU of the model's plan (the footprint it is drawn on, less the court) with the GeoDanmark footprint, on a 25 cm raster: a check of the frame."""
    rec = frame.buildings(TILE)[GDK_ID]
    gdk, gdk_holes = flat_to_pts(rec['ring']), [flat_to_pts(h) for h in rec.get('holes') or []]
    mine, mine_holes = [twin_xz(u, v) for u, v in RING], [[twin_xz(u, v) for u, v in COURT]]
    xs = [p[0] for p in gdk + mine]
    zs = [p[1] for p in gdk + mine]
    x0, z0 = min(xs) - 1, min(zs) - 1
    size = (int((max(xs) - x0 + 1) / cell), int((max(zs) - z0 + 1) / cell))
    masks = []
    for ring, holes in ((gdk, gdk_holes), (mine, mine_holes)):
        img = Image.new('1', size, 0)
        d = ImageDraw.Draw(img)
        d.polygon([((x - x0) / cell, (z - z0) / cell) for x, z in ring], fill=1)
        for h in holes:
            d.polygon([((x - x0) / cell, (z - z0) / cell) for x, z in h], fill=0)
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
                                      root_extras={'building_id': GDK_ID, 'source_ids': list(ATTRIBUTION)[:2], 'attribution': list(ATTRIBUTION), 'confidence': 'observed'},
                                      asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                                      attribution=list(ATTRIBUTION), generator='tools/overrides/utzon_center.py')
    rel = 'meshes/gdk_1019266816.glb'
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    (out / rel).write_bytes(body)
    entry = {
        'tile': TILE, 'mode': 'replace', 'covers': [GDK_ID], 'footprint': {'use': 'gdk'},
        'match': {'kind': '1:1', 'iou': round(iou, 3), 'hausdorff': 0.2},
        'source': {'ids': list(ATTRIBUTION)[:2], 'kind': 'skraafoto', 'reconstruction': 'tools/overrides/utzon_center.py'},
        'confidence': 'observed', 'attribution': list(ATTRIBUTION),
        'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': rec['ground'], 'low': round(low, 2), 'sunk': 0.25,
        'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
    }
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': {GDK_ID: entry}})
    print(f'{out}: {mesh["triangles"]} triangles, {len(body) / 1e6:.2f} MB GLB, {mesh["textureBytes"] / 1e6:.2f} MB textures, top {hi[1]:.2f}')


if __name__ == '__main__':
    main()
