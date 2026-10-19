"""SatSim integration bridge.
Translates StarSim parameters into SatSim's standard JSON configuration
and executes the simulation through SatSim's Python API and CLI.
"""

from __future__ import annotations
import os
import json
import time
import glob
from typing import Dict, Any, List
import numpy as np
from astropy.io import fits

from .base import BaseSimulationEngine, SimulationResult
from ..config import StarSimConfig
from ..orbit import OrbitMode
from ..stars import get_default_catalog_file


class SatSimBridgeEngine(BaseSimulationEngine):
    """Bridge for running simulations through SatSim's core engine."""

    def build_satsim_config(self, config: StarSimConfig) -> Dict[str, Any]:
        """Convert a StarSimConfig into a SatSim-compliant dictionary structure."""
        sensor = config.sensor
        site = config.site
        pointing = config.pointing
        atmosphere = config.atmosphere

        ra, dec = pointing.get_equatorial(site, config.start_time_iso)

        # Build obs list for SatSim
        obs_list = []
        for target in config.targets:
            if target.mode == OrbitMode.TLE and target.tle1 and target.tle2:
                obs_list.append({
                    "mode": "tle",
                    "tle1": target.tle1,
                    "tle2": target.tle2,
                    "mv": target.visual_magnitude
                })
            else:
                # Default linear motion across image plane
                obs_list.append({
                    "mode": "line",
                    "origin": [0.2, 0.2],
                    "velocity": [15.0, 15.0],
                    "mv": target.visual_magnitude
                })

        satsim_dict = {
            "version": "0.26.0",
            "sim": {
                "samples": 1,
                "n_frames": config.num_frames,
                "exposure": config.exposure_time_s,
                "focal_length": sensor.optical.focal_length_m,
                "aperture": sensor.optical.aperture_m,
                "pixel_scale": sensor.pixel_scale_arcsec,
                "gain": sensor.noise.gain_e_per_adu,
                "bit_depth": sensor.detector.bit_depth,
                "calculate_snr": True,
                "height": sensor.detector.height_px,
                "width": sensor.detector.width_px
            },
            "fpa": {
                "height": sensor.detector.height_px,
                "width": sensor.detector.width_px,
                "psf": {
                    "mode": "gaussian",
                    "fwhm": max(1.0, atmosphere.seeing_fwhm_arcsec / sensor.pixel_scale_arcsec)
                },
                "noise": {
                    "read_noise": sensor.noise.read_noise_e,
                    "dark_current": sensor.noise.dark_current_eps,
                    "bias": sensor.noise.bias_adu
                },
                "qe": sensor.detector.quantum_efficiency,
                "electron_well_depth": sensor.detector.full_well_capacity_e
            },
            "background": {
                "galactic": atmosphere.get_sky_surface_brightness_mag()
            },
            "geometry": {
                "time": {
                    "start": config.start_time_iso.rstrip("Z"),
                    "step": config.frame_interval_s
                },
                "site": {
                    "lat": site.lat_deg,
                    "lon": site.lon_deg,
                    "alt": site.alt_m,
                    "track": {
                        "mode": "radec",
                        "ra": ra,
                        "dec": dec
                    }
                },
                "stars": {
                    "mode": "csv",
                    "path": get_default_catalog_file(),
                    "motion": {"mode": "none"}
                },
                "obs": {
                    "mode": "list",
                    "list": obs_list
                }
            }
        }
        return satsim_dict

    def run(self, config: StarSimConfig) -> SimulationResult:
        """Execute simulation through SatSim."""
        t_start = time.time()
        ssp = self.build_satsim_config(config)

        # Output folder for SatSim
        out_dir = os.path.abspath(os.path.join(config.output_dir, "satsim_run"))
        os.makedirs(out_dir, exist_ok=True)

        config_path = os.path.join(out_dir, "satsim_input.json")
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(ssp, f, indent=2)

        device_info = "SatSim (CPU / GPU)"
        frames: List[np.ndarray] = []
        raw_flux: List[np.ndarray] = []
        output_files: List[str] = []

        try:
            from satsim import gen_multi
            gen_multi(ssp, eager=True, output_dir=out_dir)

            # Search generated FITS files
            fits_files = sorted(glob.glob(os.path.join(out_dir, "**", "*.fits"), recursive=True))
            for fpath in fits_files:
                output_files.append(fpath)
                with fits.open(fpath) as hdul:
                    data = hdul[0].data.astype(np.float32)
                    frames.append(data)
                    raw_flux.append(data.copy())
        except Exception as e:
            # If SatSim execution encounters environment specific errors, fallback to GPU renderer
            from .gpu_renderer import GPURendererEngine
            renderer = GPURendererEngine()
            result = renderer.run(config)
            result.device_info = f"Fallback GPU Renderer (SatSim note: {str(e)[:50]})"
            return result

        duration = time.time() - t_start
        return SimulationResult(
            frames=frames,
            raw_flux_frames=raw_flux,
            stars_projected=[],
            targets_projected=[],
            config=config,
            execution_time_s=round(duration, 3),
            device_info=device_info,
            output_files=output_files
        )
