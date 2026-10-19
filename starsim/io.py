"""Astronomical I/O utilities:
FITS writer with standard WCS headers, PNG/TIFF image exporters with astrophotography contrast stretching,
and simulation ground-truth metadata export.
"""

from __future__ import annotations
import os
import json
import math
from typing import Optional, Dict, Any, Tuple
import numpy as np
from PIL import Image
from astropy.io import fits
from astropy.time import Time
from .config import StarSimConfig
from .engine.base import SimulationResult


def apply_contrast_stretch(
    data: np.ndarray,
    stretch: str = "zscale",
    vmin: Optional[float] = None,
    vmax: Optional[float] = None
) -> np.ndarray:
    """Apply astronomical contrast stretching and normalize to 8-bit [0, 255].
    Supported modes: 'zscale', 'linear', 'log', 'asinh'.
    """
    arr = data.astype(np.float32)

    if vmin is None or vmax is None:
        if stretch == "zscale":
            # Simplified astronomical Z-Scale (using median & interquartile range)
            med = float(np.median(arr))
            p10 = float(np.percentile(arr, 5))
            p99 = float(np.percentile(arr, 99.8))
            vmin = max(0.0, p10)
            vmax = max(vmin + 1.0, med + (p99 - med) * 1.5)
        else:
            vmin = float(np.percentile(arr, 1))
            vmax = float(np.percentile(arr, 99.9))
            if vmax <= vmin:
                vmax = vmin + 1.0

    # Clip values to [vmin, vmax]
    clipped = np.clip(arr, vmin, vmax)
    norm = (clipped - vmin) / (vmax - vmin)

    if stretch == "log":
        norm = np.log10(1.0 + 9.0 * norm)
    elif stretch == "asinh":
        beta = 0.1
        norm = np.arcsinh(norm / beta) / np.arcsinh(1.0 / beta)

    norm_8bit = np.clip(np.round(norm * 255.0), 0, 255).astype(np.uint8)
    return norm_8bit


def save_png(
    frame: np.ndarray,
    output_path: str,
    stretch: str = "zscale",
    vmin: Optional[float] = None,
    vmax: Optional[float] = None
) -> str:
    """Export 2D frame as a stretched PNG image."""
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    img_8bit = apply_contrast_stretch(frame, stretch=stretch, vmin=vmin, vmax=vmax)
    # Astronomical image convention: row 0 is at bottom when viewed in Cartesian coordinates,
    # so we flip vertically for standard image viewers so North is up:
    img_flipped = np.flipud(img_8bit)
    im = Image.fromarray(img_flipped, mode="L")
    im.save(output_path)
    return output_path


def _clean_ascii(val: str, max_len: int = 28) -> str:
    cleaned = str(val).encode("ascii", "ignore").decode("ascii").strip()
    return cleaned[:max_len] if cleaned else "UNKNOWN"


