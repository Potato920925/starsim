import os
import pytest
from starsim.sensor import SensorProfile, OpticalParameters, DetectorParameters, NoiseParameters, load_sensor, list_available_sensors


def test_sensor_defaults_and_properties():
    sensor = load_sensor("sony_imx455")
    assert sensor.sensor_id == "sony_imx455"
    assert sensor.optical.aperture_m == 0.5
    assert sensor.optical.focal_length_m == 2.0
    assert sensor.detector.pixel_size_um == 3.76

    # Pixel scale: 206265 * 3.76e-6 / 2.0 = 0.3877 arcsec/px
    scale = sensor.pixel_scale_arcsec
    assert 0.38 < scale < 0.40

    fov_w, fov_h = sensor.fov_deg
    assert fov_w > 0.0
    assert fov_h > 0.0


def test_custom_sensor_import_export(tmp_path):
    custom_profile = SensorProfile(
        sensor_id="test_sensor_custom",
        name="Test Sensor Custom Model",
        optical=OpticalParameters(aperture_m=0.3, focal_length_m=1.0),
        detector=DetectorParameters(width_px=512, height_px=512, pixel_size_um=4.5, bit_depth=14),
        noise=NoiseParameters(read_noise_e=3.0, dark_current_eps=0.02, gain_e_per_adu=1.2)
    )

    json_file = str(tmp_path / "custom_sensor.json")
    custom_profile.to_json(json_file)

    loaded = SensorProfile.from_json(json_file)
    assert loaded.sensor_id == "test_sensor_custom"
    assert loaded.detector.width_px == 512
    assert loaded.detector.bit_depth == 14
    assert loaded.noise.read_noise_e == 3.0


def test_sensor_validation_errors():
    with pytest.raises(ValueError):
        OpticalParameters(aperture_m=-0.5).validate()

    with pytest.raises(ValueError):
        DetectorParameters(quantum_efficiency=1.5).validate()

    with pytest.raises(ValueError):
        NoiseParameters(read_noise_e=-2.0).validate()
