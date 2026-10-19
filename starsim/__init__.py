"""StarSim: A high-fidelity starry sky and space surveillance imagery simulator based on SatSim and GPU acceleration.
"""

__version__ = "1.0.0"

from .sensor import SensorProfile, OpticalParameters, DetectorParameters, NoiseParameters
from .site import ObservationSite
from .pointing import PointingDirection, TrackingMode
from .atmosphere import AtmosphericConditions
from .orbit import TargetOrbit, SmartTransitGenerator
from .stars import StarCatalog
from .config import StarSimConfig
from .engine.gpu_renderer import GPURendererEngine
from .engine.satsim_bridge import SatSimBridgeEngine

__all__ = [
    "SensorProfile",
    "OpticalParameters",
    "DetectorParameters",
    "NoiseParameters",
    "ObservationSite",
    "PointingDirection",
    "TrackingMode",
    "AtmosphericConditions",
    "TargetOrbit",
    "SmartTransitGenerator",
    "StarCatalog",
    "StarSimConfig",
    "GPURendererEngine",
    "SatSimBridgeEngine",
]
