"""Comprehensive simulation configuration model.
Aggregates all site, pointing, atmosphere, temporal, sensor, and orbit parameters.
"""

from __future__ import annotations
import json
import os
from enum import Enum
from dataclasses import dataclass, field, asdict
from typing import Dict, Any, List, Optional
from astropy.time import Time
from .sensor import SensorProfile, load_sensor
from .site import ObservationSite
from .pointing import PointingDirection
from .atmosphere import AtmosphericConditions
from .orbit import TargetOrbit


class SimulationEngine(str, Enum):
    SATSIM = "satsim"      # SatSim native official engine (with GPU/CPU acceleration)
    GPU = "gpu"            # Backward-compatible alias for SatSim
    CUSTOM = "custom"      # Backward-compatible alias for SatSim


@dataclass
class StarSimConfig:
    site: ObservationSite = field(default_factory=ObservationSite)
    pointing: PointingDirection = field(default_factory=PointingDirection)
    atmosphere: AtmosphericConditions = field(default_factory=AtmosphericConditions)
    sensor: SensorProfile = field(default_factory=lambda: load_sensor("sony_imx455"))
    targets: List[TargetOrbit] = field(default_factory=lambda: [TargetOrbit()])
    start_time_iso: str = "2026-10-19T20:00:00Z"
    end_time_iso: str = "2026-10-19T20:00:10Z"
    exposure_time_s: float = 2.0
    readout_time_s: float = 0.5
    engine: SimulationEngine = SimulationEngine.SATSIM
    use_gpu: bool = True
    device_id: int = 0
    output_dir: str = "./output"

    def __post_init__(self):
        # Native SatSim is the standard calculation engine
        self.engine = SimulationEngine.SATSIM
        self.validate()

    def validate(self) -> None:
        self.site.validate()
        self.pointing.validate()
        self.atmosphere.validate()
        self.sensor.validate()
        if self.exposure_time_s <= 0:
            raise ValueError(f"Exposure time must be positive, got {self.exposure_time_s}")
        if self.readout_time_s < 0:
            raise ValueError(f"Readout time cannot be negative, got {self.readout_time_s}")
        t0 = Time(self.start_time_iso)
        t1 = Time(self.end_time_iso)
        if t1 < t0:
            raise ValueError(f"End time ({self.end_time_iso}) must be after start time ({self.start_time_iso})")

    @property
    def total_duration_s(self) -> float:
        t0 = Time(self.start_time_iso)
        t1 = Time(self.end_time_iso)
        return max(0.0, (t1 - t0).to_value('sec'))

    @property
    def frame_interval_s(self) -> float:
        return self.exposure_time_s + self.readout_time_s

    @property
    def num_frames(self) -> int:
        duration = self.total_duration_s
        interval = self.frame_interval_s
        if duration <= 0 or interval <= 0:
            return 1
        return max(1, int(duration // interval))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "site": self.site.to_dict(),
            "pointing": self.pointing.to_dict(),
            "atmosphere": self.atmosphere.to_dict(),
            "sensor": self.sensor.to_dict(),
            "targets": [t.to_dict() for t in self.targets],
            "start_time_iso": self.start_time_iso,
            "end_time_iso": self.end_time_iso,
            "exposure_time_s": self.exposure_time_s,
            "readout_time_s": self.readout_time_s,
            "engine": self.engine.value if isinstance(self.engine, SimulationEngine) else self.engine,
            "use_gpu": self.use_gpu,
            "device_id": self.device_id,
            "output_dir": self.output_dir
        }

    def to_json(self, file_path: str, indent: int = 2) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(file_path)), exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, indent=indent, ensure_ascii=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "StarSimConfig":
        d = dict(data)
        site = ObservationSite.from_dict(d.pop("site", {}))
        pointing = PointingDirection.from_dict(d.pop("pointing", {}))
        atmosphere = AtmosphericConditions.from_dict(d.pop("atmosphere", {}))
        sensor = SensorProfile.from_dict(d.pop("sensor", {}))
        targets_raw = d.pop("targets", [])
        targets = [TargetOrbit.from_dict(t) for t in targets_raw]

        return cls(
            site=site,
            pointing=pointing,
            atmosphere=atmosphere,
            sensor=sensor,
            targets=targets,
            **d
        )

    @classmethod
    def from_json(cls, file_path_or_str: str) -> "StarSimConfig":
        if os.path.isfile(file_path_or_str):
            with open(file_path_or_str, "r", encoding="utf-8") as f:
                data = json.load(f)
        else:
            data = json.loads(file_path_or_str)
        return cls.from_dict(data)
