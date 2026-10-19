"""Resident Space Object (RSO) and satellite orbit manager.
Supports TLE parsing and SGP4 propagation, Keplerian elements, state vectors,
and a Smart FOV Transit Generator that guarantees satellites cross the telescope's field of view.
"""

from __future__ import annotations
import math
from enum import Enum
from dataclasses import dataclass, field, asdict
from typing import Dict, Any, List, Tuple, Optional
import numpy as np
from astropy.time import Time
from astropy.coordinates import SkyCoord, EarthLocation, AltAz
import astropy.units as u
from sgp4.api import Satrec, WGS72
from sgp4.api import jday
from .site import ObservationSite


class OrbitMode(str, Enum):
    TLE = "tle"
    KEPLERIAN = "keplerian"
    STATE_VECTOR = "state_vector"
    SMART_TRANSIT = "smart_transit"


# Earth gravitational parameter mu = G*M in km^3 / s^2
MU_EARTH = 398600.4418
# Earth mean equatorial radius in km
R_EARTH_KM = 6378.137


POPULAR_TLES = {
    "iss": {
        "name": "ISS (ZARYA)",
        "tle1": "1 25544U 98067A   24080.52840278  .00014815  00000-0  26909-3 0  9993",
        "tle2": "2 25544  51.6421 216.7909 0004561 113.8247 319.4632 15.49868725444747",
        "vmag": 3.5
    },
    "tiangong": {
        "name": "CSS (TIANGONG)",
        "tle1": "1 48274U 21035A   24080.52083333  .00015000  00000-0  18000-3 0  9991",
        "tle2": "2 48274  41.4720 185.3410 0005230 142.1200 218.0100 15.60230000164201",
        "vmag": 4.0
    },
    "hubble": {
        "name": "HST (HUBBLE)",
        "tle1": "1 20580U 90037B   24080.50000000  .00001200  00000-0  56000-4 0  9995",
        "tle2": "2 20580  28.4690 120.4500 0002800 280.1200  79.8900 15.08500000854302",
        "vmag": 6.5
    },
    "starlink": {
        "name": "STARLINK-1007",
        "tle1": "1 44713U 19074A   24080.50000000  .00001800  00000-0  11000-3 0  9992",
        "tle2": "2 44713  53.0540 240.1200 0001400  95.4200 264.7100 15.06400000240103",
        "vmag": 7.0
    }
}


@dataclass
class TargetOrbit:
    name: str = "Target_RSO"
    mode: OrbitMode = OrbitMode.SMART_TRANSIT
    # TLE fields
    tle1: str = ""
    tle2: str = ""
    # Smart Transit / Generated fields
    transit_altitude_km: float = 500.0        # Altitude above sea level in km
    transit_velocity_kms: float = 7.6         # Approximate orbital velocity in km/s
    transit_angle_deg: float = 45.0           # Angle of motion across detector plane (deg)
    transit_offset_px: Tuple[float, float] = (0.0, 0.0) # Offset from center of FOV at midpoint (pixels)
    # Photometry
    visual_magnitude: float = 8.5             # Apparent V-band magnitude
    rcs_m2: float = 1.0                       # Radar Cross Section / surface area (m^2)

    def __post_init__(self):
        if isinstance(self.mode, str):
            self.mode = OrbitMode(self.mode)

    @classmethod
    def from_tle(cls, name: str, tle1: str, tle2: str, vmag: float = 8.0) -> "TargetOrbit":
        """Create target from TLE lines."""
        return cls(name=name, mode=OrbitMode.TLE, tle1=tle1.strip(), tle2=tle2.strip(), visual_magnitude=vmag)

    @classmethod
    def from_preset(cls, key: str) -> "TargetOrbit":
        """Load target from built-in satellite TLE presets."""
        if key not in POPULAR_TLES:
            raise KeyError(f"Preset '{key}' not found. Available: {list(POPULAR_TLES.keys())}")
        p = POPULAR_TLES[key]
        return cls.from_tle(name=p["name"], tle1=p["tle1"], tle2=p["tle2"], vmag=p["vmag"])

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["mode"] = self.mode.value if isinstance(self.mode, OrbitMode) else self.mode
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TargetOrbit":
        data_copy = dict(data)
        if "mode" in data_copy and isinstance(data_copy["mode"], str):
            data_copy["mode"] = OrbitMode(data_copy["mode"])
        return cls(**data_copy)


