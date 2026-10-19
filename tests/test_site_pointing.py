import pytest
from starsim.site import ObservationSite, list_preset_observatories, get_preset_site
from starsim.pointing import PointingDirection, TrackingMode


def test_preset_observatories():
    presets = list_preset_observatories()
    assert "lulin" in presets
    assert "mauna_kea" in presets

    lulin = get_preset_site("lulin")
    assert 23.4 < lulin.lat_deg < 23.5
    assert 120.8 < lulin.lon_deg < 120.9
    assert lulin.alt_m > 2800.0


def test_pointing_coordinate_conversion():
    lulin = get_preset_site("lulin")
    time_iso = "2026-10-19T20:00:00Z"

    # RA/Dec direct
    p_radec = PointingDirection(coord_frame="radec", ra_deg=100.0, dec_deg=20.0)
    ra, dec = p_radec.get_equatorial(lulin, time_iso)
    assert abs(ra - 100.0) < 1e-4
    assert abs(dec - 20.0) < 1e-4

    # AltAz conversion to RADec
    p_altaz = PointingDirection(coord_frame="altaz", az_deg=180.0, alt_deg=70.0)
    ra_conv, dec_conv = p_altaz.get_equatorial(lulin, time_iso)
    assert 0.0 <= ra_conv <= 360.0
    assert -90.0 <= dec_conv <= 90.0
