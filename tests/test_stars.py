import pytest
from starsim.stars import StarCatalog, project_gnomonic_tan, calculate_star_electrons


def test_star_catalog_query():
    cat = StarCatalog()
    # Query around Betelgeuse (RA=88.79, Dec=7.41) with 5 degree radius
    stars = cat.query_cone(88.79, 7.41, radius_deg=5.0, limiting_mag=12.0)
    assert len(stars) > 0
    # At least one star should be Betelgeuse or nearby bright stars
    names = [s["name"] for s in stars]
    assert any("Betelgeuse" in n or "STAR" in n for n in names)


def test_gnomonic_tan_projection():
    center_ra = 100.0
    center_dec = 20.0
    w_px, h_px = 1024, 1024
    cx, cy = w_px / 2.0, h_px / 2.0
    scale = 1.0  # 1 arcsec/px

    # A star exactly at the center of pointing should project to (cx, cy)
    x, y = project_gnomonic_tan(center_ra, center_dec, center_ra, center_dec, roll_deg=0.0, pixel_scale_arcsec=scale, center_x_px=cx, center_y_px=cy)
    assert abs(x - cx) < 1e-3
    assert abs(y - cy) < 1e-3


def test_stellar_flux_calculation():
    # Brighter star (V=5) should produce more electrons than fainter star (V=10)
    e_bright = calculate_star_electrons(vmag=5.0, aperture_m=0.5, bandwidth_nm=100.0, quantum_efficiency=0.8, exposure_s=2.0)
    e_faint = calculate_star_electrons(vmag=10.0, aperture_m=0.5, bandwidth_nm=100.0, quantum_efficiency=0.8, exposure_s=2.0)

    assert e_bright > 0.0
    assert e_faint > 0.0
    # 5 magnitudes difference corresponds to a factor of 100 in flux
    ratio = e_bright / e_faint
    assert abs(ratio - 100.0) < 5.0
