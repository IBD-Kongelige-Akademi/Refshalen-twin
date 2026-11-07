"""Building address labels (tools/geodata/addresses.py)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import addresses as A  # noqa: E402


def test_split_address_takes_street_and_post_town():
    assert A.split_address("Nytorv 1, 9000 Aalborg", "1") == ("Nytorv", "9000 Aalborg")
    assert A.split_address("Boulevarden 10A, Hasseris, 9000 Aalborg", "10A") == ("Boulevarden", "9000 Aalborg")
    assert A.split_address("Nytorv 1, 9000 Aalborg", "2") is None


def test_label_groups_numbers_by_street_most_units_first():
    numbers = {
        "a": {"street": "Lille Kongensgade", "number": "4", "town": "9000 Aalborg", "units": 1},
        "b": {"street": "Nytorv", "number": "10", "town": "9000 Aalborg", "units": 3},
        "c": {"street": "Nytorv", "number": "2", "town": "9000 Aalborg", "units": 2},
        "d": {"street": "Nytorv", "number": "2A", "town": "9000 Aalborg", "units": 0},
    }
    assert A.label(numbers) == "Nytorv 2, 2A, 10 · Lille Kongensgade 4, 9000 Aalborg"


def test_label_caps_the_numbers_per_street():
    numbers = {str(n): {"street": "Vesterbro", "number": str(n), "town": None, "units": 1} for n in range(1, 8)}
    assert A.label(numbers) == "Vesterbro 1, 2, 3, 4 +3"
    assert A.label({}) is None
