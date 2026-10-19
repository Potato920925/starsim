import pytest
from starsim.orbit import TargetOrbit, OrbitMode, SmartTransitGenerator, SGP4Propagator, POPULAR_TLES
from starsim.site import get_preset_site


def test_tle_preset():
    iss = TargetOrbit.from_preset("iss")
    assert iss.name == "ISS (ZARYA)"
    assert iss.mode == OrbitMode.TLE
    assert iss.tle1.startswith("1 25544")


def test_smart_transit_generator():
    site = get_preset_site("lulin")
    target = TargetOrbit(
        name="Test_Transit_Sat",
        mode=OrbitMode.SMART_TRANSIT,
        transit_altitude_km=500.0,
        transit_angle_deg=45.0,
        visual_magnitude=8.0
    )

    traj = SmartTransitGenerator.generate_transit_trajectory(
        target=target,
        site=site,
        pointing_ra_deg=88.79,
        pointing_dec_deg=7.41,
        pixel_scale_arcsec=0.5,
        width_px=1024,
        height_px=1024,
        t_start_iso="2026-10-19T20:00:00Z",
        t_end_iso="2026-10-19T20:00:02Z",
        n_steps=50
    )

    assert "start_pixel" in traj
    assert "end_pixel" in traj
    x0, y0 = traj["start_pixel"]
    x1, y1 = traj["end_pixel"]
    # Motion across pixels should be significant during 2 seconds
    dist = ((x1 - x0)**2 + (y1 - y0)**2)**0.5
    assert dist > 10.0


def test_sgp4_propagation():
    site = get_preset_site("lulin")
    iss = POPULAR_TLES["iss"]
    result = SGP4Propagator.propagate_tle(iss["tle1"], iss["tle2"], site, "2024-03-20T20:00:00Z")
    assert result is not None
    assert "ra_deg" in result
    assert "dec_deg" in result
    assert "distance_km" in result
    assert result["distance_km"] > 300.0