def save_fits(
    frame: np.ndarray,
    config: StarSimConfig,
    frame_index: int,
    output_path: str
) -> str:
    """Save frame as standard astronomical FITS file with complete WCS and observation headers."""
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    sensor = config.sensor
    site = config.site
    pointing = config.pointing
    atmosphere = config.atmosphere

    # Frame timing
    from astropy.time import TimeDelta
    t0 = Time(config.start_time_iso)
    frame_t = t0 + TimeDelta(frame_index * config.frame_interval_s, format="sec")
    frame_iso = frame_t.utc.isot

    ra_center, dec_center = pointing.get_equatorial(site, frame_iso)
    zenith_deg = pointing.get_zenith_angle_deg(site, frame_iso)

    w_px = sensor.detector.width_px
    h_px = sensor.detector.height_px
    pixel_scale_deg = sensor.pixel_scale_arcsec / 3600.0

    # Create Primary HDU
    hdu = fits.PrimaryHDU(frame)
    hdr = hdu.header

    # Telescope & Instrument
    hdr["TELESCOP"] = (_clean_ascii(sensor.name, 28), "Telescope/Sensor Model")
    hdr["INSTRUME"] = (_clean_ascii(sensor.sensor_id, 28), "Instrument ID")
    hdr["FILTER"] = (_clean_ascii(sensor.optical.filter_band, 10), "Optical Filter")
    hdr["APERTUR"] = (float(sensor.optical.aperture_m), "Aperture Diameter in meters")
    hdr["FOCALLEN"] = (float(sensor.optical.focal_length_m), "Focal Length in meters")
    hdr["PIXSIZE"] = (float(sensor.detector.pixel_size_um), "Pixel Size in micrometers")

    # Observation
    hdr["DATE-OBS"] = (str(frame_iso), "Observation UTC start time")
    hdr["EXPTIME"] = (float(config.exposure_time_s), "Exposure time in seconds")
    hdr["GAIN"] = (float(sensor.noise.gain_e_per_adu), "Electrons per ADU")
    hdr["RDNOISE"] = (float(sensor.noise.read_noise_e), "Read noise in electrons")
    hdr["DARKCUR"] = (float(sensor.noise.dark_current_eps), "Dark current e-/pix/s")
    hdr["AIRMASS"] = (round(1.0 / math.cos(math.radians(min(88.0, zenith_deg))), 3), "Estimated airmass")
    hdr["SEEING"] = (float(atmosphere.get_effective_seeing_fwhm(zenith_deg)), "Effective seeing FWHM (arcsec)")

    # Site
    hdr["SITENAME"] = (_clean_ascii(site.name, 28), "Observatory Site")
    hdr["SITELAT"] = (float(site.lat_deg), "Site latitude (deg)")
    hdr["SITELON"] = (float(site.lon_deg), "Site longitude (deg)")
    hdr["SITEALT"] = (float(site.alt_m), "Site altitude (m)")

    # World Coordinate System (WCS) TAN Gnomonic projection
    hdr["WCSAXES"] = (2, "Number of WCS axes")
    hdr["CRPIX1"] = (w_px / 2.0, "Reference pixel X")
    hdr["CRPIX2"] = (h_px / 2.0, "Reference pixel Y")
    hdr["CRVAL1"] = (ra_center, "Reference Right Ascension (deg)")
    hdr["CRVAL2"] = (dec_center, "Reference Declination (deg)")
    hdr["CTYPE1"] = ("RA---TAN", "Gnomonic projection RA")
    hdr["CTYPE2"] = ("DEC--TAN", "Gnomonic projection DEC")
    hdr["CDELT1"] = (-pixel_scale_deg, "Pixel scale X (deg/pix)")
    hdr["CDELT2"] = (pixel_scale_deg, "Pixel scale Y (deg/pix)")
    hdr["CROTA2"] = (pointing.roll_deg, "Rotation angle (deg)")

    hdu.writeto(output_path, overwrite=True)
    return output_path


def save_simulation_artifacts(result: SimulationResult, output_dir: str) -> Dict[str, List[str]]:
    """Save all simulation outputs: FITS, PNGs, and JSON annotations."""
    os.makedirs(output_dir, exist_ok=True)
    fits_paths = []
    png_paths = []

    for i, frame in enumerate(result.frames):
        fits_p = os.path.join(output_dir, f"frame_{i+1:03d}.fits")
        png_p = os.path.join(output_dir, f"frame_{i+1:03d}.png")

        save_fits(frame, result.config, frame_index=i, output_path=fits_p)
        save_png(frame, output_path=png_p, stretch="zscale")

        fits_paths.append(fits_p)
        png_paths.append(png_p)

    # Save metadata and annotations
    meta_path = os.path.join(output_dir, "simulation_meta.json")
    meta_dict = {
        "execution_time_s": result.execution_time_s,
        "device_info": result.device_info,
        "num_frames": len(result.frames),
        "stars_detected_count": len(result.stars_projected),
        "targets": result.targets_projected,
        "config": result.config.to_dict()
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta_dict, f, indent=2, ensure_ascii=False)

    return {
        "fits": fits_paths,
        "png": png_paths,
        "meta": [meta_path]
    }
