import os
import pytest
import numpy as np
from astropy.io import fits
from starsim.config import StarSimConfig, SimulationEngine
from starsim.sensor import SensorProfile, OpticalParameters, DetectorParameters, NoiseParameters
from starsim.site import ObservationSite
from starsim.pointing import PointingDirection
from starsim.orbit import TargetOrbit, OrbitMode
from starsim.engine.gpu_renderer import GPURendererEngine
from starsim.io import save_simulation_artifacts


def test_gpu_renderer_pipeline(tmp_path):
    # Small test sensor for rapid unit testing
    small_sensor = SensorProfile(
        sensor_id="test_small",
        name="Small Test Sensor",
        optical=OpticalParameters(aperture_m=0.3, focal_length_m=1.0),
        detector=DetectorParameters(width_px=256, height_px=256, pixel_size_um=5.0, bit_depth=16),
        noise=NoiseParameters(read_noise_e=2.0, dark_current_eps=0.01, bias_adu=100.0, gain_e_per_adu=1.0)
    )

    config = StarSimConfig(
        sensor=small_sensor,
        site=ObservationSite(name="Test Site", lat_deg=23.5, lon_deg=120.8, alt_m=2800),
        pointing=PointingDirection(coord_frame="radec", ra_deg=88.79, dec_deg=7.41),
        targets=[
            TargetOrbit(
                name="Test_RSO",
                mode=OrbitMode.SMART_TRANSIT,
                transit_altitude_km=500.0,
                transit_angle_deg=30.0,
                visual_magnitude=8.0
            )
        ],
        start_time_iso="2026-10-19T20:00:00Z",
        end_time_iso="2026-10-19T20:00:02Z",
        exposure_time_s=1.0,
        readout_time_s=0.5,
        engine=SimulationEngine.GPU,
        use_gpu=True,
        output_dir=str(tmp_path / "sim_output")
    )

    engine = GPURendererEngine()
    result = engine.run(config)

    assert len(result.frames) >= 1
    frame0 = result.frames[0]
    assert frame0.shape == (256, 256)
    assert frame0.dtype in (np.uint16, np.uint32, np.float32)

    # Median pixel value should be near or above the DC bias (100 ADU)
    med = np.median(frame0)
    assert med >= 90.0

    # Save artifacts and check FITS / PNG
    artifacts = save_simulation_artifacts(result, config.output_dir)
    assert len(artifacts["fits"]) >= 1
    assert len(artifacts["png"]) >= 1

    # Inspect FITS file
    fits_file = artifacts["fits"][0]
    with fits.open(fits_file) as hdul:
        hdr = hdul[0].header
        assert hdr["CTYPE1"] == "RA---TAN"
        assert hdr["CTYPE2"] == "DEC--TAN"
        assert hdr["WCSAXES"] == 2
        assert "DATE-OBS" in hdr
        assert "EXPTIME" in hdr
        assert hdr["EXPTIME"] == 1.0
