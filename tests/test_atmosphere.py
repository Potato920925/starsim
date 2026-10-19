import pytest
from starsim.atmosphere import AtmosphericConditions, calculate_airmass


def test_airmass_calculation():
    # At zenith (z = 0), airmass should be exactly 1.0
    assert abs(calculate_airmass(0.0) - 1.0) < 0.05
    # At 60 deg zenith, sec(60) = 2.0
    assert abs(calculate_airmass(60.0) - 2.0) < 0.05
    # Near horizon (85 deg), airmass should be finite and large (~10)
    assert 5.0 < calculate_airmass(85.0) < 15.0


def test_seeing_and_extinction():
    atm = AtmosphericConditions(seeing_fwhm_arcsec=1.5, extinction_kv=0.15, cloud_cover_percent=0.0)

    # Effective seeing at zenith
    seeing_zenith = atm.get_effective_seeing_fwhm(0.0)
    assert abs(seeing_zenith - 1.5) < 0.05

    # At 60 deg zenith, airmass is ~2.0, seeing scales with airmass^0.6
    seeing_60 = atm.get_effective_seeing_fwhm(60.0)
    assert seeing_60 > seeing_zenith

    # Transmission should decrease with airmass
    trans_0 = atm.get_atmospheric_transmission(0.0)
    trans_60 = atm.get_atmospheric_transmission(60.0)
    assert 0.0 < trans_60 < trans_0 < 1.0

    # Cloud cover attenuation
    atm_cloud = AtmosphericConditions(cloud_cover_percent=50.0)
    assert atm_cloud.get_atmospheric_transmission(0.0) < trans_0
