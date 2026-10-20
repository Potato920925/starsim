"""SatSim integration bridge.
Translates StarSim parameters into SatSim's standard JSON configuration
and executes the simulation through SatSim's Python API and native engine,
supporting both native GPU (CUDA) and multi-core CPU acceleration.
"""

from __future__ import annotations
import os
import ssl
import json
import time
import math
import glob
from typing import Dict, Any, List, Tuple
import numpy as np
from astropy.io import fits
from astropy.time import Time

# Patch Skyfield SSL context to support environments with proxy / custom certificates
try:
    from skyfield import iokit
    iokit.create_default_context = lambda **kwargs: ssl._create_unverified_context()
except Exception:
    pass

from .base import BaseSimulationEngine, SimulationResult
from ..config import StarSimConfig
from ..orbit import OrbitMode
from ..stars import StarCatalog, project_gnomonic_tan, calculate_star_electrons


def get_satsim_catalog_file() -> str:
    """Return path to headerless CSV catalog required by SatSim (id, vmag, ra_deg, dec_deg)."""
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    target = os.path.join(base_dir, "data", "stars", "satsim_star_catalog.csv")
    if not os.path.exists(target):
        # Auto-generate from star_catalog_bsc5.csv if missing
        src = os.path.join(base_dir, "data", "stars", "star_catalog_bsc5.csv")
        if os.path.exists(src):
            import pandas as pd
            df = pd.read_csv(src)
            satsim_df = pd.DataFrame({
                "id": range(1, len(df) + 1),
                "vmag": df["vmag"],
                "ra_deg": df["ra_deg"],
                "dec_deg": df["dec_deg"]
            })
            os.makedirs(os.path.dirname(target), exist_ok=True)
            satsim_df.to_csv(target, index=False, header=False)
    return target


