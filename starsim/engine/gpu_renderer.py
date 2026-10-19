"""High-performance GPU-accelerated and NumPy optical rendering engine.
Simulates seeing PSF convolution via 2D FFT, sub-pixel satellite streaks,
and full sensor noise pipeline (Poisson shot, dark current, Gaussian read noise, PRNU, ADC clipping).
"""

from __future__ import annotations
import math
import time
from typing import List, Dict, Any, Tuple
import numpy as np
from scipy.signal import fftconvolve

try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

from astropy.time import Time
from .base import BaseSimulationEngine, SimulationResult
from ..config import StarSimConfig
from ..stars import StarCatalog, project_gnomonic_tan, calculate_star_electrons
from ..orbit import SmartTransitGenerator, SGP4Propagator, OrbitMode
from ..pointing import TrackingMode


class GPURendererEngine(BaseSimulationEngine):
    """GPU / Multi-core optical and sensor simulation engine."""

    def __init__(self):
        self.catalog = StarCatalog()

    def _detect_device(self, config: StarSimConfig) -> Tuple[str, bool]:
        """Detect whether CUDA GPU acceleration is available."""
        if config.use_gpu and HAS_TORCH and torch.cuda.is_available():
            dev_name = torch.cuda.get_device_name(config.device_id)
            return (f"CUDA ({dev_name})", True)
        return ("Multi-threaded CPU", False)

    def _generate_psf_kernel(self, fwhm_px: float, kernel_size: int = 21) -> np.ndarray:
        """Generate normalized 2D Moffat / Gaussian seeing PSF kernel."""
        if kernel_size % 2 == 0:
            kernel_size += 1
        half = kernel_size // 2
        y, x = np.ogrid[-half:half + 1, -half:half + 1]
        r2 = x * x + y * y

        # Moffat PSF with beta = 4.765 (standard astronomical atmospheric turbulence)
        sigma = max(0.5, fwhm_px / 2.35482)
        alpha = sigma * 2.0
        beta = 4.765
        kernel = (1.0 + r2 / (alpha ** 2)) ** (-beta)

        kernel_sum = np.sum(kernel)
        if kernel_sum > 0:
            kernel /= kernel_sum
        return kernel.astype(np.float32)

    def _render_streak_line(
        self,
        canvas: np.ndarray,
        x0: float, y0: float,
        x1: float, y1: float,
        total_electrons: float,
        fwhm_px: float
    ) -> None:
        """Render a moving object streak with sub-pixel line integral."""
        h, w = canvas.shape
        dx = x1 - x0
        dy = y1 - y0
        length_px = math.hypot(dx, dy)

        if length_px < 0.5:
            # Quasi-stationary point source
            ix, iy = int(round(x0)), int(round(y0))
            if 0 <= ix < w and 0 <= iy < h:
                canvas[iy, ix] += total_electrons
            return

        # Number of integration steps: 3 samples per pixel length
        n_steps = max(10, int(length_px * 3.0))
        flux_per_step = total_electrons / n_steps

        t_steps = np.linspace(0.0, 1.0, n_steps)
        xs = x0 + dx * t_steps
        ys = y0 + dy * t_steps

        # Accumulate onto sub-pixel grid with bilinear interpolation
        for x, y in zip(xs, ys):
            x_int = int(math.floor(x))
            y_int = int(math.floor(y))
            fx = x - x_int
            fy = y - y_int

            if 0 <= x_int < w - 1 and 0 <= y_int < h - 1:
                canvas[y_int, x_int] += flux_per_step * (1.0 - fx) * (1.0 - fy)
                canvas[y_int, x_int + 1] += flux_per_step * fx * (1.0 - fy)
                canvas[y_int + 1, x_int] += flux_per_step * (1.0 - fx) * fy
                canvas[y_int + 1, x_int + 1] += flux_per_step * fx * fy

    def _apply_psf_convolution(self, flux_grid: np.ndarray, psf_kernel: np.ndarray, use_cuda: bool, device_id: int) -> np.ndarray:
        """Perform 2D PSF blur convolution either on GPU via PyTorch or on CPU via FFT."""
        if use_cuda and HAS_TORCH:
            try:
                device = torch.device(f"cuda:{device_id}")
                t_flux = torch.from_numpy(flux_grid).unsqueeze(0).unsqueeze(0).to(device)
                t_psf = torch.from_numpy(psf_kernel).unsqueeze(0).unsqueeze(0).to(device)
                # Pad reflection or zero
                pad = psf_kernel.shape[0] // 2
                padded = torch.nn.functional.pad(t_flux, (pad, pad, pad, pad), mode='reflect')
                out = torch.nn.functional.conv2d(padded, t_psf)
                return out.squeeze(0).squeeze(0).cpu().numpy()
            except Exception:
                pass  # Fallback to CPU fftconvolve

        return fftconvolve(flux_grid, psf_kernel, mode='same').astype(np.float32)

    def _apply_sensor_noise_pipeline(
        self,
        flux_electrons: np.ndarray,
        config: StarSimConfig,
        sky_electrons_per_px: float,
        use_cuda: bool,
        device_id: int
    ) -> np.ndarray:
        """Apply comprehensive physical detector noise model:
        1. Poisson photon shot noise (stars + RSO + sky background)
        2. Dark current thermal noise (temperature dependent Poisson)
        3. Read noise (electronic Gaussian)
        4. PRNU (Photo-Response Non-Uniformity)
        5. Gain & ADC Quantization
        6. Full-well & bit-depth clipping
        """
        sensor = config.sensor
        h, w = flux_electrons.shape
        t_exp = config.exposure_time_s

        # 1. Total photon electrons expected before detection:
        expected_photons = flux_electrons + sky_electrons_per_px

        # 2. PRNU spatial sensitivity variation
        prnu_std = sensor.noise.prnu_percent / 100.0
        prnu_map = 1.0 + np.random.normal(0.0, prnu_std, size=(h, w)).astype(np.float32)

        # 3. Dark current electrons
        # Doubling every ~6 degrees C:
        temp_factor = 2.0 ** ((sensor.noise.operating_temp_c - (-10.0)) / 6.0)
        dark_rate = sensor.noise.dark_current_eps * temp_factor
        expected_dark = dark_rate * t_exp

        if use_cuda and HAS_TORCH:
            try:
                device = torch.device(f"cuda:{device_id}")
                # Convert to torch tensor
                t_total = torch.from_numpy(expected_photons * prnu_map + expected_dark).clamp(min=0.0).to(device)
                # Poisson shot + dark noise:
                t_shot = torch.poisson(t_total)
                # Gaussian read noise:
                t_read = torch.randn_like(t_shot) * sensor.noise.read_noise_e
                # Total collected electrons:
                t_elec = t_shot + t_read
                # Full well saturation clipping:
                t_elec = torch.clamp(t_elec, 0.0, sensor.detector.full_well_capacity_e)
                # Gain conversion (e- to ADU) and DC bias:
                t_adu = (t_elec / sensor.noise.gain_e_per_adu) + sensor.noise.bias_adu
                # ADC clipping:
                max_adu = float(sensor.max_adu)
                t_adu = torch.clamp(torch.round(t_adu), 0.0, max_adu)
                adu_array = t_adu.cpu().numpy()
            except Exception:
                use_cuda = False

        if not use_cuda:
            total_expected = np.maximum(0.0, expected_photons * prnu_map + expected_dark)
            shot_electrons = np.random.poisson(total_expected).astype(np.float32)
            read_noise = np.random.normal(0.0, sensor.noise.read_noise_e, size=(h, w)).astype(np.float32)
            total_elec = np.clip(shot_electrons + read_noise, 0.0, sensor.detector.full_well_capacity_e)
            adu_array = np.clip(np.round(total_elec / sensor.noise.gain_e_per_adu + sensor.noise.bias_adu), 0.0, float(sensor.max_adu))

        # 4. Hot pixel defects
        if sensor.noise.hot_pixel_rate > 0:
            n_hot = int(h * w * sensor.noise.hot_pixel_rate)
            if n_hot > 0:
                hot_ys = np.random.randint(0, h, n_hot)
                hot_xs = np.random.randint(0, w, n_hot)
                adu_array[hot_ys, hot_xs] = sensor.max_adu

        if sensor.detector.bit_depth <= 16:
            return adu_array.astype(np.uint16)
        return adu_array.astype(np.uint32)

    def run(self, config: StarSimConfig) -> SimulationResult:
        """Run the full optical and sensor simulation sequence."""
        t_start_wall = time.time()
        dev_info, use_cuda = self._detect_device(config)

        sensor = config.sensor
        site = config.site
        pointing = config.pointing
        atmosphere = config.atmosphere

        w_px = sensor.detector.width_px
        h_px = sensor.detector.height_px
        pixel_scale = sensor.pixel_scale_arcsec
        t_exp = config.exposure_time_s
        interval = config.frame_interval_s
        n_frames = config.num_frames

        # Effective seeing FWHM & PSF kernel
        zenith_deg = pointing.get_zenith_angle_deg(site, config.start_time_iso)
        eff_seeing_fwhm_arcsec = atmosphere.get_effective_seeing_fwhm(zenith_deg)
        seeing_fwhm_px = max(1.0, eff_seeing_fwhm_arcsec / pixel_scale)
        psf_kernel = self._generate_psf_kernel(seeing_fwhm_px, kernel_size=21)

        # Atmospheric transmission
        atm_trans = atmosphere.get_atmospheric_transmission(zenith_deg)

        # Sky background electrons per pixel
        sky_electrons = atmosphere.calculate_sky_background_electrons(
            pixel_scale_arcsec=pixel_scale,
            aperture_m=sensor.optical.aperture_m,
            bandwidth_nm=sensor.optical.bandwidth_nm,
            quantum_efficiency=sensor.detector.quantum_efficiency,
            exposure_s=t_exp
        )

        frames: List[np.ndarray] = []
        raw_flux_frames: List[np.ndarray] = []
        projected_stars_all: List[Dict[str, Any]] = []
        projected_targets_all: List[Dict[str, Any]] = []

        from astropy.time import TimeDelta
        base_time = Time(config.start_time_iso)

        for frame_idx in range(n_frames):
            frame_t0 = base_time + TimeDelta(frame_idx * interval, format="sec")
            frame_t1 = frame_t0 + TimeDelta(t_exp, format="sec")
            frame_t0_iso = frame_t0.utc.isot + "Z"
            frame_t1_iso = frame_t1.utc.isot + "Z"

            # 1. Pointing for this frame
            ra_center, dec_center = pointing.get_equatorial(site, frame_t0_iso)

            # Initialize pre-blur flux canvas
            point_flux_canvas = np.zeros((h_px, w_px), dtype=np.float32)
            star_streak_canvas = np.zeros((h_px, w_px), dtype=np.float32)

            # 2. Query star catalog and project stars
            radius_search_deg = max(sensor.fov_deg) * 0.8
            stars = self.catalog.query_cone(ra_center, dec_center, radius_search_deg, limiting_mag=14.0)

            # Diurnal drift rate for STARE mode (15.041067 arcsec/s)
            is_stare = (pointing.tracking_mode == TrackingMode.STARE)
            diurnal_rate_arcsec_s = 15.041067

            for star in stars:
                px, py = project_gnomonic_tan(
                    star["ra_deg"], star["dec_deg"],
                    ra_center, dec_center,
                    pointing.roll_deg,
                    pixel_scale,
                    w_px / 2.0, h_px / 2.0
                )
                if -50 <= px < w_px + 50 and -50 <= py < h_px + 50:
                    star_elec = calculate_star_electrons(
                        vmag=star["vmag"],
                        aperture_m=sensor.optical.aperture_m,
                        bandwidth_nm=sensor.optical.bandwidth_nm,
                        quantum_efficiency=sensor.detector.quantum_efficiency,
                        exposure_s=t_exp,
                        transmission=atm_trans
                    )

                    # Estimate star SNR
                    npix_star = max(4.0, math.pi * (seeing_fwhm_px ** 2))
                    bg_noise_var = (sky_electrons + sensor.noise.dark_current_eps * t_exp) * npix_star + npix_star * (sensor.noise.read_noise_e ** 2)
                    star_snr = round(star_elec / math.sqrt(max(1.0, star_elec + bg_noise_var)), 1)

                    if is_stare:
                        # Star drifts due to Earth rotation: delta_ra = diurnal_rate * t_exp
                        cos_star_dec = math.cos(math.radians(star["dec_deg"]))
                        drift_arcsec = diurnal_rate_arcsec_s * t_exp * cos_star_dec
                        roll_rad = math.radians(pointing.roll_deg)
                        # Westward drift across detector
                        dx_drift = -(drift_arcsec * math.cos(roll_rad)) / pixel_scale
                        dy_drift = (drift_arcsec * math.sin(roll_rad)) / pixel_scale
                        streak_len = math.hypot(dx_drift, dy_drift)

                        sx0, sy0 = px - dx_drift / 2.0, py - dy_drift / 2.0
                        sx1, sy1 = px + dx_drift / 2.0, py + dy_drift / 2.0
                        self._render_streak_line(star_streak_canvas, sx0, sy0, sx1, sy1, star_elec, seeing_fwhm_px)

                        star_size_px = round(streak_len, 1)
                        star_size_arcsec = round(streak_len * pixel_scale, 1)
                    else:
                        ix, iy = int(round(px)), int(round(py))
                        if 0 <= ix < w_px and 0 <= iy < h_px:
                            point_flux_canvas[iy, ix] += star_elec
                        star_size_px = round(seeing_fwhm_px * 2.0, 1)
                        star_size_arcsec = round(eff_seeing_fwhm_arcsec * 2.0, 1)

                    if 0 <= px < w_px and 0 <= py < h_px:
                        projected_stars_all.append({
                            "frame": frame_idx,
                            "name": star["name"],
                            "ra_deg": round(star["ra_deg"], 5),
                            "dec_deg": round(star["dec_deg"], 5),
                            "x_px": round(float(px), 2),
                            "y_px": round(float(py), 2),
                            "vmag": star["vmag"],
                            "size_px": star_size_px,
                            "size_arcsec": star_size_arcsec,
                            "snr": star_snr,
                            "electrons": round(star_elec, 1),
                            "is_streak": is_stare
                        })

            # 3. Apply seeing PSF convolution to stars
            if is_stare:
                blurred_flux = self._apply_psf_convolution(star_streak_canvas, psf_kernel, use_cuda, config.device_id)
            else:
                blurred_flux = self._apply_psf_convolution(point_flux_canvas, psf_kernel, use_cuda, config.device_id)

            # 4. Render RSO target streaks
            for target in config.targets:
                sat_elec = calculate_star_electrons(
                    vmag=target.visual_magnitude,
                    aperture_m=sensor.optical.aperture_m,
                    bandwidth_nm=sensor.optical.bandwidth_nm,
                    quantum_efficiency=sensor.detector.quantum_efficiency,
                    exposure_s=t_exp,
                    transmission=atm_trans
                )

                if target.mode == OrbitMode.SMART_TRANSIT:
                    traj = SmartTransitGenerator.generate_transit_trajectory(
                        target=target,
                        site=site,
                        pointing_ra_deg=ra_center,
                        pointing_dec_deg=dec_center,
                        pixel_scale_arcsec=pixel_scale,
                        width_px=w_px,
                        height_px=h_px,
                        t_start_iso=frame_t0_iso,
                        t_end_iso=frame_t1_iso,
                        n_steps=100
                    )
                    x0, y0 = traj["start_pixel"]
                    x1, y1 = traj["end_pixel"]
                elif target.mode == OrbitMode.TLE and target.tle1 and target.tle2:
                    p0 = SGP4Propagator.propagate_tle(target.tle1, target.tle2, site, frame_t0_iso)
                    p1 = SGP4Propagator.propagate_tle(target.tle1, target.tle2, site, frame_t1_iso)
                    if p0 and p1:
                        x0, y0 = project_gnomonic_tan(p0["ra_deg"], p0["dec_deg"], ra_center, dec_center, pointing.roll_deg, pixel_scale, w_px / 2.0, h_px / 2.0)
                        x1, y1 = project_gnomonic_tan(p1["ra_deg"], p1["dec_deg"], ra_center, dec_center, pointing.roll_deg, pixel_scale, w_px / 2.0, h_px / 2.0)
                    else:
                        x0, y0, x1, y1 = -999, -999, -999, -999
                else:
                    x0, y0, x1, y1 = w_px * 0.2, h_px * 0.2, w_px * 0.8, h_px * 0.8

                streak_len = math.hypot(x1 - x0, y1 - y0)
                cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0

                # Target SNR estimation
                npix_rso = max(10.0, streak_len * seeing_fwhm_px)
                bg_noise_rso = (sky_electrons + sensor.noise.dark_current_eps * t_exp) * npix_rso + npix_rso * (sensor.noise.read_noise_e ** 2)
                rso_snr = round(sat_elec / math.sqrt(max(1.0, sat_elec + bg_noise_rso)), 1)

                if pointing.tracking_mode == TrackingMode.RATE_TRACK:
                    # Satellite is tracked (stationary point source)
                    ix, iy = int(round(w_px / 2.0)), int(round(h_px / 2.0))
                    if 0 <= ix < w_px and 0 <= iy < h_px:
                        blurred_flux[iy, ix] += sat_elec
                    rso_size_px = round(seeing_fwhm_px * 2.0, 1)
                else:
                    # Sidereal or Stare mode: Satellite streaks across sensor
                    streak_canvas = np.zeros_like(blurred_flux)
                    self._render_streak_line(streak_canvas, x0, y0, x1, y1, sat_elec, seeing_fwhm_px)
                    blurred_streak = self._apply_psf_convolution(streak_canvas, psf_kernel, use_cuda, config.device_id)
                    blurred_flux += blurred_streak
                    rso_size_px = round(streak_len, 1)

                # Bounding box
                pad = max(10.0, seeing_fwhm_px * 3.0)
                bbox = [
                    round(max(0.0, min(x0, x1) - pad), 1),
                    round(max(0.0, min(y0, y1) - pad), 1),
                    round(min(float(w_px), max(x0, x1) + pad), 1),
                    round(min(float(h_px), max(y0, y1) + pad), 1)
                ]

                projected_targets_all.append({
                    "frame": frame_idx,
                    "target_name": target.name,
                    "start_pixel": (round(float(x0), 2), round(float(y0), 2)),
                    "end_pixel": (round(float(x1), 2), round(float(y1), 2)),
                    "center_pixel": (round(float(cx), 2), round(float(cy), 2)),
                    "streak_length_px": round(streak_len, 1),
                    "streak_width_px": round(seeing_fwhm_px, 1),
                    "size_px": rso_size_px,
                    "bbox": bbox,
                    "vmag": target.visual_magnitude,
                    "total_electrons": round(sat_elec, 1),
                    "snr": rso_snr
                })

            raw_flux_frames.append(blurred_flux.copy())

            # 5. Apply sensor noise pipeline
            noisy_adu_frame = self._apply_sensor_noise_pipeline(
                flux_electrons=blurred_flux,
                config=config,
                sky_electrons_per_px=sky_electrons,
                use_cuda=use_cuda,
                device_id=config.device_id
            )
            frames.append(noisy_adu_frame)

        wall_duration = time.time() - t_start_wall

        return SimulationResult(
            frames=frames,
            raw_flux_frames=raw_flux_frames,
            stars_projected=projected_stars_all,
            targets_projected=projected_targets_all,
            config=config,
            execution_time_s=round(wall_duration, 3),
            device_info=dev_info
        )
