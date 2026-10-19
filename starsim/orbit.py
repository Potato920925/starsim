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
        "tle1": "1 25544U 98067A   26292.17690977  .00007475  00000+0  14397-3 0  9996",
        "tle2": "2 25544  51.6325  46.5187 0006760 281.9553  78.0677 15.48935490590970",
        "vmag": 3.5
    },
    "tiangong": {
        "name": "CSS (TIANGONG)",
        "tle1": "1 48274U 21035A   26292.21113873  .00020624  00000+0  24255-3 0  9997",
        "tle2": "2 48274  41.4690 288.6568 0001565 178.7319 181.3524 15.60932871312537",
        "vmag": 4.0
    },
    "hubble": {
        "name": "HST (HUBBLE)",
        "tle1": "1 20580U 90037B   26291.94679926  .00002865  00000+0  33402-3 0  9996",
        "tle2": "2 20580  28.4690 120.4500 0002800 280.1200  79.8900 15.08500000854302",
        "vmag": 6.5
    },
    "starlink": {
        "name": "STARLINK-1008",
        "tle1": "1 44714U 19074B   26292.10353693  .00048057  00000+0  43854-3 0  9992",
        "tle2": "2 44714  53.1443 186.7069 0002756 134.2207 225.9036 15.67409625383554",
        "vmag": 6.0
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
        # Auto-resolve popular preset TLE if tle1 is not specified
        if self.mode == OrbitMode.TLE and (not self.tle1 or not self.tle2):
            key = self.name.lower().replace(" ", "").replace("_", "")
            for pkey, pval in POPULAR_TLES.items():
                if pkey in key or key in pkey:
                    self.name = pval["name"]
                    self.tle1 = pval["tle1"]
                    self.tle2 = pval["tle2"]
                    if not self.visual_magnitude or self.visual_magnitude == 8.5:
                        self.visual_magnitude = pval["vmag"]
                    break

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

        valid_sats = []
        xs, ys, zs = [], [], []
        for s in satellites:
            satrec = s["satrec"]
            e, r_teme, _ = satrec.sgp4(jd, fr)
            if e != 0:
                continue
            valid_sats.append(s)
            xs.append(r_teme[0])
            ys.append(r_teme[1])
            zs.append(r_teme[2])

        if not valid_sats:
            return []

        # Vectorized Astropy TEME -> AltAz and ICRS
        rep = CartesianRepresentation(np.array(xs) * u.km, np.array(ys) * u.km, np.array(zs) * u.km)
        altaz_frame = AltAz(obstime=t, location=site.earth_location)
        coords = SkyCoord(TEME(rep, obstime=t))
        altaz = coords.transform_to(altaz_frame)
        icrs = coords.icrs

        az_arr = np.atleast_1d(altaz.az.deg)
        alt_arr = np.atleast_1d(altaz.alt.deg)
        dist_arr = np.atleast_1d(altaz.distance.to_value(u.km))
        ra_arr = np.atleast_1d(icrs.ra.deg)
        dec_arr = np.atleast_1d(icrs.dec.deg)

        visible = []
        for i, s in enumerate(valid_sats):
            alt_deg = float(alt_arr[i])
            if alt_deg >= min_alt_deg:
                visible.append({
                    "name": s["name"],
                    "norad_id": s["norad_id"],
                    "tle1": s["tle1"],
                    "tle2": s["tle2"],
                    "az_deg": round(float(az_arr[i]), 2),
                    "alt_deg": round(alt_deg, 2),
                    "ra_deg": round(float(ra_arr[i]), 2),
                    "dec_deg": round(float(dec_arr[i]), 2),
                    "distance_km": round(float(dist_arr[i]), 1),
                    "vmag": s["vmag"]
                })
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

        n_samples = max(4, min(10, int(duration_s / 0.5)))
        sample_times = t0 + np.linspace(0.0, duration_s, n_samples) * (1.0 / 86400.0)

        # Quick pre-filter: calculate AltAz at t0. Satellites with alt < -12 deg cannot reach FOV in seconds
        jd0, fr0 = jday(t0.datetime.year, t0.datetime.month, t0.datetime.day,
                        t0.datetime.hour, t0.datetime.minute,
                        t0.datetime.second + t0.datetime.microsecond * 1e-6)

        valid_sats = []
        xs0, ys0, zs0 = [], [], []
        for s in satellites:
            e, r, _ = s["satrec"].sgp4(jd0, fr0)
            if e == 0:
                valid_sats.append(s)
                xs0.append(r[0])
                ys0.append(r[1])
                zs0.append(r[2])

        if not valid_sats:
            return []

        rep0 = CartesianRepresentation(np.array(xs0) * u.km, np.array(ys0) * u.km, np.array(zs0) * u.km)
        altaz_frame0 = AltAz(obstime=t0, location=site.earth_location)
        altaz0 = SkyCoord(TEME(rep0, obstime=t0)).transform_to(altaz_frame0)
        alt0_arr = np.atleast_1d(altaz0.alt.deg)

        # Retain candidate satellites near or above horizon
        candidate_sats = [valid_sats[i] for i in range(len(valid_sats)) if alt0_arr[i] > -12.0]
        if not candidate_sats:
            return []

        pointing_coord = SkyCoord(ra=pointing_ra_deg * u.deg, dec=pointing_dec_deg * u.deg, frame="icrs")
        fov_radius_deg = (math.hypot(fov_deg[0], fov_deg[1]) / 2.0)
        # Search radius covers exact transits and all visible overhead satellites
        search_radius_deg = 180.0

        # Vectorized coordinate computation across sample times
        all_icrs_coords = []
        for st in sample_times:
            jd_s, fr_s = jday(st.datetime.year, st.datetime.month, st.datetime.day,
                              st.datetime.hour, st.datetime.minute,
                              st.datetime.second + st.datetime.microsecond * 1e-6)
            xs, ys, zs = [], [], []
            for s in candidate_sats:
                e, r, _ = s["satrec"].sgp4(jd_s, fr_s)
                if e == 0:
                    xs.append(r[0])
                    ys.append(r[1])
                    zs.append(r[2])
                else:
                    xs.append(0.0)
                    ys.append(0.0)
                    zs.append(0.0)

            rep_st = CartesianRepresentation(np.array(xs) * u.km, np.array(ys) * u.km, np.array(zs) * u.km)
            coords_st = SkyCoord(TEME(rep_st, obstime=st)).icrs
            all_icrs_coords.append(coords_st)

        transits = []
        for sat_idx, s in enumerate(candidate_sats):
            min_sep = 999.0
            best_time = None
            best_coord = None
            positions = []

            for time_idx, st in enumerate(sample_times):
                coord = all_icrs_coords[time_idx][sat_idx]
                sep = float(pointing_coord.separation(coord).deg)
                if sep < min_sep:
                    min_sep = sep
                    best_time = st.utc.isot + "Z"
                    best_coord = coord
                positions.append((float(coord.ra.deg), float(coord.dec.deg), sep))

            if min_sep <= search_radius_deg and len(positions) >= 2:
                d_ra = (positions[-1][0] - positions[0][0]) * math.cos(math.radians(pointing_dec_deg))
                d_dec = positions[-1][1] - positions[0][1]
                speed_deg_s = math.hypot(d_ra, d_dec) / duration_s

                # Convert closest position to AltAz
                altaz_closest = best_coord.transform_to(altaz_frame0)

                is_in_fov = (min_sep <= fov_radius_deg)
                transits.append({
                    "name": s["name"],
                    "norad_id": s["norad_id"],
                    "tle1": s["tle1"],
                    "tle2": s["tle2"],
                    "vmag": s["vmag"],
                    "is_in_fov": is_in_fov,
                    "min_separation_deg": round(min_sep, 2),
                    "transit_time_iso": best_time,
                    "speed_deg_s": round(speed_deg_s, 4),
                    "target_ra_deg": round(float(best_coord.ra.deg), 4),
                    "target_dec_deg": round(float(best_coord.dec.deg), 4),
                    "target_az_deg": round(float(altaz_closest.az.deg), 2),
                    "target_alt_deg": round(float(altaz_closest.alt.deg), 2),
                    "start_ra_dec": (round(positions[0][0], 2), round(positions[0][1], 2)),
                    "end_ra_dec": (round(positions[-1][0], 2), round(positions[-1][1], 2))
                })

        # Sort so that satellites inside FOV appear first, then closest passes
        transits.sort(key=lambda x: (not x["is_in_fov"], x["min_separation_deg"]))
        return transits

    @classmethod
    def find_nearest_satellite(
        cls,
        site: ObservationSite,
        obstime_iso: str,
        pointing_ra_deg: Optional[float] = None,
        pointing_dec_deg: Optional[float] = None,
        group: str = "visual"
    ) -> Optional[Dict[str, Any]]:
        """Find the satellite closest to the telescope pointing or highest in the sky."""
        sats = cls.get_sky_positions(site, obstime_iso, group=group, min_alt_deg=5.0)
        if not sats:
            return None
        if pointing_ra_deg is not None and pointing_dec_deg is not None:
            pointing_coord = SkyCoord(ra=pointing_ra_deg * u.deg, dec=pointing_dec_deg * u.deg, frame="icrs")
            sats_with_sep = []
            for s in sats:
                coord = SkyCoord(ra=s["ra_deg"] * u.deg, dec=s["dec_deg"] * u.deg, frame="icrs")
                sep = float(pointing_coord.separation(coord).deg)
                s_copy = dict(s)
                s_copy["separation_deg"] = round(sep, 2)
                sats_with_sep.append(s_copy)
            sats_with_sep.sort(key=lambda x: x["separation_deg"])
            return sats_with_sep[0]
        else:
            sats.sort(key=lambda x: x["alt_deg"], reverse=True)
            return sats[0]


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
