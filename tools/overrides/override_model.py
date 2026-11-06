"""The building blocks of the overrides that are modelled from drawings (tools/overrides/ansgars_kirke.py, hvide_hus.py): a triangle soup per material in a
building's own frame (u along its main axis, h up, v across, right-handed like the twin's x, y, z), walls with real openings, mouldings, lofts and round parts,
tileable noise, and the step to a GLB in the twin's frame.

Every face's winding agrees with its normal. UVs are in metres until the GLB is written, when each material's repeat divides them.
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from overrides_lib import GlbWriter, albedo_from_linear, linear_to_srgb, srgb_to_linear, texture_bytes

UP = np.array([0.0, 1.0, 0.0])


def rgb(*srgb):
    return tuple(float(c) for c in srgb_to_linear(np.array(srgb))) + (1.0,)


GOLD = rgb(.72, .56, .24)


class WallFrame:
    """A vertical plane: s along the wall from `a`, h up, d out of the wall."""

    def __init__(self, a, b=None, t=None):
        self.a = np.array(a, float)
        if b is not None:
            d = np.array(b, float) - self.a
            self.length = float(np.hypot(*d))
            self.t2 = d / self.length
        else:
            self.t2, self.length = np.array(t, float), 0.0
        self.n2 = np.array([self.t2[1], -self.t2[0]])  # outward on a clockwise ring
        self.t = np.array([self.t2[0], 0, self.t2[1]])
        self.n = np.array([self.n2[0], 0, self.n2[1]])

    def p(self, s, h, d=0.0):
        q = self.a + self.t2 * s + self.n2 * d
        return np.array([q[0], h, q[1]])

    def at(self, coord):
        """s of an absolute u or v along this wall."""
        axis = 0 if abs(self.t2[0]) > 0.5 else 1
        return (coord - self.a[axis]) * self.t2[axis]


def arch(sill, top, w, seg=8):
    r = w / 2
    sp = top - r
    return [(sill, r), (sp, r)] + [(sp + r * math.sin(k / seg * math.pi / 2), r * math.cos(k / seg * math.pi / 2)) for k in range(1, seg + 1)]


def circle(hc, r, seg=14):
    return [(hc + r * math.sin(-math.pi / 2 + k / seg * math.pi), r * math.cos(-math.pi / 2 + k / seg * math.pi)) for k in range(seg + 1)]


def rect(h0, h1, w):
    return [(h0, w / 2), (h1, w / 2)]


def half_width(outline, h):
    for (h0, w0), (h1, w1) in zip(outline, outline[1:]):
        if h0 - 1e-9 <= h <= h1 + 1e-9:
            return w0 if h1 - h0 < 1e-9 else w0 + (w1 - w0) * (h - h0) / (h1 - h0)
    return 0.0


class Model:
    def __init__(self):
        self.parts = defaultdict(lambda: {'p': [], 'n': [], 'uv': [], 'c': []})

    # ------------------------------------------------------------------------------------------------------- primitives (all in the church frame)
    def tri(self, mat, pts, nors, uvs, color=None):
        q = self.parts[mat]
        q['p'] += pts
        q['n'] += nors
        q['uv'] += uvs
        q['c'] += [color or (1, 1, 1, 1)] * 3

    def poly(self, mat, pts, hint, uvs=None, color=None, nors=None):
        """A convex planar polygon whose normal is turned towards `hint`; uvs in metres (default: planar on the face)."""
        pts = [np.asarray(p, float) for p in pts]
        hint = np.asarray(hint, float)
        keep = [i for i in range(len(pts)) if np.linalg.norm(pts[i] - pts[i - 1]) > 1e-6]
        pts = [pts[i] for i in keep]
        uvs = [uvs[i] for i in keep] if uvs is not None else None
        nors = [nors[i] for i in keep] if nors is not None else None
        if len(pts) < 3:
            return
        n = np.zeros(3)
        for i in range(1, len(pts) - 1):
            n += np.cross(pts[i] - pts[0], pts[i + 1] - pts[0])
        ln = np.linalg.norm(n)
        if ln < 1e-9:
            return
        if n @ hint < 0:
            pts, n = pts[::-1], -n
            uvs = uvs[::-1] if uvs is not None else None
            nors = nors[::-1] if nors is not None else None
        n = n / ln
        if uvs is None:
            if abs(n[1]) > 0.9:
                uvs = [(p[0], p[2]) for p in pts]
            else:
                t = np.cross(UP, n)
                t = t / np.linalg.norm(t)
                uvs = [(p @ t, p[1]) for p in pts]
        for i in range(1, len(pts) - 1):
            k = (0, i, i + 1)
            self.tri(mat, [pts[j] for j in k], [nors[j] for j in k] if nors is not None else [n, n, n], [uvs[j] for j in k], color)

    def box(self, mat, a, b, color=None, skip=()):
        (u0, h0, v0), (u1, h1, v1) = a, b
        f = {'n': ([(u0, h0, v0), (u1, h0, v0), (u1, h1, v0), (u0, h1, v0)], (0, 0, -1)), 's': ([(u0, h0, v1), (u1, h0, v1), (u1, h1, v1), (u0, h1, v1)], (0, 0, 1)),
             'w': ([(u0, h0, v0), (u0, h0, v1), (u0, h1, v1), (u0, h1, v0)], (-1, 0, 0)), 'e': ([(u1, h0, v0), (u1, h0, v1), (u1, h1, v1), (u1, h1, v0)], (1, 0, 0)),
             't': ([(u0, h1, v0), (u1, h1, v0), (u1, h1, v1), (u0, h1, v1)], (0, 1, 0)), 'b': ([(u0, h0, v0), (u1, h0, v0), (u1, h0, v1), (u0, h0, v1)], (0, -1, 0))}
        for k, (pts, n) in f.items():
            if k not in skip:
                self.poly(mat, pts, n, color=color)

    def wbox(self, mat, w, s0, s1, h0, h1, d0, d1, color=None, top=True):
        """A box on a wall plane: s0..s1 along it, d0..d1 out of it."""
        c = lambda s, h, d: w.p(s, h, d)
        self.poly(mat, [c(s0, h0, d1), c(s1, h0, d1), c(s1, h1, d1), c(s0, h1, d1)], w.n, color=color)
        self.poly(mat, [c(s0, h0, d0), c(s0, h0, d1), c(s0, h1, d1), c(s0, h1, d0)], -w.t, color=color)
        self.poly(mat, [c(s1, h0, d0), c(s1, h0, d1), c(s1, h1, d1), c(s1, h1, d0)], w.t, color=color)
        if top:
            self.poly(mat, [c(s0, h1, d0), c(s1, h1, d0), c(s1, h1, d1), c(s0, h1, d1)], UP, color=color)
        self.poly(mat, [c(s0, h0, d0), c(s1, h0, d0), c(s1, h0, d1), c(s0, h0, d1)], -UP, color=color)

    def wall(self, mat, w, h0, h1, openings=()):
        """The plane of a wall with its openings cut out, in horizontal strips: openings = [(s centre, outline [(h, half width) rising])]."""
        hs = sorted({h0, h1} | {h for _, o in openings for h, _ in o if h0 < h < h1})
        for y0, y1 in zip(hs, hs[1:]):
            active = sorted((c, o) for c, o in openings if o[0][0] <= y0 + 1e-9 and o[-1][0] >= y1 - 1e-9)
            s0, s1 = 0.0, 0.0
            for c, o in active:
                l0, l1 = c - half_width(o, y0), c - half_width(o, y1)
                self.poly(mat, [w.p(s0, y0), w.p(l0, y0), w.p(l1, y1), w.p(s1, y1)], w.n)
                s0, s1 = c + half_width(o, y0), c + half_width(o, y1)
            self.poly(mat, [w.p(s0, y0), w.p(w.length, y0), w.p(w.length, y1), w.p(s1, y1)], w.n)

    def reveal(self, w, c, outline, depth, fill='glass', color=None, side='stone', head=None):
        """The depth of an opening cut by `wall`, and what closes it at the back (glass by default, panes in metres from the opening's foot)."""
        foot = outline[0][0]
        for (h0, a0), (h1, a1) in zip(outline, outline[1:]):
            for sgn in (-1, 1):
                hint = -sgn * w.t + UP * (a0 - a1) * (-1)
                self.poly(side, [w.p(c + sgn * a0, h0), w.p(c + sgn * a1, h1), w.p(c + sgn * a1, h1, -depth), w.p(c + sgn * a0, h0, -depth)], hint)
            uv = [(-a0, h0 - foot), (a0, h0 - foot), (a1, h1 - foot), (-a1, h1 - foot)] if fill == 'glass' else None
            self.poly(fill, [w.p(c - a0, h0, -depth), w.p(c + a0, h0, -depth), w.p(c + a1, h1, -depth), w.p(c - a1, h1, -depth)], w.n, uvs=uv, color=color)
        (h0, a0), (h1, a1) = outline[0], outline[-1]
        if a0 > 0.01:
            self.poly(side, [w.p(c - a0, h0), w.p(c + a0, h0), w.p(c + a0, h0, -depth), w.p(c - a0, h0, -depth)], UP)
        if a1 > 0.01:
            self.poly(head or side, [w.p(c - a1, h1), w.p(c + a1, h1), w.p(c + a1, h1, -depth), w.p(c - a1, h1, -depth)], -UP)

    def frame(self, mat, w, c, outline, width, proj, closed=False, color=None):
        """A moulding around an opening, standing `proj` out of the wall: up its left side, over the top, down its right."""
        path = [(c - a, h) for h, a in outline] + [(c + a, h) for h, a in reversed(outline) if a > 0.003]
        path = np.array(path, float)
        if closed:
            path = np.vstack([path, path[:1]])
        d = np.diff(path, axis=0)
        d = d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
        nrm = np.column_stack([-d[:, 1], d[:, 0]])
        vn = np.zeros_like(path)
        vn[:-1] += nrm
        vn[1:] += nrm
        if closed:
            vn[0] += nrm[-1]
            vn[-1] = vn[0]
        vn = vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-9)
        out = path + vn * width
        for i in range(len(path) - 1):
            a, b, oa, ob = path[i], path[i + 1], out[i], out[i + 1]
            n3 = w.t * nrm[i][0] + UP * nrm[i][1]
            self.poly(mat, [w.p(a[0], a[1], proj), w.p(b[0], b[1], proj), w.p(ob[0], ob[1], proj), w.p(oa[0], oa[1], proj)], w.n, color=color)
            self.poly(mat, [w.p(oa[0], oa[1], proj), w.p(ob[0], ob[1], proj), w.p(ob[0], ob[1]), w.p(oa[0], oa[1])], n3, color=color)
            self.poly(mat, [w.p(a[0], a[1], proj), w.p(b[0], b[1], proj), w.p(b[0], b[1]), w.p(a[0], a[1])], -n3, color=color)

    def band(self, mat, ring, profile, color=None):
        """A moulding around a clockwise rectilinear ring: profile = [(offset out of the ring, h)], in order going up."""
        n = len(ring)
        ring = np.array(ring, float)
        nor = []
        for i in range(n):
            d = ring[(i + 1) % n] - ring[i]
            d = d / np.linalg.norm(d)
            nor.append(np.array([d[1], -d[0]]))
        off = [nor[i] + nor[i - 1] for i in range(n)]
        for (o0, h0), (o1, h1) in zip(profile, profile[1:]):
            for i in range(n):
                j = (i + 1) % n
                a0, b0 = ring[i] + off[i] * o0, ring[j] + off[j] * o0
                a1, b1 = ring[i] + off[i] * o1, ring[j] + off[j] * o1
                hint = np.array([nor[i][0], 0, nor[i][1]]) * (h1 - h0) + UP * (o0 - o1)
                self.poly(mat, [(a0[0], h0, a0[1]), (b0[0], h0, b0[1]), (b1[0], h1, b1[1]), (a1[0], h1, a1[1])], hint, color=color)

    def loft(self, mat, cu, cv, profile, sides=4, rot=0.0, seams=None, smooth=True, color=None):
        """A tapering body: profile = [(half across the flats, h)] going up. seams: the copper's standing seams per face, which converge with the body."""
        step = 2 * math.pi / sides
        k = 1 / math.cos(step / 2)
        p = np.array(profile, float)
        arc = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
        for i in range(sides):
            a0 = rot + i * step - step / 2 - math.pi / 2  # face 0 looks north (-v)
            a1 = a0 + step
            mid = a0 + step / 2
            nh = np.array([math.cos(mid), 0, math.sin(mid)])
            width = 2 * p[0, 0] * math.tan(step / 2)
            nseam = seams or max(1.0, round(width / 0.5))
            for j in range(len(p) - 1):
                pts, uvs, nors = [], [], []
                for jj, aa, t in ((j, a0, -.5), (j, a1, .5), (j + 1, a1, .5), (j + 1, a0, -.5)):
                    r = p[jj, 0] * k
                    pts.append((cu + r * math.cos(aa), p[jj, 1], cv + r * math.sin(aa)))
                    uvs.append((t * nseam * 0.5 if mat in ('copper', 'dome') else t * 2 * p[jj, 0] * math.tan(step / 2), arc[jj]))
                    lo, hi = max(jj - 1, 0), min(jj + 1, len(p) - 1)
                    if not smooth:
                        lo, hi = j, j + 1
                    dr, dh = p[hi, 0] - p[lo, 0], p[hi, 1] - p[lo, 1]
                    v = nh * dh + UP * (-dr)
                    nors.append(v / max(np.linalg.norm(v), 1e-9))
                self.poly(mat, pts, nh + UP * (p[j, 0] - p[j + 1, 0]), uvs=uvs, nors=nors, color=color)

    def cylinder(self, mat, cu, cv, r, h0, h1, n=12, color=None, r1=None):
        """Upright, round, r at its foot and r1 (default r) at its head."""
        top = r if r1 is None else r1
        for i in range(n):
            a0, a1 = i / n * 2 * math.pi, (i + 1) / n * 2 * math.pi
            n0, n1 = np.array([math.cos(a0), 0, math.sin(a0)]), np.array([math.cos(a1), 0, math.sin(a1)])
            q = lambda a, h: (cu + (r if h == h0 else top) * math.cos(a), h, cv + (r if h == h0 else top) * math.sin(a))
            self.poly(mat, [q(a0, h0), q(a1, h0), q(a1, h1), q(a0, h1)], n0 + n1, nors=[n0, n1, n1, n0],
                      uvs=[(a0 * r, h0), (a1 * r, h0), (a1 * r, h1), (a0 * r, h1)], color=color)

    def ball(self, cu, h, cv, r, color=GOLD, n=10, st=6):
        for j in range(st):
            b0, b1 = -math.pi / 2 + j / st * math.pi, -math.pi / 2 + (j + 1) / st * math.pi
            for i in range(n):
                a0, a1 = i / n * 2 * math.pi, (i + 1) / n * 2 * math.pi
                dirs = [(math.cos(a) * math.cos(b), math.sin(b), math.sin(a) * math.cos(b)) for a, b in ((a0, b0), (a1, b0), (a1, b1), (a0, b1))]
                pts = [(cu + d[0] * r, h + d[1] * r, cv + d[2] * r) for d in dirs]
                mid = np.mean(dirs, axis=0)
                self.poly('painted', pts, mid, nors=[np.array(d) for d in dirs], color=color)

    def to_arrays(self):
        out = {}
        for m, q in self.parts.items():
            if q['p']:
                out[m] = {'p': np.array(q['p'], float), 'n': np.array(q['n'], float), 'uv': np.array(q['uv'], float), 'c': np.array(q['c'], float)}
        return out

    @property
    def triangles(self):
        return sum(len(q['p']) // 3 for q in self.parts.values())


def periodic_noise(n, beta=1.6, seed=0, stretch=(1.0, 1.0), low=1):
    """Tileable noise in -1..1: white noise shaped to 1/f^beta in the frequency plane."""
    rs = np.random.default_rng(seed)
    f = np.fft.fft2(rs.standard_normal((n, n)))
    fy, fx = np.meshgrid(np.fft.fftfreq(n) * n * stretch[1], np.fft.fftfreq(n) * n * stretch[0], indexing='ij')
    r = np.hypot(fx, fy)
    r[0, 0] = 1
    g = np.where(r >= low, r ** -beta, 0.0)
    g[0, 0] = 0
    a = np.fft.ifft2(f * g).real
    return a / max(np.abs(a).max(), 1e-9)


def albedo(srgb):
    """A colour measured in a photograph -> the twin's albedo, as the photo walls have it (overrides_lib): linear RGB."""
    return albedo_from_linear(srgb_to_linear(np.array(srgb, float)))


def to_image(lin):
    return Image.fromarray(np.round(linear_to_srgb(lin) * 255).astype(np.uint8), 'RGB')


def model_to_glb(model, axis_deg, origin, materials, textures, root_name, root_extras=None, asset_extras=None, attribution=(), generator='tools/overrides'):
    """The model as a GLB in the twin's frame -> (bytes, mesh block of an override entry, low corner, high corner).

    axis_deg: how far u lies from east towards south. origin: the frame's origin in the twin's local frame (x, y, z).
    materials: {name: {'tile': (w, h) metres of one repeat, or None for vertex colours, 'texture': key in `textures` (default: the name), 'color': factor,
    'roughness', 'metallic'}}. Materials that name the same texture share it.
    """
    w = GlbWriter(generator)
    a = math.radians(axis_deg)
    ca, sa = math.cos(a), math.sin(a)
    rot = np.array([[ca, 0, -sa], [0, 1, 0], [sa, 0, ca]])  # (u, h, v) -> (x, y, z)
    origin = np.array(origin, float)
    children, stats = [], {'triangles': 0, 'gpuBytes': 0}
    tex_sizes, tex_bytes, shared = [], 0, {}
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for name, q in model.to_arrays().items():
        spec = materials[name]
        pos = q['p'] @ rot.T + origin
        nor = q['n'] @ rot.T
        extras = {'part': name, 'conf': 'observed', 'attribution': list(attribution)}
        pbr = {k: spec[k] for k in ('roughness', 'metallic') if k in spec}
        if spec.get('tile') is not None:
            source = spec.get('texture', name)
            if source not in shared:
                tex, size, _ = w.texture(textures[source](), source, repeat=True, quality=88)
                shared[source] = tex
                tex_sizes.append(list(size))
                tex_bytes += texture_bytes(*size)
            mat = w.material(name, texture=shared[source], double=True, extras=extras, color=spec.get('color', (1, 1, 1, 1)), **pbr)
            node, st = w.mesh(name, pos, nor, uv=q['uv'] / np.array(spec['tile']), uv_tiling=True, material=mat, extras=extras)
        else:
            mat = w.material(name, double=True, extras=extras, **pbr)
            node, st = w.mesh(name, pos, nor, color=q['c'], material=mat, extras=extras)
        children.append(node)
        stats['triangles'] += st['triangles']
        stats['gpuBytes'] += st['gpuBytes']
        lo, hi = np.minimum(lo, pos.min(0)), np.maximum(hi, pos.max(0))
    w.root(root_name, children, extras=root_extras)
    body = w.bytes(asset_extras)
    return body, {'triangles': stats['triangles'], 'gpuBytes': stats['gpuBytes'], 'textures': tex_sizes, 'textureBytes': tex_bytes}, lo, hi
