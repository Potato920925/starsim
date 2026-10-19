"""Abstract base classes and result data structures for simulation engines.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
import numpy as np
from ..config import StarSimConfig


@dataclass
class SimulationResult:
    frames: List[np.ndarray]                     # List of 2D uint16/float32 ADU pixel arrays
    raw_flux_frames: List[np.ndarray]            # List of ideal pre-noise electron counts
    stars_projected: List[Dict[str, Any]]        # Stars located on the detector plane
    targets_projected: List[Dict[str, Any]]      # Target RSO trajectories on detector
    config: StarSimConfig                        # The configuration used
    execution_time_s: float = 0.0                # Total simulation compute time in seconds
    device_info: str = "CPU"                     # Hardware device used (e.g. 'NVIDIA GeForce RTX 3050')
    output_files: List[str] = field(default_factory=list) # Generated FITS/PNG file paths


class BaseSimulationEngine:
    """Abstract interface for all StarSim simulation backends."""

    def run(self, config: StarSimConfig) -> SimulationResult:
        raise NotImplementedError("Subclasses must implement run()")
