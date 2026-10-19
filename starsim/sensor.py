"""Sensor model, specifications, and JSON configuration manager.
Supports importing and exporting custom sensor hardware profiles.
"""

from __future__ import annotations
import json
import os
from dataclasses import dataclass, field, asdict
from typing import Dict, Any, Tuple, Optional, List


@dataclass
class OpticalParameters:
    aperture_m: float = 0.5                  # Clear aperture diameter (meters)
    focal_length_m: float = 2.0              # Focal length (meters)
    filter_band: str = "V"                   # Filter passband (e.g. V, B, R, Clear)
    central_wavelength_nm: float = 550.0     # Central wavelength in nanometers
    bandwidth_nm: float = 100.0              # Bandpass FWHM in nanometers

    def validate(self) -> None:
        if self.aperture_m <= 0:
            raise ValueError(f"Aperture must be positive, got {self.aperture_m}")
        if self.focal_length_m <= 0:
            raise ValueError(f"Focal length must be positive, got {self.focal_length_m}")


@dataclass
class DetectorParameters:
    width_px: int = 2048                     # Detector array width in pixels
    height_px: int = 2048                    # Detector array height in pixels
    pixel_size_um: float = 3.76              # Physical pixel pitch in micrometers
    bit_depth: int = 16                      # ADC resolution in bits (e.g. 12, 14, 16)
    full_well_capacity_e: float = 50000.0    # Linear full-well depth in electrons
    quantum_efficiency: float = 0.85         # Quantum efficiency (0.0 to 1.0)

    def validate(self) -> None:
        if self.width_px <= 0 or self.height_px <= 0:
            raise ValueError(f"Detector dimensions must be positive, got {self.width_px}x{self.height_px}")
        if self.pixel_size_um <= 0:
            raise ValueError(f"Pixel size must be positive, got {self.pixel_size_um}")
        if not (0.0 < self.quantum_efficiency <= 1.0):
            raise ValueError(f"Quantum efficiency must be in (0, 1], got {self.quantum_efficiency}")
        if self.bit_depth not in (8, 10, 12, 14, 16, 32):
            raise ValueError(f"Unsupported bit depth: {self.bit_depth}")


@dataclass
class NoiseParameters:
    read_noise_e: float = 1.5                # Readout noise in electrons RMS
    dark_current_eps: float = 0.005          # Dark current in electrons/pixel/sec at operating temperature
    operating_temp_c: float = -10.0          # Operating sensor temperature (Celsius)
    gain_e_per_adu: float = 1.0              # System gain in electrons per ADU
    bias_adu: float = 100.0                  # Pedestal DC bias in ADU counts
    prnu_percent: float = 0.5                # Photo-Response Non-Uniformity standard deviation (%)
    hot_pixel_rate: float = 0.0001           # Fraction of pixels with high dark current defect

    def validate(self) -> None:
        if self.read_noise_e < 0:
            raise ValueError(f"Read noise cannot be negative, got {self.read_noise_e}")
        if self.dark_current_eps < 0:
            raise ValueError(f"Dark current cannot be negative, got {self.dark_current_eps}")
        if self.gain_e_per_adu <= 0:
            raise ValueError(f"Gain must be positive, got {self.gain_e_per_adu}")


