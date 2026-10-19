"""Observation site and observatory location manager.
Integrates with Astropy EarthLocation for precise topocentric coordinate calculations.
"""

from __future__ import annotations
import json
import os
from dataclasses import dataclass, asdict
from typing import Dict, Any, Optional
import astropy.units as u
from astropy.coordinates import EarthLocation


@dataclass
class ObservationSite:
    name: str = "Lulin Observatory (鹿林天文台)"
    lat_deg: float = 23.4694      # Latitude in decimal degrees (-90 to +90)
    lon_deg: float = 120.8726     # Longitude in decimal degrees (-180 to +180)
    alt_m: float = 2862.0         # Elevation above sea level in meters

    def __post_init__(self):
        self.validate()

    def validate(self) -> None:
        if not (-90.0 <= self.lat_deg <= 90.0):
            raise ValueError(f"Latitude must be between -90 and 90, got {self.lat_deg}")
        if not (-180.0 <= self.lon_deg <= 360.0):
            raise ValueError(f"Longitude must be between -180 and 360, got {self.lon_deg}")
        if self.lon_deg > 180.0:
            self.lon_deg -= 360.0

    @property
    def earth_location(self) -> EarthLocation:
        """Return an Astropy EarthLocation object."""
        return EarthLocation(
            lat=self.lat_deg * u.deg,
            lon=self.lon_deg * u.deg,
            height=self.alt_m * u.m
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ObservationSite":
        return cls(**data)


def get_default_sites_file() -> str:
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_dir, "data", "sites", "observatories.json")


def list_preset_observatories(sites_file: Optional[str] = None) -> Dict[str, ObservationSite]:
    """Load pre-configured observatory sites from JSON database."""
    if sites_file is None:
        sites_file = get_default_sites_file()
    if not os.path.isfile(sites_file):
        return {}

    with open(sites_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    sites = {}
    for key, item in data.items():
        sites[key] = ObservationSite(
            name=item.get("name", key),
            lat_deg=float(item["lat"]),
            lon_deg=float(item["lon"]),
            alt_m=float(item.get("alt_m", 0.0))
        )
    return sites


def get_preset_site(site_key: str, sites_file: Optional[str] = None) -> ObservationSite:
    """Get a preset observatory site by key (e.g. 'lulin', 'mauna_kea', 'paranal')."""
    presets = list_preset_observatories(sites_file)
    if site_key in presets:
        return presets[site_key]
    raise KeyError(f"Observatory '{site_key}' not found in presets: {list(presets.keys())}")
