# Bygning 147, Refshalevej 147 (detail override)

The B&W office building from 1955 (GeoDanmark `gdk:1064735588`, BBR use 321, four storeys and a set-back top floor) is replaced in the
near ring by a Rhino model: `Bygning 147 - detaljeret.3dm`, modelled through the Rhino MCP by Anders Hermund (Det Kongelige Akademi),
with photo textures of the glass parapets (west and east) and the gable plates.

    uv run --no-project --with rhino3dm,numpy,pillow python tools/overrides/bygning147.py --src "<folder with the 3dm and the jpgs>"
    python3 tools/hosting/build_packs.py --out site-data --offline        # picks up ~/.local/share/cph-twin/overrides/bygning-147

- **Reading.** rhino3dm reads the render meshes the 3dm keeps (Extrusion, Brep faces, Mesh), so no Rhino is needed. Curves (panel joints,
  patterns, timber battens) are not drawn. The context layers (`147 omgivelser`, `147 kontekst`) are left out.
- **Placing.** The model has no georeference (millimetres, X along the building, Y across, Z up). Its main body (`147 - Bygningskrop`,
  96.0 x 13.9 m) is centred on the GeoDanmark footprint (97.1 x 13.0 m), X along the footprint's south-north axis, -Y to the east: the
  model's road ("147 omgivelser - Vej") lies on its -Y side and Refshalevej runs along the east side, which is also where the east
  facade photographs were taken. The heights stay as modelled (top 17.6 m local; the LoD2 ridge from the point cloud is 17.1 m); the
  bottom is carried down to 0.25 m under the lowest terrain of the outline.
- **Materials.** The three photo layers keep their textures and UVs (through the twin's albedo mapping); glass, metal (zinc, profiles,
  railings, ventilation, roof) and the rest are vertex-coloured in their Rhino layer colours.
- **Size.** 53,140 triangles, 2.2 MB GLB, 1.6 MB of textures: one of the heavier overrides, still within the near ring's budget.
