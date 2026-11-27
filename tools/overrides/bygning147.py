#!/usr/bin/env python3
"""Bygning 147, Refshalevej 147 (B&W, 1955; GeoDanmark gdk:1064735588): a detail override from a Rhino model.

Source: "Bygning 147 - detaljeret.3dm" (millimetres, a local frame: X along the building towards north, Y across towards west,
Z up from the ground), modelled in Rhino through MCP by Anders Hermund (Det Kongelige Akademi), with photo textures of the
glass parapets and the gable plates (147-vest-brystning.jpg, 147-oest-brystning.jpg, 147-gavl-plade.jpg). The context
layers ("147 omgivelser", "147 kontekst") are left out: the twin has its own streets, quay and trees.

The model is placed on the GeoDanmark footprint by its long axis: its main body (layer "147 - Bygningskrop") is centred on the
footprint, X along the footprint's south-north axis, -Y (the road side, where the model's "Vej" layer lies) to the east,
towards Refshalevej. Heights stay as modelled; the bottom is carried down to 0.25 m under the lowest terrain of the outline.

Render meshes are read with rhino3dm (the 3dm keeps them), so no Rhino is needed:

    uv run --no-project --with rhino3dm,numpy,pillow python tools/overrides/bygning147.py --src <dir with the 3dm and the jpgs>
"""
from __future__ import annotations

import argparse
import hashlib
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from override_model import Model, model_to_glb  # noqa: E402
from overrides_lib import SOURCE_FORMAT, TwinFrame, albedo_image, srgb_to_linear, write_json  # noqa: E402

SET = 'bygning-147'
GDK_ID = 'gdk:1064735588'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path.home() / '.local/share/cph-twin/overrides' / SET
MODEL = 'Bygning 147 - detaljeret.3dm'
SKIP = ('omgivelser', 'kontekst')
BODY = '147 - Bygningskrop'

ATTRIBUTION = {
    'rhino-bygning-147': {'text': 'Bygning 147, Refshalevej 147: Rhino model and facade photographs by Anders Hermund, Det Kongelige Akademi',
                          'licence': 'user supplied', 'url': ''},
    'geodanmark': {'text': 'GeoDanmark Bygning (footprint the model is placed on), Klimadatastyrelsen', 'licence': 'CC BY 4.0',
                   'url': 'https://dataforsyningen.dk'},
}

# photo-textured layers -> (material, texture file); every other layer is painted in its Rhino layer colour
PHOTO = {'147 - Fototekstur vest': ('photo-vest', '147-vest-brystning.jpg'),
         '147 - Fototekstur oest': ('photo-oest', '147-oest-brystning.jpg'),
         '147 - Fototekstur gavle': ('photo-gavl', '147-gavl-plade.jpg')}
GLASS = ('Glas', 'glas')
METAL = ('Zink', 'Profiler', 'Raekvaerk', 'Ventilation', 'Tag')


def read_model(path: Path):
    """{layer: [(vertices m, triangles, uv or None, layer colour sRGB 0..1)]} from the 3dm's render meshes."""
    import rhino3dm as r

    m = r.File3dm.Read(str(path))
    layers = {i: m.Layers[i] for i in range(len(m.Layers))}
    out: dict[str, list] = {}
    for o in m.Objects:
        layer = layers[o.Attributes.LayerIndex]
        name = layer.FullPath
        if any(s in name for s in SKIP):
            continue
        g = o.Geometry
        kind = type(g).__name__
        if kind == 'Mesh':
            meshes = [g]
        elif kind == 'Extrusion':
            meshes = [g.GetMesh(r.MeshType.Render)]
        elif kind == 'Brep':
            meshes = [f.GetMesh(r.MeshType.Render) for f in g.Faces]
        else:
            continue  # curves (joints, patterns): not drawn
        for mm in meshes:
            if not mm or len(mm.Vertices) == 0:
                continue
            v = np.array([[p.X, p.Y, p.Z] for p in mm.Vertices], float) / 1000.0
            tris = []
            for i in range(mm.Faces.Count):
                f = mm.Faces[i]
                tris.append((f[0], f[1], f[2]))
                if f[2] != f[3]:
                    tris.append((f[0], f[2], f[3]))
            uv = np.array([[t.X, t.Y] for t in mm.TextureCoordinates], float) if len(mm.TextureCoordinates) == len(v) else None
            colour = tuple(c / 255.0 for c in tuple(layer.Color)[:3])
            out.setdefault(name, []).append((v, np.array(tris, int), uv, colour))
    return out


def placement(parts, rec):
    """(model XY -> twin xz function, the model's main-body box) from the footprint's long axis; X north, -Y east (the road)."""
    body = np.vstack([v for v, *_ in parts[BODY]])
    bx0, by0 = body[:, :2].min(0)
    bx1, by1 = body[:, :2].max(0)
    ring = np.array(rec['ring'], float).reshape(-1, 2)
    # the footprint's long axis from its two longest edges' direction; it points north (towards -z in the twin)
    edges = [(ring[i], ring[(i + 1) % len(ring)]) for i in range(len(ring))]
    a, b = max(edges, key=lambda e: np.linalg.norm(e[1] - e[0]))
    ex = (b - a) / np.linalg.norm(b - a)
    if ex[1] > 0:
        ex = -ex
    ey = np.array([ex[1], -ex[0]])  # 90 degrees from north to west, in (x east, z south)
    centre = ring.mean(0)
    mc = np.array([(bx0 + bx1) / 2, (by0 + by1) / 2])

    def to_twin(xy):
        d = xy - mc
        return centre + np.outer(d[:, 0], ex) + np.outer(d[:, 1], ey)

    along = float(np.ptp(ring @ ex))
    across = float(np.ptp(ring @ ey))
    return to_twin, (bx1 - bx0, by1 - by0), (along, across), ex