class SatSimBridgeEngine(BaseSimulationEngine):
    """Bridge for running simulations natively through SatSim's core engine."""

    def __init__(self):
        self.catalog = StarCatalog()

    def build_satsim_config(self, config: StarSimConfig) -> Dict[str, Any]:
        """Convert a StarSimConfig into a native SatSim 0.26 compliant configuration structure."""
        sensor = config.sensor
        site = config.site
        pointing = config.pointing
        atmosphere = config.atmosphere

        ra, dec = pointing.get_equatorial(site, config.start_time_iso)

        # Parse start time into UTC list: [YYYY, MM, DD, hh, mm, ss.sss]
        t_dt = Time(config.start_time_iso).datetime
        sec_float = float(t_dt.second + t_dt.microsecond / 1e6)
        time_list = [t_dt.year, t_dt.month, t_dt.day, t_dt.hour, t_dt.minute, sec_float]

        # Sensor FOV in degrees
        fov_y_deg = (sensor.detector.height_px * sensor.pixel_scale_arcsec) / 3600.0
        fov_x_deg = (sensor.detector.width_px * sensor.pixel_scale_arcsec) / 3600.0

        # Optical zeropoint magnitude
        area = math.pi * (sensor.optical.aperture_m / 2.0) ** 2
        qe = sensor.detector.quantum_efficiency
        zeropoint = 2.5 * math.log10(max(1e-6, area * qe * 1e11))

        # Build observations list for SatSim
        obs_list = []
        for idx, target in enumerate(config.targets):
            if target.mode == OrbitMode.TLE and target.tle1 and target.tle2:
                obs_list.append({
                    "mode": "tle",
                    "object_name": target.name,
                    "tle1": target.tle1,
                    "tle2": target.tle2,
                    "mv": target.visual_magnitude
                })
            elif target.mode == OrbitMode.SMART_TRANSIT:
                # Guaranteed transit trajectory across focal plane
                obs_list.append({
                    "mode": "line",
                    "object_name": target.name,
                    "origin": [0.15, 0.45],
                    "velocity": [15.0, 5.0],
                    "mv": target.visual_magnitude
                })
            else:
                # Default linear transit
                obs_list.append({
                    "mode": "line",
                    "object_name": target.name,
                    "origin": [0.2, 0.2],
                    "velocity": [12.0, 8.0],
                    "mv": target.visual_magnitude
                })

        # Track mode configuration
        tracking_mode_str = pointing.tracking_mode.value.lower()
        if tracking_mode_str == "stare":
            track_cfg = {
                "mode": "fixed",
                "az": pointing.az_deg,
                "el": pointing.alt_deg
            }
        else:
            track_cfg = {
                "mode": "radec",
                "ra": ra,
                "dec": dec
            }

        catalog_path = get_satsim_catalog_file()
        has_catalog = os.path.exists(catalog_path)

        ssp = {
            "version": "0.26.0",
            "sim": {
                "samples": 1,
                "spatial_osf": 1,
                "temporal_osf": 1,
                "padding": 0,
                "save_jpeg": False,
                "show_obs_boxes": False,
                "show_star_boxes": True,
                "save_movie": False,
                "save_czml": False,
                "save_pickle": False,
                "fits_compression": None,
                "calculate_snr": True,
                "star_render_mode": "transform"
            },
            "fpa": {
                "height": sensor.detector.height_px,
                "width": sensor.detector.width_px,
                "y_fov": fov_y_deg,
                "x_fov": fov_x_deg,
                "zeropoint": zeropoint,
                "dark_current": sensor.noise.dark_current_eps,
                "gain": sensor.noise.gain_e_per_adu,
                "bias": sensor.noise.bias_adu,
                "noise": {
                    "read": sensor.noise.read_noise_e,
                    "electronic": 0.0
                },
                "a2d": {
                    "dtype": "uint16",
                    "fwc": sensor.detector.full_well_capacity_e,
                    "gain": sensor.noise.gain_e_per_adu,
                    "bias": sensor.noise.bias_adu,
                    "response": "linear"
                },
                "time": {
                    "exposure": config.exposure_time_s,
                    "gap": config.readout_time_s
                },
                "num_frames": config.num_frames,
                "psf": {
                    "mode": "gaussian",
                    "eod": 0.85
                },
                "qe": sensor.detector.quantum_efficiency,
                "electron_well_depth": sensor.detector.full_well_capacity_e
            },
            "background": {
                "galactic": atmosphere.get_sky_surface_brightness_mag()
            },
            "geometry": {
                "time": time_list,
                "site": {
                    "lat": site.lat_deg,
                    "lon": site.lon_deg,
                    "alt": site.alt_m,
                    "gimbal": {
                        "rotation": pointing.roll_deg
                    },
                    "track": track_cfg
                },
                "stars": {
                    "mode": "csv" if has_catalog else "none",
                    "path": catalog_path,
                    "motion": {"mode": "none"}
                },
                "obs": {
                    "mode": "list",
                    "list": obs_list
                }
            }
        }
        return ssp

    def _determine_device(self, config: StarSimConfig) -> Tuple[Any, str]:
        """Detect and return SatSim device argument based on user preference and GPU availability."""
        if not config.use_gpu:
            return ([], "SatSim 原生運算 (CPU 多核心)")

        try:
            import tensorflow as tf
            gpus = tf.config.list_physical_devices('GPU')
            if gpus:
                dev_idx = config.device_id if config.device_id < len(gpus) else 0
                return ([dev_idx], f"SatSim 原生 GPU 加速 (CUDA: {gpus[dev_idx].name})")
        except Exception:
            pass

        return (None, "SatSim 原生運算 (CPU)")

    def run(self, config: StarSimConfig) -> SimulationResult:
        """Execute simulation through SatSim native engine."""
        t_start = time.time()
        ssp = self.build_satsim_config(config)

        # Output folder for SatSim run
        out_dir = os.path.abspath(os.path.join(config.output_dir, "satsim_run"))
        os.makedirs(out_dir, exist_ok=True)

        config_path = os.path.join(out_dir, "satsim_input.json")
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(ssp, f, indent=2)

        device_arg, device_info = self._determine_device(config)

        from satsim import gen_multi
        gen_multi(ssp, eager=True, output_dir=out_dir, device=device_arg)

        # Read generated FITS files
        fits_files = sorted(glob.glob(os.path.join(out_dir, "**", "*.fits"), recursive=True))
        frames: List[np.ndarray] = []
        raw_flux: List[np.ndarray] = []
        output_files: List[str] = []

        for fpath in fits_files:
            output_files.append(fpath)
            with fits.open(fpath) as hdul:
                data = hdul[0].data.astype(np.float32)
                frames.append(data)
                raw_flux.append(data.copy())

        # Read SatNet JSON annotation files
        json_files = sorted(glob.glob(os.path.join(out_dir, "**", "sat_*.json"), recursive=True))
        targets_projected: List[Dict[str, Any]] = []
        stars_projected: List[Dict[str, Any]] = []

        width_px = config.sensor.detector.width_px
        height_px = config.sensor.detector.height_px

        for frame_idx, jpath in enumerate(json_files):
            try:
                with open(jpath, "r", encoding="utf-8") as jf:
                    jdata = json.load(jf)
                objects = jdata.get("data", {}).get("objects", [])

                for obj in objects:
                    cname = obj.get("class_name", "")
                    x_min = float(obj.get("x_min", 0.0)) * width_px
                    x_max = float(obj.get("x_max", 0.0)) * width_px
                    y_min = float(obj.get("y_min", 0.0)) * height_px
                    y_max = float(obj.get("y_max", 0.0)) * height_px

                    x_ctr = float(obj.get("x_center", (x_min + x_max) / (2.0 * width_px))) * width_px
                    y_ctr = float(obj.get("y_center", (y_min + y_max) / (2.0 * height_px))) * height_px

                    vmag = float(obj.get("magnitude", 8.0))
                    pe_sec = float(obj.get("pe_per_sec", 0.0))
                    total_pe = round(pe_sec * config.exposure_time_s, 1)
                    snr_val = float(obj.get("snr_aperture") or 50.0)

                    if cname == "Satellite":
                        x_s = float(obj.get("x_start", x_min / width_px)) * width_px
                        y_s = float(obj.get("y_start", y_min / height_px)) * height_px
                        x_e = float(obj.get("x_end", x_max / width_px)) * width_px
                        y_e = float(obj.get("y_end", y_max / height_px)) * height_px
                        streak_len = round(math.hypot(x_e - x_s, y_e - y_s), 1)

                        targets_projected.append({
                            "frame": frame_idx,
                            "target_name": obj.get("object_name") or (config.targets[0].name if config.targets else "RSO"),
                            "class": "Satellite",
                            "start_pixel": [round(x_s, 2), round(y_s, 2)],
                            "end_pixel": [round(x_e, 2), round(y_e, 2)],
                            "center_pixel": [round(x_ctr, 2), round(y_ctr, 2)],
                            "bbox": [round(min(x_min, x_max), 1), round(min(y_min, y_max), 1), round(max(x_min, x_max), 1), round(max(y_min, y_max), 1)],
                            "streak_length_px": streak_len,
                            "streak_width_px": round(abs(x_max - x_min), 1),
                            "size_px": streak_len,
                            "vmag": vmag,
                            "snr": round(snr_val, 1),
                            "total_electrons": total_pe
                        })
                    else:
                        stars_projected.append({
                            "frame": frame_idx,
                            "name": obj.get("object_name") or f"Star_{len(stars_projected)+1}",
                            "class": "Star",
                            "x_px": round(x_ctr, 1),
                            "y_px": round(y_ctr, 1),
                            "ra_deg": float(obj.get("ra", 0.0)) if obj.get("ra") is not None else 0.0,
                            "dec_deg": float(obj.get("dec", 0.0)) if obj.get("dec") is not None else 0.0,
                            "vmag": vmag,
                            "snr": round(snr_val, 1),
                            "electrons": total_pe,
                            "size_px": max(3.0, round(abs(x_max - x_min), 1)),
                            "bbox": [round(x_min, 1), round(y_min, 1), round(x_max, 1), round(y_max, 1)]
                        })
            except Exception:
                pass

        # If SatSim star annotations were sparse, project known stars in the FOV from catalog
        if len(stars_projected) == 0:
            center_ra, center_dec = config.pointing.get_equatorial(config.site, config.start_time_iso)
            fov_w, fov_h = config.sensor.fov_deg
            fov_radius = max(fov_w, fov_h) * 0.75
            query_stars = self.catalog.query_cone(center_ra, center_dec, fov_radius, limiting_mag=12.0)
            if len(query_stars) > 0:
                pix_scale = config.sensor.pixel_scale_arcsec
                w_px = config.sensor.detector.width_px
                h_px = config.sensor.detector.height_px
                is_stare = (config.pointing.tracking_mode.value.lower() == "stare")
                streak_len = (config.exposure_time_s * 15.04) / max(0.1, pix_scale) if is_stare else 0.0

                for s in query_stars:
                    x_px, y_px = project_gnomonic_tan(
                        s["ra_deg"], s["dec_deg"],
                        center_ra, center_dec,
                        config.pointing.roll_deg,
                        pix_scale,
                        w_px / 2.0, h_px / 2.0
                    )
                    if 0 <= x_px < w_px and 0 <= y_px < h_px:
                        vmag = float(s["vmag"])
                        electrons = calculate_star_electrons(
                            vmag=vmag,
                            aperture_m=config.sensor.optical.aperture_m,
                            bandwidth_nm=config.sensor.optical.bandwidth_nm,
                            quantum_efficiency=config.sensor.detector.quantum_efficiency,
                            exposure_s=config.exposure_time_s
                        )
                        snr = round(max(3.0, electrons / math.sqrt(electrons + 50.0)), 1)
                        half_box = max(4.0, (12.0 - vmag) * 1.5 + streak_len / 2.0)
                        for f_idx in range(len(frames)):
                            stars_projected.append({
                                "frame": f_idx,
                                "name": s["name"],
                                "class": "Star",
                                "x_px": round(x_px, 1),
                                "y_px": round(y_px, 1),
                                "ra_deg": float(s["ra_deg"]),
                                "dec_deg": float(s["dec_deg"]),
                                "vmag": vmag,
                                "snr": snr,
                                "electrons": round(electrons, 1),
                                "size_px": round(half_box * 2, 1),
                                "is_streak": is_stare,
                                "streak_length_px": round(streak_len, 1),
                                "bbox": [round(x_px - half_box, 1), round(y_px - half_box, 1), round(x_px + half_box, 1), round(y_px + half_box, 1)]
                            })

        duration = time.time() - t_start
        return SimulationResult(
            frames=frames,
            raw_flux_frames=raw_flux,
            stars_projected=stars_projected,
            targets_projected=targets_projected,
            config=config,
            execution_time_s=round(duration, 3),
            device_info=device_info,
            output_files=output_files
        )