class SmartTransitGenerator:
    """Computes satellite trajectories that are mathematically guaranteed to transit
    the telescope's field of view during the observation time window.
    """

    @staticmethod
    def generate_transit_trajectory(
        target: TargetOrbit,
        site: ObservationSite,
        pointing_ra_deg: float,
        pointing_dec_deg: float,
        pixel_scale_arcsec: float,
        width_px: int,
        height_px: int,
        t_start_iso: str,
        t_end_iso: str,
        n_steps: int = 100
    ) -> Dict[str, Any]:
        """Compute topocentric trajectory across the image plane [0, width_px] x [0, height_px].
        Returns trajectory positions in pixels (x, y) and topocentric (RA, Dec) over time.
        """
        t0 = Time(t_start_iso)
        t1 = Time(t_end_iso)
        duration_s = max(0.1, (t1 - t0).to_value('sec'))

        # Angular velocity across sky:
        # For circular orbit at altitude h: orbital speed v = sqrt(mu / (R_E + h))
        h_km = target.transit_altitude_km
        r_orb_km = R_EARTH_KM + h_km
        v_orb_kms = math.sqrt(MU_EARTH / r_orb_km)
        # Angular speed in rad/s from ground looking at distance h_km:
        omega_rad_s = v_orb_kms / h_km
        omega_arcsec_s = math.degrees(omega_rad_s) * 3600.0

        # Angular speed in pixels/second:
        speed_px_s = omega_arcsec_s / pixel_scale_arcsec

        # Transit direction angle in detector coordinates (0=right, 90=up)
        angle_rad = math.radians(target.transit_angle_deg)
        dx_dt = speed_px_s * math.cos(angle_rad)
        dy_dt = speed_px_s * math.sin(angle_rad)

        # Center point at midpoint time t_mid:
        cx = width_px / 2.0 + target.transit_offset_px[0]
        cy = height_px / 2.0 + target.transit_offset_px[1]

        # Time array:
        times = np.linspace(0.0, duration_s, n_steps)
        # Offset from midpoint:
        t_mid = duration_s / 2.0
        dt_mid = times - t_mid

        # Pixel coordinates (x(t), y(t)):
        x_px = cx + dx_dt * dt_mid
        y_px = cy + dy_dt * dt_mid

        # Convert pixel offsets back to celestial (RA, Dec) differences:
        # dx_px * pixel_scale / 3600 = d_alpha * cos(dec), dy_px * pixel_scale / 3600 = d_dec
        cos_dec = max(0.01, math.cos(math.radians(pointing_dec_deg)))
        d_ra_deg = ((x_px - width_px / 2.0) * pixel_scale_arcsec / 3600.0) / cos_dec
        d_dec_deg = (y_px - height_px / 2.0) * pixel_scale_arcsec / 3600.0

        ra_arr = pointing_ra_deg + d_ra_deg
        dec_arr = pointing_dec_deg + d_dec_deg

        return {
            "times_s": times.tolist(),
            "x_px": x_px.tolist(),
            "y_px": y_px.tolist(),
            "ra_deg": ra_arr.tolist(),
            "dec_deg": dec_arr.tolist(),
            "speed_px_s": speed_px_s,
            "speed_arcsec_s": omega_arcsec_s,
            "start_pixel": (float(x_px[0]), float(y_px[0])),
            "end_pixel": (float(x_px[-1]), float(y_px[-1])),
            "vmag": target.visual_magnitude
        }


class SGP4Propagator:
    """Propagates real satellite orbits using SGP4 and Two-Line Elements."""

    @staticmethod
    def propagate_tle(
        tle1: str,
        tle2: str,
        site: ObservationSite,
        obstime_iso: str
    ) -> Optional[Dict[str, float]]:
        """Propagate TLE to topocentric RA, Dec, Az, Alt, and Range for given site and time."""
        sat = Satrec.twoline2rv(tle1, tle2, WGS72)
        t = Time(obstime_iso)
        jd, fr = jday(t.datetime.year, t.datetime.month, t.datetime.day,
                      t.datetime.hour, t.datetime.minute,
                      t.datetime.second + t.datetime.microsecond * 1e-6)

        e, r_teme, v_teme = sat.sgp4(jd, fr)
        if e != 0:
            return None  # SGP4 propagation error / decayed satellite

        # Convert TEME position in km to topocentric Az/Alt using Astropy
        # Astropy TEME frame
        from astropy.coordinates import TEME, CartesianRepresentation, SkyCoord
        sat_teme = TEME(
            CartesianRepresentation(r_teme[0] * u.km, r_teme[1] * u.km, r_teme[2] * u.km),
            obstime=t
        )
        sat_coord = SkyCoord(sat_teme)
        altaz_frame = AltAz(obstime=t, location=site.earth_location)
        sat_altaz = sat_coord.transform_to(altaz_frame)
        sat_icrs = sat_coord.icrs

        return {
            "ra_deg": float(sat_icrs.ra.deg),
            "dec_deg": float(sat_icrs.dec.deg),
            "az_deg": float(sat_altaz.az.deg),
            "alt_deg": float(sat_altaz.alt.deg),
            "distance_km": float(sat_altaz.distance.to_value(u.km))
        }
