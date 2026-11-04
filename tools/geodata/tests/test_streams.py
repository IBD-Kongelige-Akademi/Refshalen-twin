"""city_water.stream_bodies: open watercourse centrelines widened to their bank lines, in pieces, at the terrain level over each."""
from shapely.geometry import LineString, box

import city_water as CW


class FlatDtm:
    """A terrain that falls 1 m per 100 m eastwards."""

    def median_in(self, poly, q=50.0):
        return -poly.centroid.x / 100.0


def run(monkeypatch, mids, kants, water=None):
    layers = {"vandloebsmidte": mids, "vandloebskant": [({}, k) for k in kants]}
    monkeypatch.setattr(CW, "gdk_line_features", lambda name: layers[name])
    return CW.stream_bodies(FlatDtm(), water if water is not None else box(0, 0, 0, 0).buffer(0))


def test_banks_set_the_width_and_pieces_follow_the_slope(monkeypatch):
    mid = ({"vandloebstype": "Almindelig", "midtebredde": "2.5-12", "synligvandloebsmidte": 1}, LineString([(0, 0), (100, 0)]))
    banks = [LineString([(-5, 3), (105, 3)]), LineString([(-5, -2), (105, -2)])]
    out = run(monkeypatch, [mid], banks)
    assert len(out) == 5  # 100 m in 20 m pieces
    for b in out:
        x0, z0, x1, z1 = b["poly"].bounds
        assert abs(z0 + 2) < 0.05 and abs(z1 - 3) < 0.05, b["poly"].bounds  # 5 m wide, between the banks
        assert b["pond"] and b["kind"] == "stream"
    levels = [b["level"] for b in sorted(out, key=lambda b: b["poly"].centroid.x)]
    assert levels == sorted(levels, reverse=True)  # each piece at its own level, falling downstream


def test_piped_hidden_and_covered_stretches_are_left_out(monkeypatch):
    line = LineString([(0, 0), (60, 0)])
    piped = ({"vandloebstype": "Rørlagt", "midtebredde": "Ukendt", "synligvandloebsmidte": 0}, line)
    hidden = ({"vandloebstype": "Almindelig", "midtebredde": "2.5-12", "synligvandloebsmidte": 0}, line)
    assert run(monkeypatch, [piped, hidden], []) == []
    open_ = ({"vandloebstype": "Almindelig", "midtebredde": "0-2.5", "synligvandloebsmidte": 1}, line)
    out = run(monkeypatch, [open_], [], water=box(30, -10, 100, 10))  # the second half runs into a lake
    assert out and max(b["poly"].bounds[2] for b in out) <= 30.01
    assert all(abs(b["poly"].bounds[3] - CW.STREAM_WIDTH["0-2.5"] / 2) < 0.05 for b in out)  # no banks: the width class
