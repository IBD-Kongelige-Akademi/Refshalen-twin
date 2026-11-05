import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
pytest.importorskip("numpy")

import numpy as np  # noqa: E402
from appearance_calibrate import (  # noqa: E402
    brick_rule, calibrate, clip_to_gamut, finish, in_gamut, lch, oklab_to_linear, srgb_to_oklab, summarise,
)

RING = [0, 0, 10, 0, 10, 10, 0, 10]


def wall(edge, tone, sunlit, conf="observed"):
    return {"edge": edge, "ring": 0, "tone": tone, "conf": conf, "sunlit": sunlit}


def building(bid, walls, x=0.0, material="betonelementer"):
    ring = [v + (x if i % 2 == 0 else 0) for i, v in enumerate(RING)]
    return {"id": bid, "ring": ring, "wall_material": material, "observed": {"walls": walls}}


def test_oklab_roundtrip_and_gamut():
    for rgb in ([0.8, 0.4, 0.2], [0.1, 0.1, 0.1], [1, 1, 1]):
        lab = srgb_to_oklab(rgb)
        back = oklab_to_linear(lab)
        assert np.allclose(back, np.where(np.array(rgb) <= 0.04045, np.array(rgb) / 12.92, ((np.array(rgb) + 0.055) / 1.055) ** 2.4), atol=1e-6)
    out = clip_to_gamut([0.6, 0.35, 0.2])  # far outside sRGB
    assert np.all(out >= 0) and np.all(out <= 1)
    assert in_gamut(srgb_to_oklab(out), eps=1e-3)


def test_own_sunlit_walls_set_the_shadow_walls():
    # shadow walls: darker with a blue cast; sunlit wall of the same building: light warm plaster
    b = building("a", [wall(0, [0.62, 0.62, 0.74], False), wall(1, [0.60, 0.60, 0.72], False), wall(2, [0.86, 0.80, 0.70], True)])
    geo = {"buildings": [b], "appearance": {}}
    calibrate(geo)
    sh = [w for w in b["observed"]["walls"] if not w["sunlit"]]
    assert all(w["cal"] == "own" for w in sh)
    sun_L = lch(srgb_to_oklab(b["observed"]["walls"][2]["tone_cal"]))[0]
    for w in sh:
        L, C, h = lch(srgb_to_oklab(w["tone_cal"]))
        assert abs(L - sun_L) < 0.06, "luminance matches the building's own sunlit wall"
        assert not 250 < h < 330, "the blue cast is gone"
    assert b["observed"]["walls"][0]["tone"] == [0.62, 0.62, 0.74], "additive: tone is untouched"


def test_neighbours_then_global_fallbacks():
    pair = lambda i, x: building(f"p{i}", [wall(0, [0.55, 0.55, 0.66], False), wall(1, [0.85, 0.78, 0.66], True)], x)  # noqa: E731
    lonely = building("lonely", [wall(0, [0.55, 0.55, 0.66], False)], x=20)
    far = building("far", [wall(0, [0.55, 0.55, 0.66], False)], x=5000)
    geo = {"buildings": [pair(0, 0), pair(1, 15), pair(2, 30), pair(3, 45), pair(4, 60), lonely, far], "appearance": {}}
    calibrate(geo)
    assert lonely["observed"]["walls"][0]["cal"] == "neighbours"
    assert far["observed"]["walls"][0]["cal"] == "global"
    # the neighbour offset brightens the wall like the sunlit/shadow pairs do
    assert lch(srgb_to_oklab(lonely["observed"]["walls"][0]["tone_cal"]))[0] > lch(srgb_to_oklab([0.55, 0.55, 0.66]))[0]


def test_brick_rule_makes_red_or_yellow_brick_not_salmon():
    salmon_dark = srgb_to_oklab([0.74, 0.50, 0.44])
    lab, flag = brick_rule(salmon_dark)
    L, C, h = lch(lab)
    assert flag and L <= 0.57 and C >= 0.07 and 35 <= h <= 50, "red-brown brick"
    salmon_pale = srgb_to_oklab([0.93, 0.80, 0.74])
    lab, flag = brick_rule(salmon_pale)
    L, C, h = lch(lab)
    assert flag and L > 0.7 and 80 <= h <= 95, "cream / yellow brick"
    grey = srgb_to_oklab([0.8, 0.8, 0.8])
    assert brick_rule(grey)[1] is False, "neutral plaster is left alone"


