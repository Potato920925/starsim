/**
 * StarSim Web Dashboard Frontend Controller
 */

document.addEventListener("DOMContentLoaded", () => {
    let currentSensors = [];
    let currentSensorProfile = null;
    let sitesDatabase = {};
    let simulationResult = null;
    let currentFrameIndex = 0;
    let isPlaying = false;
    let playInterval = null;

    // DOM Elements
    const sitePresetSelect = document.getElementById("site-preset");
    const siteLatInput = document.getElementById("site-lat");
    const siteLonInput = document.getElementById("site-lon");
    const siteAltInput = document.getElementById("site-alt");

    const coordRadios = document.querySelectorAll("input[name='coord-frame']");
    const radecInputs = document.getElementById("radec-inputs");
    const altazInputs = document.getElementById("altaz-inputs");

    const cloudSlider = document.getElementById("cloud-cover");
    const cloudVal = document.getElementById("cloud-cover-val");

    const sensorSelect = document.getElementById("sensor-select");
    const btnUploadSensor = document.getElementById("btn-upload-sensor");
    const sensorFileInput = document.getElementById("sensor-file-input");
    const btnExportSensor = document.getElementById("btn-export-sensor");
    const pixelScaleDisplay = document.getElementById("pixel-scale-display");

    const orbitModeSelect = document.getElementById("orbit-mode");
    const smartOrbitFields = document.getElementById("smart-orbit-fields");
    const presetTleFields = document.getElementById("preset-tle-fields");
    const customTleFields = document.getElementById("custom-tle-fields");

    const btnRunSim = document.getElementById("btn-run-simulation");
    const loadingOverlay = document.getElementById("loading-spinner");
    const placeholderView = document.getElementById("placeholder-view");
    const simImage = document.getElementById("sim-image");
    const overlayCanvas = document.getElementById("overlay-canvas");
    const toggleAnnotations = document.getElementById("toggle-annotations");

    // Status bar
    const statusText = document.getElementById("status-text");
    const statusTime = document.getElementById("status-time");
    const statusDevice = document.getElementById("status-device");
    const statusStars = document.getElementById("status-stars");
    const deviceBadge = document.getElementById("device-badge");

    // Player
    const btnPrevFrame = document.getElementById("btn-prev-frame");
    const btnPlayPause = document.getElementById("btn-play-pause");
    const btnNextFrame = document.getElementById("btn-next-frame");
    const frameSlider = document.getElementById("frame-slider");
    const frameIndicator = document.getElementById("frame-indicator");

    // Export buttons
    const btnDownloadFits = document.getElementById("btn-download-fits");
    const btnDownloadPng = document.getElementById("btn-download-png");
    const btnDownloadAll = document.getElementById("btn-download-all");

    // 1. Load Presets
    fetch("/api/sites")
        .then(r => r.json())
        .then(data => {
            sitesDatabase = data;
        })
        .catch(console.error);

    sitePresetSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        if (sitesDatabase[val]) {
            const s = sitesDatabase[val];
            siteLatInput.value = s.lat_deg.toFixed(4);
            siteLonInput.value = s.lon_deg.toFixed(4);
            siteAltInput.value = Math.round(s.alt_m);
        }
    });

    // 2. Coordinate System Switch
    coordRadios.forEach(radio => {
        radio.addEventListener("change", (e) => {
            if (e.target.value === "radec") {
                radecInputs.style.display = "flex";
                altazInputs.style.display = "none";
            } else {
                radecInputs.style.display = "none";
                altazInputs.style.display = "flex";
            }
        });
    });

    // 3. Cloud Cover Slider
    cloudSlider.addEventListener("input", (e) => {
        cloudVal.textContent = `${e.target.value}%`;
    });

    // 4. Sensor Profiles Manager
    function updateSensorUI(profile) {
        currentSensorProfile = profile;
        document.getElementById("sensor-aperture").value = profile.optical.aperture_m;
        document.getElementById("sensor-focal-len").value = profile.optical.focal_length_m;
        document.getElementById("sensor-width").value = profile.detector.width_px;
        document.getElementById("sensor-height").value = profile.detector.height_px;
        document.getElementById("sensor-pix-size").value = profile.detector.pixel_size_um;
        document.getElementById("sensor-qe").value = profile.detector.quantum_efficiency;
        document.getElementById("sensor-read-noise").value = profile.noise.read_noise_e;
        document.getElementById("sensor-dark-curr").value = profile.noise.dark_current_eps;
        document.getElementById("sensor-gain").value = profile.noise.gain_e_per_adu;
        document.getElementById("sensor-bias").value = profile.noise.bias_adu;

        // Calculate pixel scale: 206265 * (pix_size_um * 1e-6) / focal_m
        const pixScale = 206265.0 * (profile.detector.pixel_size_um * 1e-6) / profile.optical.focal_length_m;
        pixelScaleDisplay.textContent = `角解析力: ${pixScale.toFixed(2)} arcsec/px`;
    }

    function fetchSensors(selectId = null) {
        fetch("/api/sensors")
            .then(r => r.json())
            .then(sensors => {
                currentSensors = sensors;
                sensorSelect.innerHTML = "";
                sensors.forEach(s => {
                    const opt = document.createElement("option");
                    opt.value = s.sensor_id;
                    opt.textContent = `${s.name} (${s.pixel_scale})`;
                    sensorSelect.appendChild(opt);
                });
                const targetId = selectId || (sensors[0] ? sensors[0].sensor_id : null);
                if (targetId) {
                    sensorSelect.value = targetId;
                    loadSensorDetails(targetId);
                }
            })
            .catch(console.error);
    }

    function loadSensorDetails(sensorId) {
        fetch(`/api/sensor/${sensorId}`)
            .then(r => r.json())
            .then(profile => {
                updateSensorUI(profile);
            })
            .catch(console.error);
    }

    sensorSelect.addEventListener("change", (e) => {
        loadSensorDetails(e.target.value);
    });

    btnUploadSensor.addEventListener("click", () => {
        sensorFileInput.click();
    });

    sensorFileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append("file", file);

        fetch("/api/sensor/upload", {
            method: "POST",
            body: formData
        })
        .then(r => r.json())
        .then(res => {
            if (res.error) {
                alert(`匯入感測器失敗: ${res.error}`);
            } else {
                alert(res.message);
                fetchSensors(res.profile.sensor_id);
            }
        })
        .catch(err => alert(`匯入異常: ${err}`));
    });

    btnExportSensor.addEventListener("click", () => {
        if (!currentSensorProfile) return;
        const profileToSave = buildCurrentSensorProfile();
        const blob = new Blob([JSON.stringify(profileToSave, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${profileToSave.sensor_id}_custom.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    function buildCurrentSensorProfile() {
        const base = currentSensorProfile || { sensor_id: "custom", name: "Custom Sensor", manufacturer: "Custom" };
        return {
            sensor_id: base.sensor_id,
            name: base.name,
            manufacturer: base.manufacturer,
            description: base.description || "",
            optical: {
                aperture_m: parseFloat(document.getElementById("sensor-aperture").value) || 0.5,
                focal_length_m: parseFloat(document.getElementById("sensor-focal-len").value) || 2.0,
                filter_band: base.optical ? base.optical.filter_band : "V",
                central_wavelength_nm: 550.0,
                bandwidth_nm: 100.0
            },
            detector: {
                width_px: parseInt(document.getElementById("sensor-width").value) || 1024,
                height_px: parseInt(document.getElementById("sensor-height").value) || 1024,
                pixel_size_um: parseFloat(document.getElementById("sensor-pix-size").value) || 3.76,
                bit_depth: 16,
                full_well_capacity_e: 50000.0,
                quantum_efficiency: parseFloat(document.getElementById("sensor-qe").value) || 0.8
            },
            noise: {
                read_noise_e: parseFloat(document.getElementById("sensor-read-noise").value) || 2.0,
                dark_current_eps: parseFloat(document.getElementById("sensor-dark-curr").value) || 0.005,
                operating_temp_c: -10.0,
                gain_e_per_adu: parseFloat(document.getElementById("sensor-gain").value) || 1.0,
                bias_adu: parseFloat(document.getElementById("sensor-bias").value) || 100.0,
                prnu_percent: 0.5,
                hot_pixel_rate: 0.0001
            }
        };
    }

    // 5. Orbit Mode Switch
    orbitModeSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        smartOrbitFields.style.display = val === "smart_transit" ? "block" : "none";
        presetTleFields.style.display = val === "preset_tle" ? "block" : "none";
        customTleFields.style.display = val === "custom_tle" ? "block" : "none";
    });

    // 6. Assemble Full Configuration
    function buildFullConfig() {
        const coordFrame = document.querySelector("input[name='coord-frame']:checked").value;
        const orbitMode = orbitModeSelect.value;
        const simEngine = document.querySelector("input[name='sim-engine']:checked").value;
        const useGpu = document.getElementById("use-gpu-check").checked;

        // Targets list
        let targets = [];
        const vmag = parseFloat(document.getElementById("target-vmag").value) || 8.0;

        if (orbitMode === "smart_transit") {
            targets.push({
                name: "Smart_Transit_RSO",
                mode: "smart_transit",
                transit_altitude_km: parseFloat(document.getElementById("target-alt-km").value) || 500.0,
                transit_angle_deg: parseFloat(document.getElementById("target-angle").value) || 45.0,
                visual_magnitude: vmag
            });
        } else if (orbitMode === "preset_tle") {
            const presetKey = document.getElementById("tle-preset-select").value;
            targets.push({
                name: presetKey.toUpperCase(),
                mode: "tle",
                // Server will resolve from POPULAR_TLES
                visual_magnitude: vmag
            });
        } else {
            targets.push({
                name: "Custom_TLE_Satellite",
                mode: "tle",
                tle1: document.getElementById("custom-tle1").value,
                tle2: document.getElementById("custom-tle2").value,
                visual_magnitude: vmag
            });
        }

        const expTime = parseFloat(document.getElementById("exposure-time").value) || 2.0;
        const frames = parseInt(document.getElementById("frame-count").value) || 1;
        const interval = expTime + 0.5;
        const totalDuration = interval * frames;

        const startTimeStr = document.getElementById("start-time").value;
        const t0 = new Date(startTimeStr);
        const t1 = new Date(t0.getTime() + totalDuration * 1000);

        return {
            site: {
                name: sitePresetSelect.options[sitePresetSelect.selectedIndex].text,
                lat_deg: parseFloat(siteLatInput.value),
                lon_deg: parseFloat(siteLonInput.value),
                alt_m: parseFloat(siteAltInput.value)
            },
            pointing: {
                coord_frame: coordFrame,
                ra_deg: parseFloat(document.getElementById("point-ra").value),
                dec_deg: parseFloat(document.getElementById("point-dec").value),
                az_deg: parseFloat(document.getElementById("point-az").value),
                alt_deg: parseFloat(document.getElementById("point-alt").value),
                roll_deg: parseFloat(document.getElementById("point-roll").value),
                tracking_mode: document.getElementById("tracking-mode").value
            },
            atmosphere: {
                seeing_fwhm_arcsec: parseFloat(document.getElementById("seeing-fwhm").value),
                extinction_kv: parseFloat(document.getElementById("extinction-kv").value),
                cloud_cover_percent: parseFloat(cloudSlider.value),
                bortle_class: parseInt(document.getElementById("bortle-class").value),
                moon_illumination: 0.0
            },
            sensor: buildCurrentSensorProfile(),
            targets: targets,
            start_time_iso: t0.toISOString(),
            end_time_iso: t1.toISOString(),
            exposure_time_s: expTime,
            readout_time_s: 0.5,
            engine: simEngine,
            use_gpu: useGpu,
            device_id: 0
        };
    }

    // 7. Execute Simulation
    btnRunSim.addEventListener("click", () => {
        const config = buildFullConfig();

        statusText.textContent = "運算模擬中 (Computing)...";
        statusText.style.color = "var(--warning)";
        loadingOverlay.style.display = "flex";
        btnRunSim.disabled = true;

        fetch("/api/simulate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config)
        })
        .then(r => r.json())
        .then(res => {
            loadingOverlay.style.display = "none";
            btnRunSim.disabled = false;

            if (res.error) {
                statusText.textContent = "失敗 (Error)";
                statusText.style.color = "var(--danger)";
                alert(`模擬失敗: ${res.error}`);
                return;
            }

            simulationResult = res;
            currentFrameIndex = 0;

            statusText.textContent = "完成 (Completed)";
            statusText.style.color = "var(--success)";
            statusTime.textContent = `${res.execution_time_s} s`;
            statusDevice.textContent = res.device_info;
            statusStars.textContent = `${res.stars_count} 顆`;
            deviceBadge.textContent = res.device_info;

            placeholderView.style.display = "none";
            simImage.style.display = "block";

            // Setup Frame Slider
            frameSlider.min = 1;
            frameSlider.max = res.num_frames;
            frameSlider.value = 1;

            updateFrameView(0);

            // Enable download buttons
            btnDownloadAll.classList.remove("disabled");
        })
        .catch(err => {
            loadingOverlay.style.display = "none";
            btnRunSim.disabled = false;
            statusText.textContent = "連線異常";
            statusText.style.color = "var(--danger)";
            alert(`網路連線異常: ${err}`);
        });
    });

    // 8. Viewport and Frame Display
    function updateFrameView(idx) {
        if (!simulationResult || !simulationResult.png_urls || !simulationResult.png_urls[idx]) return;
        currentFrameIndex = idx;
        simImage.src = simulationResult.png_urls[idx];
        frameIndicator.textContent = `第 ${idx + 1} / ${simulationResult.num_frames} 幀`;
        frameSlider.value = idx + 1;

        // Update single-frame downloads
        btnDownloadFits.href = simulationResult.fits_urls[idx];
        btnDownloadFits.classList.remove("disabled");
        btnDownloadPng.href = simulationResult.png_urls[idx];
        btnDownloadPng.classList.remove("disabled");

        simImage.onload = () => {
            drawAnnotations();
        };
    }

    function drawAnnotations() {
        if (!simulationResult || !toggleAnnotations.checked) {
            clearCanvas();
            return;
        }

        const rect = simImage.getBoundingClientRect();
        overlayCanvas.width = rect.width;
        overlayCanvas.height = rect.height;

        const ctx = overlayCanvas.getContext("2d");
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

        const imgW = simulationResult.config.sensor.detector.width_px;
        const imgH = simulationResult.config.sensor.detector.height_px;
        const scaleX = rect.width / imgW;
        const scaleY = rect.height / imgH;

        // Draw RSO Streak
        if (simulationResult.targets) {
            simulationResult.targets.forEach(tgt => {
                if (tgt.frame === currentFrameIndex) {
                    const x0 = tgt.start_pixel[0] * scaleX;
                    const y0 = (imgH - tgt.start_pixel[1]) * scaleY;
                    const x1 = tgt.end_pixel[0] * scaleX;
                    const y1 = (imgH - tgt.end_pixel[1]) * scaleY;

                    // Draw bounding box
                    ctx.strokeStyle = "#38bdf8";
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(x0, y0, 6, 0, 2 * Math.PI);
                    ctx.stroke();

                    ctx.strokeStyle = "#ef4444";
                    ctx.beginPath();
                    ctx.moveTo(x0, y0);
                    ctx.lineTo(x1, y1);
                    ctx.stroke();

                    // Label
                    ctx.fillStyle = "#38bdf8";
                    ctx.font = "11px Inter, sans-serif";
                    ctx.fillText(`🛰️ ${tgt.target_name} (V=${tgt.vmag})`, Math.min(x0, x1) + 8, Math.min(y0, y1) - 4);
                }
            });
        }
    }

    function clearCanvas() {
        const ctx = overlayCanvas.getContext("2d");
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }

    toggleAnnotations.addEventListener("change", () => {
        drawAnnotations();
    });

    window.addEventListener("resize", () => {
        drawAnnotations();
    });

    // 9. Frame Playback Controls
    frameSlider.addEventListener("input", (e) => {
        updateFrameView(parseInt(e.target.value) - 1);
    });

    btnPrevFrame.addEventListener("click", () => {
        if (!simulationResult) return;
        const next = (currentFrameIndex - 1 + simulationResult.num_frames) % simulationResult.num_frames;
        updateFrameView(next);
    });

    btnNextFrame.addEventListener("click", () => {
        if (!simulationResult) return;
        const next = (currentFrameIndex + 1) % simulationResult.num_frames;
        updateFrameView(next);
    });

    btnPlayPause.addEventListener("click", () => {
        if (!simulationResult) return;
        if (isPlaying) {
            clearInterval(playInterval);
            isPlaying = false;
            btnPlayPause.textContent = "▶️";
        } else {
            isPlaying = true;
            btnPlayPause.textContent = "⏸️";
            playInterval = setInterval(() => {
                const next = (currentFrameIndex + 1) % simulationResult.num_frames;
                updateFrameView(next);
            }, 600);
        }
    });

    // 10. Contrast Stretch Mode Buttons
    const stretchButtons = document.querySelectorAll(".btn-stretch");
    stretchButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
            stretchButtons.forEach(b => b.classList.remove("active"));
            e.target.classList.add("active");
            // If we have an active simulation, we can re-render or note
        });
    });

    // 11. Download All
    btnDownloadAll.addEventListener("click", () => {
        window.location.href = "/api/download/all";
    });

    // Initial load
    fetchSensors("sony_imx455");
});
