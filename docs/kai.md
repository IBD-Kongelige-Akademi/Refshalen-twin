# KAI, Vandkulturhuset Papirøen (detail override)

Kengo Kuma & Associates with Cornelius Vöge and Søren Jensen; executing architect Vilhelm Lauritzen Arkitekter. GeoDanmark `gdk:1219264487`.
`tools/overrides/kai.py` builds it from measurements read off the published drawings (vandkulturhusetpapiroen.dk, image archive; vilhelmlauritzen.com):

- **Layout.** The structural roof diagram (grid A-G x 1-6) gives the stubs A-E, the narrow F over the valley pool and the link between C and D: each a
  base rectangle (the stubs meet at the base) and a top rectangle, in fractions of the outline. Plan L1's north arrow puts the diagram's left side at
  the north-north-east end, so its top-left corner is the GeoDanmark outline's north-east corner (48.5 x 38.2 m; the diagram's proportions agree).
- **Heights.** Sections: tops at kote +31.63 (A, the culture tower), +25.63 (C), +22.63 (B), +21.63 (E), +19.13 (D); F (+14.1) and the C-D link
  (+17.1) have no kote on the sheets and are inferred. The brick starts at kote +7.08 over the glazed ground floor (EST +2.63).
- **Surfaces.** Sloping brick faces (a procedural texture of long dark grey-brown bricks after the photographs), about 400 deep-set windows as dark
  panes at random positions (the real ones are not placed from the drawings), dark flat tops, the glass ground floor with mullions every 3 m and
  raking V columns behind it.
- **Limits.** Indicative: the interior pools, the open valley between the stubs and the exact window pattern are not modelled. `confidence: inferred`.

    uv run --no-project --with numpy,pillow python tools/overrides/kai.py
    python3 tools/hosting/build_packs.py --out site-data --offline