@dataclass
class SensorProfile:
    sensor_id: str
    name: str
    manufacturer: str = "Generic"
    description: str = ""
    optical: OpticalParameters = field(default_factory=OpticalParameters)
    detector: DetectorParameters = field(default_factory=DetectorParameters)
    noise: NoiseParameters = field(default_factory=NoiseParameters)

    def __post_init__(self):
        self.validate()

    def validate(self) -> None:
        if not self.sensor_id:
            raise ValueError("sensor_id cannot be empty")
        self.optical.validate()
        self.detector.validate()
        self.noise.validate()

    @property
    def pixel_scale_arcsec(self) -> float:
        """Calculate pixel scale in arcseconds per pixel."""
        # s = 206264.8 * (pixel_size in meters) / (focal_length in meters)
        return 206264.806247 * (self.detector.pixel_size_um * 1e-6) / self.optical.focal_length_m

    @property
    def fov_deg(self) -> Tuple[float, float]:
        """Field of view in degrees (width_deg, height_deg)."""
        w_deg = (self.detector.width_px * self.pixel_scale_arcsec) / 3600.0
        h_deg = (self.detector.height_px * self.pixel_scale_arcsec) / 3600.0
        return (w_deg, h_deg)

    @property
    def f_number(self) -> float:
        """Telescope focal ratio (f-number = f / D)."""
        return self.optical.focal_length_m / self.optical.aperture_m

    @property
    def max_adu(self) -> int:
        """Maximum ADU count according to bit depth."""
        return (1 << self.detector.bit_depth) - 1

    def to_dict(self) -> Dict[str, Any]:
        """Convert profile to serializable dictionary."""
        return asdict(self)

    def to_json(self, file_path: str, indent: int = 2) -> None:
        """Save sensor profile to a JSON file."""
        os.makedirs(os.path.dirname(os.path.abspath(file_path)), exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, indent=indent, ensure_ascii=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SensorProfile":
        """Instantiate SensorProfile from dictionary."""
        data_copy = dict(data)
        optical_dict = data_copy.pop("optical", {})
        detector_dict = data_copy.pop("detector", {})
        noise_dict = data_copy.pop("noise", {})

        optical = OpticalParameters(**optical_dict)
        detector = DetectorParameters(**detector_dict)
        noise = NoiseParameters(**noise_dict)

        return cls(
            optical=optical,
            detector=detector,
            noise=noise,
            **data_copy
        )

    @classmethod
    def from_json(cls, file_path_or_json_str: str) -> "SensorProfile":
        """Load sensor profile from JSON file or JSON string."""
        if os.path.exists(file_path_or_json_str):
            with open(file_path_or_json_str, "r", encoding="utf-8") as f:
                data = json.load(f)
        else:
            data = json.loads(file_path_or_json_str)
        return cls.from_dict(data)


def get_default_sensor_dir() -> str:
    """Returns the path to the built-in sensor profiles folder."""
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_dir, "data", "sensors")


def list_available_sensors(sensor_dir: Optional[str] = None) -> List[Dict[str, str]]:
    """List all available sensor profiles found in the sensor library."""
    if sensor_dir is None:
        sensor_dir = get_default_sensor_dir()
    sensors = []
    if not os.path.isdir(sensor_dir):
        return sensors
    for fname in sorted(os.listdir(sensor_dir)):
        if fname.endswith(".json"):
            fpath = os.path.join(sensor_dir, fname)
            try:
                profile = SensorProfile.from_json(fpath)
                sensors.append({
                    "sensor_id": profile.sensor_id,
                    "name": profile.name,
                    "manufacturer": profile.manufacturer,
                    "file_path": fpath,
                    "pixel_scale": f"{profile.pixel_scale_arcsec:.2f} arcsec/px",
                    "fov": f"{profile.fov_deg[0]:.2f}° x {profile.fov_deg[1]:.2f}°"
                })
            except Exception:
                pass
    return sensors


def load_sensor(sensor_id_or_path: str, sensor_dir: Optional[str] = None) -> SensorProfile:
    """Load a sensor profile either by its ID (from default dir) or direct path."""
    if os.path.isfile(sensor_id_or_path):
        return SensorProfile.from_json(sensor_id_or_path)

    if sensor_dir is None:
        sensor_dir = get_default_sensor_dir()

    candidate = os.path.join(sensor_dir, f"{sensor_id_or_path}.json")
    if os.path.isfile(candidate):
        return SensorProfile.from_json(candidate)

    # Search for matching sensor_id in the folder
    for s in list_available_sensors(sensor_dir):
        if s["sensor_id"] == sensor_id_or_path:
            return SensorProfile.from_json(s["file_path"])

    raise FileNotFoundError(f"Sensor '{sensor_id_or_path}' not found in {sensor_dir} or as a file.")
