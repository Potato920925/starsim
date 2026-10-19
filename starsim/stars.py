"""Astronomical star catalog querying and astrometric projection.
Calculates exact celestial star positions and projects them onto the detector plane via Gnomonic TAN WCS.
"""

from __future__ import annotations
import math
import os
from typing import List, Dict, Any, Tuple, Optional
import numpy as np
import pandas as pd


def get_default_catalog_file() -> str:
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_dir, "data", "stars", "star_catalog_bsc5.csv")


class StarCatalog:
    """Manages astronomical star catalog and spatial queries."""

    def __init__(self, catalog_path: Optional[str] = None):
        if catalog_path is None:
            catalog_path = get_default_catalog_file()
        self.catalog_path = catalog_path
        self.df: Optional[pd.DataFrame] = None
        self._load()

    def _load(self) -> None:
        if os.path.isfile(self.catalog_path):
            self.df = pd.read_csv(self.catalog_path)
        else:
            # Fallback if catalog not yet generated: empty dataframe with correct columns
            self.df = pd.DataFrame(columns=["name", "ra_deg", "dec_deg", "vmag", "bv_color", "spectral_type"])

    def query_cone(
        self,
        center_ra_deg: float,
        center_dec_deg: float,
        radius_deg: float,
        limiting_mag: float = 14.0
    ) -> List[Dict[str, Any]]:
        """Query stars within an angular cone around (center_ra, center_dec)."""
        if self.df is None or len(self.df) == 0:
            return []

        ra0 = math.radians(center_ra_deg)
        dec0 = math.radians(center_dec_deg)

        ra_rad = np.radians(self.df["ra_deg"].values)
        dec_rad = np.radians(self.df["dec_deg"].values)

        # Spherical angular distance (Vincenty / great-circle formula)
        cos_d = np.sin(dec0) * np.sin(dec_rad) + np.cos(dec0) * np.cos(dec_rad) * np.cos(ra_rad - ra0)
        cos_d = np.clip(cos_d, -1.0, 1.0)
        dist_deg = np.degrees(np.arccos(cos_d))

        mask = (dist_deg <= radius_deg) & (self.df["vmag"].values <= limiting_mag)
        subset = self.df[mask]

        stars = []
        for _, row in subset.iterrows():
            stars.append({
                "name": str(row["name"]),
                "ra_deg": float(row["ra_deg"]),
                "dec_deg": float(row["dec_deg"]),
                "vmag": float(row["vmag"]),
                "bv_color": float(row.get("bv_color", 0.65)),
                "spectral_type": str(row.get("spectral_type", "G"))
            })
        return stars


def project_gnomonic_tan(
    ra_deg: float,
    dec_deg: float,
    center_ra_deg: float,
    center_dec_deg: float,
    roll_deg: float,
    pixel_scale_arcsec: float,
    center_x_px: float,
    center_y_px: float
) -> Tuple[float, float]:
    """Standard Astronomical Gnomonic (TAN) projection from celestial sphere to focal plane.
    Maps (RA, Dec) -> standard coordinates (xi, eta) -> pixel (x, y).
    """
    ra = math.radians(ra_deg)
    dec = math.radians(dec_deg)
    ra0 = math.radians(center_ra_deg)
    dec0 = math.radians(center_dec_deg)

    # Standard TAN projection coordinates (xi, eta in radians):
    cos_c = math.sin(dec0) * math.sin(dec) + math.cos(dec0) * math.cos(dec) * math.cos(ra - ra0)
    if cos_c <= 0.001:
        # Behind the plane of projection
        return (-9999.0, -9999.0)

    xi = (math.cos(dec) * math.sin(ra - ra0)) / cos_c
    eta = (math.cos(dec0) * math.sin(dec) - math.sin(dec0) * math.cos(dec) * math.cos(ra - ra0)) / cos_c

    # Convert radians to arcseconds:
    xi_arcsec = math.degrees(xi) * 3600.0
    eta_arcsec = math.degrees(eta) * 3600.0

    # Optical roll rotation:
    roll_rad = math.radians(roll_deg)
    cos_r = math.cos(roll_rad)
    sin_r = math.sin(roll_rad)

    # In standard astronomical orientation: North is Up (+eta), East is Left (-xi)
    # Applying rotation and pixel scaling:
    dx_arcsec = -(xi_arcsec * cos_r - eta_arcsec * sin_r)
    dy_arcsec = xi_arcsec * sin_r + eta_arcsec * cos_r

    x_px = center_x_px + dx_arcsec / pixel_scale_arcsec
    y_px = center_y_px + dy_arcsec / pixel_scale_arcsec

    return (x_px, y_px)


def calculate_star_electrons(
    vmag: float,
    aperture_m: float,
    bandwidth_nm: float,
    quantum_efficiency: float,
    exposure_s: float,
    transmission: float = 1.0
) -> float:
    """Calculate the expected total number of photoelectrons collected for a star of given V-magnitude.
    Based on standard astronomical photometric zero-point calibrations.
    """
    # Clear aperture area in cm^2:
    aperture_cm = aperture_m * 100.0
    area_cm2 = math.pi * ((aperture_cm / 2.0) ** 2)

    # V-band Vega flux for V=0: ~1000 photons / s / cm^2 / nm
    flux_0 = 1000.0 * area_cm2 * bandwidth_nm  # photons/sec
    photon_rate = flux_0 * (10.0 ** (-0.4 * vmag)) * max(0.001, transmission)

    electrons = photon_rate * exposure_s * quantum_efficiency
    return max(0.0, electrons)