def test_finish_keeps_lightness_in_the_plausible_range_and_in_gamut():
    for rgb in ([1, 1, 1], [0.02, 0.02, 0.02], [0.9, 0.5, 0.2]):
        out, _ = finish(srgb_to_oklab(rgb))
        L = lch(srgb_to_oklab(out))[0]
        assert 0.27 <= L <= 0.85
        assert np.all(out >= 0) and np.all(out <= 1)


def test_a_skylight_cast_is_damped_not_restored_but_a_painted_blue_wall_stays():
    # Budolfi: whitewashed, the shadow view leaves a faint blue cast that the chroma restore used to turn into a blue wall
    cast = srgb_to_oklab([0.55, 0.661, 0.774])
    assert lch(srgb_to_oklab(finish(cast)[0]))[1] < lch(cast)[1], "the cast loses chroma"
    painted = srgb_to_oklab([0.25, 0.42, 0.70])
    _, C_sun, h_sun = lch(srgb_to_oklab(finish(painted, sunlit=True)[0]))
    _, C_shadow, _ = lch(srgb_to_oklab(finish(painted, sunlit=False)[0]))
    assert C_sun > 0.09 and C_sun > 1.5 * C_shadow and 200 <= h_sun <= 320, "a sunlit, clearly blue facade stays blue (the soft cap applies)"
    warm = srgb_to_oklab([0.80, 0.74, 0.66])
    assert lch(srgb_to_oklab(finish(warm)[0]))[1] > lch(warm)[1], "warm hues are still restored"


def test_inferred_walls_follow_their_building_and_stats_shape():
    b = building("a", [wall(0, [0.85, 0.80, 0.70], True), {"edge": 1, "ring": 0, "tone": [0.5, 0.5, 0.5], "conf": "inferred"}], material="mursten")
    geo = {"buildings": [b], "appearance": {}}
    calibrate(geo)
    inferred = b["observed"]["walls"][1]
    assert inferred["cal"] == "building" and inferred["tone_cal"] == b["observed"]["walls"][0]["tone_cal"]
    assert geo["appearance"]["calibration"]["version"] == "appearance-cal/1"
    s = summarise(geo, "tone_cal")
    assert s["all"]["n"] == 1 and s["sunlit"]["n"] == 1


def test_hazy_tegl_comes_out_red_and_other_roofs_stay():
    import appearance_calibrate as AC
    # a hazy tile roof as the 2021 flight sees it
    tone = AC.tegl_tone([0.62, 0.55, 0.52])
    assert tone[0] > tone[1] * 1.3 and tone[1] > tone[2], f"red-orange: {tone}"
    L, C, h = AC.lch(AC.srgb_to_oklab(np.array(tone)))
    assert 0.40 <= L <= 0.60 and 0.09 <= C <= 0.16
    # lighter measured, lighter tile: roofs stay different
    assert sum(AC.tegl_tone([0.72, 0.65, 0.62])) > sum(AC.tegl_tone([0.52, 0.46, 0.43]))
    assert AC.tegl_tone([0.13, 0.13, 0.14]) is None, "black glazed tile"
    assert AC.tegl_tone([0.2, 0.5, 0.3]) is None, "a colour of its own"
    # only a BBR tegl roof, and not solar panels
    r = {"tone": [0.62, 0.55, 0.52], "type_hint": "fibre-cement"}
    assert AC.tegl_roof(dict(r), "tegl")["type_hint"] == "tile"
    assert AC.tegl_roof(dict(r), "metal")["tone"] == r["tone"]
    assert AC.tegl_roof({**r, "type_hint": "solar"}, "tegl")["tone"] == r["tone"]


def test_a_plum_roof_loses_its_cast_and_a_red_tile_or_grey_one_is_left():
    import appearance_calibrate as AC
    plum = AC.roof_cast({"tone": [0.42, 0.30, 0.40], "type_hint": "slate"})["tone"]
    assert AC.lch(AC.srgb_to_oklab(np.array(plum)))[1] < 0.02, plum
    tile = {"tone": [0.55, 0.25, 0.13], "type_hint": "tile"}
    assert AC.roof_cast(dict(tile))["tone"] == tile["tone"]
    olive = [0.45, 0.45, 0.30]
    assert AC.roof_cast({"tone": list(olive), "type_hint": "other"})["tone"] == olive
