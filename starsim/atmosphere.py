"""Atmospheric and weather modeling:
Seeing Point Spread Function (PSF), atmospheric extinction, airmass,
cloud attenuation, and sky background radiance (Moon, twilight, Bortle skyglow).
"""

from __future__ import annotations
import math
from dataclasses import dataclass, asdict
from typing import Dict, Any


# Bortle dark sky scale to approximate visual surface brightness (V mag / arcsec^2)
BORTLE_SURFACE_BRIGHTNESS: Dict[int, float] = {
    1: 21.9,   # Excellent dark-sky site (e.g. Mauna Kea, Atacama)
    2: 21.6,   # Truly dark site
    3: 21.3,   # Rural sky
    4: 20.8,   # Rural/suburban transition
    5: 19.8,   # Suburban sky
    6: 19.0,   # Bright suburban sky
    7: 18.2,   # Suburban/urban transition
    8: 17.5,   # City sky
    9: 16.5    # Inner-city sky
}


def calculate_airmass(zenith_angle_deg: float) -> float:
    """Calculate atmospheric airmass X(z) using Rozenberg (1966) formulation.
    Handles zenith angles up to 90 degrees smoothly without division by zero.
    """
    z_rad = math.radians(min(89.5, max(0.0, zenith_angle_deg)))
    cos_z = math.cos(z_rad)
    return 1.0 / (cos_z + 0.025 * math.exp(-11.0 * cos_z))


@dataclass
class AtmosphericConditions:
    seeing_fwhm_arcsec: float = 1.5           # Atmospheric seeing FWHM at zenith (arcsec)
    extinction_kv: float = 0.15               # Extinction coefficient in V-band (mag/airmass)
    cloud_cover_percent: float = 0.0          # Cloud cover percentage (0% to 100%)
    bortle_class: int = 2                     # Bortle Dark-Sky Scale (1 = Pristine, 9 = Inner-City)
    moon_illumination: float = 0.0            # Moon illuminated fraction (0.0=New, 1.0=Full)
    moon_sep_deg: float = 90.0                # Angular separation between Moon and target pointing (deg)

    def validate(self) -> None:
        if self.seeing_fwhm_arcsec <= 0:
            raise ValueError(f"Seeing FWHM must be positive, got {self.seeing_fwhm_arcsec}")
        if self.extinction_kv < 0:
            raise ValueError(f"Extinction coefficient cannot be negative, got {self.extinction_kv}")
        if not (0.0 <= self.cloud_cover_percent <= 100.0):
            raise ValueError(f"Cloud cover must be between 0 and 100%, got {self.cloud_cover_percent}")
        if not (1 <= self.bortle_class <= 9):
            raise ValueError(f"Bortle class must be an integer between 1 and 9, got {self.bortle_class}")
        if not (0.0 <= self.moon_illumination <= 1.0):
            raise ValueError(f"Moon illumination must be between 0 and 1, got {self.moon_illumination}")

    def get_effective_seeing_fwhm(self, zenith_angle_deg: float) -> float:
        """Kolmogorov turbulence scaling of seeing FWHM with airmass: FWHM(z) = FWHM_0 * X(z)^0.6."""
        airmass = calculate_airmass(zenith_angle_deg)
        return self.seeing_fwhm_arcsec * (airmass ** 0.6)

    def get_atmospheric_transmission(self, zenith_angle_deg: float) -> float:
        """Calculate total atmospheric transmission factor T_atm in [0, 1].
        Combines Rayleigh + aerosol airmass extinction and cloud cover attenuation.
        """
        airmass = calculate_airmass(zenith_angle_deg)
        # Delta mag from extinction
        delta_mag = self.extinction_kv * airmass
        trans_extinction = 10.0 ** (-0.4 * delta_mag)

        # Cloud attenuation: cloud_cover_percent attenuates light
        cloud_trans = 1.0 - 0.90 * (self.cloud_cover_percent / 100.0)
        return max(0.001, trans_extinction * cloud_trans)

    def get_sky_surface_brightness_mag(self) -> float:
        """Get sky surface brightness in V-mag / arcsec^2, including moonlight contribution."""
        base_mag = BORTLE_SURFACE_BRIGHTNESS.get(self.bortle_class, 21.0)
        base_flux = 10.0 ** (-0.4 * base_mag)

        # Krisciunas & Schaefer (1991) simplified moonlight scattering contribution
        if self.moon_illumination > 0.01:
            sep = max(10.0, min(180.0, self.moon_sep_deg))
            # Scattering phase function approx: f(sep) ~ sep^(-1.5)
            moon_flux = 10.0 ** (-0.4 * 18.0) * self.moon_illumination * (30.0 / sep) ** 1.3
            total_flux = base_flux + moon_flux
            return -2.5 * math.log10(total_flux)
        return base_mag

    def calculate_sky_background_electrons(
        self,
        pixel_scale_arcsec: float,
        aperture_m: float,
        bandwidth_nm: float,
        quantum_efficiency: float,
        exposure_s: float
    ) -> float:
        """Calculate the average sky background photon/electron count per pixel per exposure."""
        sky_mag = self.get_sky_surface_brightness_mag()
        # Pixel solid area in arcsec^2
        pixel_area_sqarcsec = pixel_scale_arcsec * pixel_scale_arcsec
        # Integrated magnitude of one pixel's area of sky
        pixel_mag = sky_mag - 2.5 * math.log10(pixel_area_sqarcsec)

        # Standard Vega zero-magnitude photon flux: ~1.0e4 photons / s / cm^2 / nm
        # Aperture collection area in cm^2:
        area_cm2 = math.pi * ((aperture_m * 100.0 / 2.0) ** 2)
        flux_0 = 1000.0 * area_cm2 * bandwidth_nm  # photons/sec at mag 0
        photon_rate = flux_0 * (10.0 ** (-0.4 * pixel_mag))

        # Electrons generated
        electrons = photon_rate * exposure_s * quantum_efficiency
        return max(0.0, electrons)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AtmosphericConditions":
        return cls(**data)
