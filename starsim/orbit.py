"""Resident Space Object (RSO) and satellite orbit manager.
Supports real-time live satellite TLE updates from CelesTrak,
SGP4 propagation, Keplerian elements, state vectors,
and a Smart FOV Transit Generator that guarantees satellites cross the telescope's field of view.
"""

from __future__ import annotations
import math
import os
import urllib.request
from enum import Enum
from dataclasses import dataclass, field, asdict
from typing import Dict, Any, List, Tuple, Optional
import numpy as np
from astropy.time import Time
from astropy.coordinates import SkyCoord, EarthLocation, AltAz, TEME, CartesianRepresentation
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


def get_default_rso_dir() -> str:
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_dir, "data", "rso")


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
    norad_id: Optional[str] = None
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
    def from_tle(cls, name: str, tle1: str, tle2: str, vmag: float = 8.0, norad_id: Optional[str] = None) -> "TargetOrbit":
        """Create target from TLE lines."""
        return cls(name=name, mode=OrbitMode.TLE, tle1=tle1.strip(), tle2=tle2.strip(), visual_magnitude=vmag, norad_id=norad_id)

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


class LiveSatelliteManager:
    """Manages real-time live satellite orbit datasets from CelesTrak with automatic caching."""

    CELESTRAK_GROUPS = {
        "visual": "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle",
        "stations": "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle",
        "active": "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle",
        "starlink": "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle"
    }

    @classmethod
    def fetch_or_load_tles(cls, group: str = "visual", force_refresh: bool = False) -> List[Dict[str, Any]]:
        """Download or read cached TLEs for a given satellite group."""
        rso_dir = get_default_rso_dir()
        os.makedirs(rso_dir, exist_ok=True)
        cache_file = os.path.join(rso_dir, f"{group}.tle")

        content = ""
        if force_refresh or not os.path.isfile(cache_file):
            url = cls.CELESTRAK_GROUPS.get(group, cls.CELESTRAK_GROUPS["visual"])
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "StarSim/1.0 (Mozilla/5.0)"})
                with urllib.request.urlopen(req, timeout=12) as response:
                    content = response.read().decode("utf-8")
                    with open(cache_file, "w", encoding="utf-8") as f:
                        f.write(content)
            except Exception as e:
                # If network fails, try reading cached copy
                if os.path.isfile(cache_file):
                    with open(cache_file, "r", encoding="utf-8") as f:
                        content = f.read()
                else:
                    return cls._get_builtin_fallback_satellites()
        else:
            with open(cache_file, "r", encoding="utf-8") as f:
                content = f.read()

        satellites = cls._parse_tle_content(content)
        return satellites if satellites else cls._get_builtin_fallback_satellites()

    @classmethod
    def _parse_tle_content(cls, content: str) -> List[Dict[str, Any]]:
        lines = [line.strip() for line in content.splitlines() if line.strip()]
        satellites = []
        i = 0
        while i < len(lines):
            # Check 3-line format (Name, TLE1, TLE2)
            if lines[i].startswith("1 ") and i + 1 < len(lines) and lines[i + 1].startswith("2 "):
                name = f"SAT_{lines[i][2:7].strip()}"
                tle1 = lines[i]
                tle2 = lines[i + 1]
                i += 2
            elif i + 2 < len(lines) and lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 "):
                name = lines[i]
                tle1 = lines[i + 1]
                tle2 = lines[i + 2]
                i += 3
            else:
                i += 1
                continue

            try:
                norad_id = tle1[2:7].strip()
                satrec = Satrec.twoline2rv(tle1, tle2, WGS72)
                # Estimate visual magnitude based on object type/name
                vmag = 7.5
                if "ISS" in name or "ZARYA" in name:
                    vmag = 3.5
                elif "TIANGONG" in name or "CSS" in name:
                    vmag = 4.0
                elif "HST" in name or "HUBBLE" in name:
                    vmag = 6.0
                elif "STARLINK" in name:
                    vmag = 7.0
                elif "R/B" in name:
                    vmag = 6.5

                satellites.append({
                    "name": name,
                    "norad_id": norad_id,
                    "tle1": tle1,
                    "tle2": tle2,
                    "satrec": satrec,
                    "vmag": vmag
                })
            except Exception:
                pass
        return satellites

    @classmethod
    def _get_builtin_fallback_satellites(cls) -> List[Dict[str, Any]]:
        satellites = []
        for key, p in POPULAR_TLES.items():
            satrec = Satrec.twoline2rv(p["tle1"], p["tle2"], WGS72)
            satellites.append({
                "name": p["name"],
                "norad_id": p["tle1"][2:7].strip(),
                "tle1": p["tle1"],
                "tle2": p["tle2"],
                "satrec": satrec,
                "vmag": p["vmag"]
            })
        return satellites

    @classmethod
    def get_sky_positions(
        cls,
        site: ObservationSite,
        obstime_iso: str,
        group: str = "visual",
        min_alt_deg: float = 0.0
    ) -> List[Dict[str, Any]]:
        """Calculate topocentric (Az, Alt, RA, Dec) sky positions of all satellites in the group."""
        satellites = cls.fetch_or_load_tles(group=group)
        t = Time(obstime_iso)
        jd, fr = jday(t.datetime.year, t.datetime.month, t.datetime.day,
                      t.datetime.hour, t.datetime.minute,
                      t.datetime.second + t.datetime.microsecond * 1e-6)

        visible = []
        altaz_frame = AltAz(obstime=t, location=site.earth_location)

        for s in satellites:
            satrec = s["satrec"]
            e, r_teme, _ = satrec.sgp4(jd, fr)
            if e != 0:
                continue

            try:
                sat_teme = TEME(
                    CartesianRepresentation(r_teme[0] * u.km, r_teme[1] * u.km, r_teme[2] * u.km),
                    obstime=t
                )
                coord = SkyCoord(sat_teme)
                altaz = coord.transform_to(altaz_frame)
                alt_deg = float(altaz.alt.deg)

                if alt_deg >= min_alt_deg:
                    icrs = coord.icrs
                    visible.append({
                        "name": s["name"],
                        "norad_id": s["norad_id"],
                        "tle1": s["tle1"],
                        "tle2": s["tle2"],
                        "az_deg": round(float(altaz.az.deg), 2),
                        "alt_deg": round(alt_deg, 2),
                        "ra_deg": round(float(icrs.ra.deg), 2),
                        "dec_deg": round(float(icrs.dec.deg), 2),
                        "distance_km": round(float(altaz.distance.to_value(u.km)), 1),
                        "vmag": s["vmag"]
                    })
            except Exception:
                pass

        return visible

    @classmethod
    def find_transiting_satellites(
        cls,
        site: ObservationSite,
        pointing_ra_deg: float,
        pointing_dec_deg: float,
        fov_deg: Tuple[float, float],
        t_start_iso: str,
        t_end_iso: str,
        group: str = "visual"
    ) -> List[Dict[str, Any]]:
        """Find all satellites that cross through or near the telescope FOV during the exposure window."""
        satellites = cls.fetch_or_load_tles(group=group)
        t0 = Time(t_start_iso)
        t1 = Time(t_end_iso)
        duration_s = max(1.0, (t1 - t0).to_value("sec"))

        n_samples = max(5, int(duration_s / 0.5))
        sample_times = t0 + np.linspace(0.0, duration_s, n_samples) * (1.0 / 86400.0)

        # FOV diagonal radius in degrees
        max_sep_deg = (math.hypot(fov_deg[0], fov_deg[1]) / 2.0) * 1.5

        pointing_coord = SkyCoord(ra=pointing_ra_deg * u.deg, dec=pointing_dec_deg * u.deg, frame="icrs")
        transits = []

        for s in satellites:
            satrec = s["satrec"]
            positions = []
            min_sep = 999.0
            best_time = None

            for st in sample_times:
                jd, fr = jday(st.datetime.year, st.datetime.month, st.datetime.day,
                              st.datetime.hour, st.datetime.minute,
                              st.datetime.second + st.datetime.microsecond * 1e-6)
                e, r_teme, _ = satrec.sgp4(jd, fr)
                if e != 0:
                    continue

                try:
                    sat_teme = TEME(
                        CartesianRepresentation(r_teme[0] * u.km, r_teme[1] * u.km, r_teme[2] * u.km),
                        obstime=st
                    )
                    coord = SkyCoord(sat_teme).icrs
                    sep = float(pointing_coord.separation(coord).deg)
                    if sep < min_sep:
                        min_sep = sep
                        best_time = st.utc.isot + "Z"
                    positions.append((float(coord.ra.deg), float(coord.dec.deg), sep))
                except Exception:
                    pass

            if min_sep <= max_sep_deg and len(positions) >= 2:
                # Calculate angular speed in deg/sec
                d_ra = (positions[-1][0] - positions[0][0]) * math.cos(math.radians(pointing_dec_deg))
                d_dec = positions[-1][1] - positions[0][1]
                speed_deg_s = math.hypot(d_ra, d_dec) / duration_s

                transits.append({
                    "name": s["name"],
                    "norad_id": s["norad_id"],
                    "tle1": s["tle1"],
                    "tle2": s["tle2"],
                    "vmag": s["vmag"],
                    "min_separation_deg": round(min_sep, 3),
                    "transit_time_iso": best_time,
                    "speed_deg_s": round(speed_deg_s, 4),
                    "start_ra_dec": (round(positions[0][0], 2), round(positions[0][1], 2)),
                    "end_ra_dec": (round(positions[-1][0], 2), round(positions[-1][1], 2))
                })

        transits.sort(key=lambda x: x["min_separation_deg"])
        return transits


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
        """Compute topocentric trajectory across the image plane [0, width_px] x [0, height_px]."""
        t0 = Time(t_start_iso)
        t1 = Time(t_end_iso)
        duration_s = max(0.1, (t1 - t0).to_value("sec"))

        h_km = target.transit_altitude_km
        r_orb_km = R_EARTH_KM + h_km
        v_orb_kms = math.sqrt(MU_EARTH / r_orb_km)
        omega_rad_s = v_orb_kms / h_km
        omega_arcsec_s = math.degrees(omega_rad_s) * 3600.0

        speed_px_s = omega_arcsec_s / pixel_scale_arcsec
        angle_rad = math.radians(target.transit_angle_deg)
        dx_dt = speed_px_s * math.cos(angle_rad)
        dy_dt = speed_px_s * math.sin(angle_rad)

        cx = width_px / 2.0 + target.transit_offset_px[0]
        cy = height_px / 2.0 + target.transit_offset_px[1]

        times = np.linspace(0.0, duration_s, n_steps)
        t_mid = duration_s / 2.0
        dt_mid = times - t_mid

        x_px = cx + dx_dt * dt_mid
        y_px = cy + dy_dt * dt_mid

        cos_dec = max(0.01, math.cos(math.radians(pointing_dec_deg)))
        d_ra_deg = ((x_px - width_px / 2.0) * pixel_scale_arcsec / 3600.0) / cos_dec
        d_dec_deg = (y_px - height_px / 2.0) * pixel_scale_arcsec / 3600.0

        ra_arr = pointing_ra_deg + d_ra_deg
        dec_arr = pointing_dec_deg + d_dec_deg

        streak_length_px = math.hypot(x_px[-1] - x_px[0], y_px[-1] - y_px[0])

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
            "center_pixel": (float((x_px[0] + x_px[-1]) / 2.0), float((y_px[0] + y_px[-1]) / 2.0)),
            "streak_length_px": streak_length_px,
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
            return None

        try:
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
        except Exception:
            return None
