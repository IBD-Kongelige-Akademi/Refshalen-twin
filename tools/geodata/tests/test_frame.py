import frame


def test_district_bbox_matches_origin():
    assert frame.DISTRICT_UTM_BBOX == (726000.0, 6176500.0, 728000.0, 6178500.0)
    assert frame.area_local() == frame.LOCAL_BBOX


def test_tile_ids_and_bounds():
    assert frame.tile_of_point(727000.0, 6177500.0) == "1454_12355"
    assert frame.tile_bounds_utm("1454_12355") == (727000.0, 6177500.0, 727500.0, 6178000.0)
    # local bounds: x east, z south (north is -z)
    assert frame.tile_bounds_local("1454_12355") == (0.0, -500.0, 500.0, 0.0)
    assert frame.tile_of_local(0.0, 0.0) == "1454_12355"
    assert frame.tile_of_local(-0.01, 0.0) == "1453_12355"  # a hair west of the origin


def test_four_tiles_fill_a_lod2_cell():
    cells = {}
    for ie in (1110, 1111):
        for in_ in (12646, 12647):
            cells.setdefault(frame.lod2_cell_of_tile(frame.tile_id(ie, in_)), []).append((ie, in_))
    assert list(cells) == ["6323_555"] and len(cells["6323_555"]) == 4


def test_tiles_for_bbox_district_is_4x4_and_edges_do_not_leak():
    ts = frame.tiles_for_bbox(frame.DISTRICT_UTM_BBOX)
    assert len(ts) == 16 and "1452_12353" in ts and "1455_12356" in ts
    assert frame.tiles_for_bbox((727000.0, 6177500.0, 727500.0, 6178000.0)) == ["1454_12355"]
    assert len(frame.tiles_for_bbox((727000.0, 6177500.0, 727500.0, 6178000.0), margin=1.0)) == 9


def test_area_override_and_cache_dir():
    import fetch

    class A:
        bbox = None
        tile = ["1454_12355", "1455_12355"]

    try:
        bbox = frame.apply_area_args(A)
        assert bbox == (727000.0, 6177500.0, 728000.0, 6178000.0)
        assert fetch.utm_bbox(0) == bbox
        assert "areas" in fetch.cache_dir().parts
    finally:
        frame.set_area(frame.DISTRICT_UTM_BBOX)
    assert fetch.utm_bbox() == (725940.0, 6176440.0, 728060.0, 6178560.0)
    assert fetch.cache_dir() == fetch.RAW
