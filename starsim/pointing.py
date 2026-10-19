"""Observation pointing direction, tracking modes, and coordinate frame transformations.
Seamlessly handles equatorial (RA, Dec) and horizontal (Az, Alt/El) coordinates.
"""

from __future__ import annotations
from enum import Enum
from dataclasses import dataclass, asdict
from typing import Dict, Any, Tuple
import astropy.units as u
from astropy.coordinates import SkyCoord, AltAz
from astropy.time import Time
from .site import ObservationSite


class TrackingMode(str, Enum):
    SIDEREAL = "sidereal"          # Telescope tracks stars: stars are sharp points, satellites streak
    RATE_TRACK = "rate_track"      # Telescope tracks satellite: satellite is sharp, stars streak
    STARE = "stare"                # Fixed mount (Earth-fixed): both stars and satellites streak


@dataclass
class PointingDirection:
    coord_frame: str = "radec"     # "radec" or "altaz"
    ra_deg: float = 88.79          # Right Ascension (degrees, 0 to 360) e.g. Betelgeuse in Orion
    dec_deg: float = 7.41          # Declination (degrees, -90 to +90)
    az_deg: float = 180.0          # Azimuth (degrees, 0=North, 90=East, 180=South, 270=West)
    alt_deg: float = 60.0          # Altitude / Elevation above horizon (degrees, 0 to 90)
    roll_deg: float = 0.0          # Optical roll / position angle (degrees)
    tracking_mode: TrackingMode = TrackingMode.SIDEREAL

    def validate(self) -> None:
        if self.coord_frame not in ("radec", "altaz"):
            raise ValueError(f"coord_frame must be 'radec' or 'altaz', got {self.coord_frame}")
        if not (0.0 <= self.ra_deg <= 360.0):
            self.ra_deg = self.ra_deg % 360.0
        if not (-90.0 <= self.dec_deg <= 90.0):
            raise ValueError(f"Declination must be between -90 and 90, got {self.dec_deg}")
        if not (0.0 <= self.alt_deg <= 90.0):
            raise ValueError(f"Altitude must be between 0 and 90, got {self.alt_deg}")

    def get_equatorial(self, site: ObservationSite, obstime_str: str) -> Tuple[float, float]:
        """Get (RA, Dec) in degrees for this pointing given the site and time.
        If coord_frame is 'altaz', computes instantaneous topocentric ICRS (RA, Dec).
        """
        self.validate()
        if self.coord_frame == "radec":
            return (self.ra_deg, self.dec_deg)

        time = Time(obstime_str)
        altaz_frame = AltAz(obstime=time, location=site.earth_location)
        target_altaz = SkyCoord(az=self.az_deg * u.deg, alt=self.alt_deg * u.deg, frame=altaz_frame)
        icrs = target_altaz.transform_to("icrs")
        return (float(icrs.ra.deg), float(icrs.dec.deg))

    def get_horizontal(self, site: ObservationSite, obstime_str: str) -> Tuple[float, float]:
        """Get (Azimuth, Altitude) in degrees given site and time."""
        self.validate()
        if self.coord_frame == "altaz":
            return (self.az_deg, self.alt_deg)

        time = Time(obstime_str)
        target = SkyCoord(ra=self.ra_deg * u.deg, dec=self.dec_deg * u.deg, frame="icrs")
        altaz = target.transform_to(AltAz(obstime=time, location=site.earth_location))
        return (float(altaz.az.deg), float(altaz.alt.deg))

    def get_zenith_angle_deg(self, site: ObservationSite, obstime_str: str) -> float:
        """Calculate zenith angle z = 90 - altitude in degrees."""
        _, alt = self.get_horizontal(site, obstime_str)
        return max(0.0, 90.0 - alt)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["tracking_mode"] = self.tracking_mode.value if isinstance(self.tracking_mode, TrackingMode) else self.tracking_mode
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PointingDirection":
        data_copy = dict(data)
        if "tracking_mode" in data_copy and isinstance(data_copy["tracking_mode"], str):
            data_copy["tracking_mode"] = TrackingMode(data_copy["tracking_mode"])
        return cls(**data_copy)
