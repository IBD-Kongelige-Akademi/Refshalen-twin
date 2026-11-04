"""canopies.py: an unregistered building under an OSM building=roof, tall enough to drive under, gets a base under its eave."""
from shapely.geometry import Polygon

import canopies

ROOF = [Polygon([(0, 0), (30, 0), (30, 20), (0, 20)])]


def building(**kw):
    b = {"id": "gdk:1", "bbr_id": None, "ring": [0, 0, 30, 0, 30, 20, 0, 20], "ground": -0.4, "eave": 5.2}
    b.update(kw)
    return b


def test_terminal_roof_is_a_canopy():
    assert canopies.canopy_base(building(), ROOF) == round(5.2 - canopies.DECK, 2)


def test_registered_low_or_uncovered_buildings_stay_solid():
    assert canopies.canopy_base(building(bbr_id="abc"), ROOF) is None  # in BBR: a real building
    assert canopies.canopy_base(building(eave=2.4), ROOF) is None  # a bike shelter
    assert canopies.canopy_base(building(ring=[40, 0, 70, 0, 70, 20, 40, 20]), ROOF) is None  # no OSM roof over it


def test_base_keeps_the_clearance():
    # the underside is never lower than MIN_CLEARANCE over the ground, nor above the eave
    for eave in (canopies.MIN_HEIGHT, 4.0, 6.0, 9.0):
        base = canopies.canopy_base(building(ground=0.0, eave=eave), ROOF)
        assert canopies.MIN_CLEARANCE <= base < eave