def material_of(layer: str):
    if layer in PHOTO:
        return PHOTO[layer][0]
    if any(k in layer for k in GLASS):
        return 'glass'
    if any(k in layer for k in METAL):
        return 'metal'
    return 'painted'


def build(parts, to_twin, base_y, low_y):
    model = Model()
    for layer, meshes in parts.items():
        mat = material_of(layer)
        for v, tris, uv, colour in meshes:
            xz = to_twin(v[:, :2])
            y = base_y + v[:, 2]
            y = np.where(v[:, 2] < 0.01, np.minimum(y, low_y), y)  # the bottom down under the lowest terrain
            p = np.column_stack([xz[:, 0], y, xz[:, 1]])
            lin = tuple(float(c) for c in srgb_to_linear(np.array(colour))) + (1.0,)
            for t in tris:
                q = p[list(t)]
                n = np.cross(q[1] - q[0], q[2] - q[0])
                ln = np.linalg.norm(n)
                if ln < 1e-10:
                    continue
                n = n / ln
                uvs = [tuple(uv[i]) for i in t] if (uv is not None and mat.startswith('photo')) else [(0.0, 0.0)] * 3
                model.tri(mat, [tuple(x) for x in q], [tuple(n)] * 3, uvs, color=lin)
    return model


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--src', required=True, help='folder with the 3dm and the photo textures')
    ap.add_argument('--data', default=str(ROOT / 'data'))
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    a = ap.parse_args()
    src, data, out = Path(a.src), Path(a.data), Path(a.out)
    frame = TwinFrame(data)
    ring = None
    tile = None
    for tid in frame.index['tiles']:
        recs = frame.buildings(tid)
        if GDK_ID in recs:
            rec, tile = recs[GDK_ID], tid
            break
    else:
        raise SystemExit(f'{GDK_ID} is in no tile')
    parts = read_model(src / MODEL)
    to_twin, body_dims, fp_dims, ex = placement(parts, rec)
    low = frame.ground_low(rec)
    base = rec['ground']
    print(f'tile {tile}; model body {body_dims[0]:.1f} x {body_dims[1]:.1f} m, footprint {fp_dims[0]:.1f} x {fp_dims[1]:.1f} m; '
          f'axis {math.degrees(math.atan2(ex[1], ex[0])):.1f} deg; ground {base:.2f}, low {low:.2f}')
    model = build(parts, to_twin, base, low - 0.25)

    def photo(name):
        from PIL import Image
        return lambda: albedo_image(Image.open(src / name))

    textures = {mat: photo(fn) for mat, fn in PHOTO.values()}
    materials = {mat: dict(tile=(1.0, 1.0), roughness=0.35, metallic=0.1) for mat, _ in PHOTO.values()}
    materials.update({'painted': dict(roughness=0.7), 'metal': dict(roughness=0.45, metallic=0.4), 'glass': dict(roughness=0.1, metallic=0.6)})
    body, mesh, lo, hi = model_to_glb(model, 0.0, (0.0, 0.0, 0.0), materials, textures, SET,
                                      root_extras={'building_id': GDK_ID, 'source_ids': ['rhino-bygning-147'], 'attribution': list(ATTRIBUTION),
                                                   'confidence': 'observed'},
                                      asset_extras={'frame': 'twin local: x east, y up, z south', 'attribution': ATTRIBUTION},
                                      attribution=list(ATTRIBUTION), generator='tools/overrides/bygning147.py')
    rel = f'meshes/{GDK_ID.replace(":", "_")}.glb'
    (out / 'meshes').mkdir(parents=True, exist_ok=True)
    (out / rel).write_bytes(body)
    entry = {
        'tile': tile, 'mode': 'replace', 'covers': [GDK_ID], 'footprint': {'use': 'gdk'},
        'match': {'kind': '1:1', 'iou': None, 'hausdorff': None},
        'source': {'ids': ['rhino-bygning-147'], 'kind': 'rhino-model', 'reconstruction': 'tools/overrides/bygning147.py'},
        'confidence': 'observed', 'attribution': list(ATTRIBUTION),
        'bounds': [round(float(v), 2) for v in (*lo, *hi)], 'ground': base, 'low': round(low, 2), 'sunk': 0.25,
        'mesh': {'path': rel, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()[:16], **mesh},
    }
    write_json(out / 'overrides.json', {'format': SOURCE_FORMAT, 'name': SET, 'attribution': ATTRIBUTION, 'buildings': {GDK_ID: entry}})
    print(f'{out}: {mesh["triangles"]} triangles, {len(body) / 1e6:.2f} MB GLB, {mesh["textureBytes"] / 1e6:.1f} MB textures, top {hi[1]:.2f}')


if __name__ == '__main__':
    main()
