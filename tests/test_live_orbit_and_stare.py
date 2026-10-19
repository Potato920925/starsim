import os
import pytest
from starsim.orbit import LiveSatelliteManager, TargetOrbit, OrbitMode
from starsim.site import get_preset_site
from starsim.config import StarSimConfig, SimulationEngine
from starsim.sensor import load_sensor
from starsim.pointing import PointingDirection, TrackingMode
from starsim.engine.gpu_renderer import GPURendererEngine
from starsim.io import save_simulation_artifacts


def test_live_satellite_manager():
    site = get_preset_site("lulin")
    satellites = LiveSatelliteManager.fetch_or_load_tles("visual")
    assert len(satellites) > 0
    assert "norad_id" in satellites[0]
    assert "tle1" in satellites[0]

    # Test topocentric sky positions
    sky_positions = LiveSatelliteManager.get_sky_positions(site, "2026-10-19T20:00:00Z", group="visual", min_alt_deg=0.0)
    assert len(sky_positions) > 0
    assert "az_deg" in sky_positions[0]
    assert "alt_deg" in sky_positions[0]


def test_stare_mode_star_streaks(tmp_path):
    sensor = load_sensor("sony_imx455")
    # Set smaller size for fast test
    sensor.detector.width_px = 256
    sensor.detector.height_px = 256

    config = StarSimConfig(
        sensor=sensor,
        site=get_preset_site("lulin"),
        pointing=PointingDirection(
            coord_frame="radec",
            ra_deg=88.79,
            dec_deg=7.41,
            tracking_mode=TrackingMode.STARE  # Fixed mount mode
        ),
        start_time_iso="2026-10-19T20:00:00Z",
        end_time_iso="2026-10-19T20:00:05Z",
        exposure_time_s=5.0,  # 5s exposure with fixed mount -> stars will streak
        output_dir=str(tmp_path / "stare_test")
    )

    engine = GPURendererEngine()
    result = engine.run(config)

    assert len(result.frames) >= 1
    # Check that stars have streak attributes
    if result.stars_projected:
        star = result.stars_projected[0]
        assert star["is_streak"] is True
        assert star["size_px"] > 1.0  # Streaked size should be substantial

    artifacts = save_simulation_artifacts(result, config.output_dir)
    assert len(artifacts["annotated_png"]) >= 1
    assert len(artifacts["csv"]) >= 1
    assert os.path.isfile(artifacts["annotated_png"][0])
    assert os.path.isfile(artifacts["csv"][0])
