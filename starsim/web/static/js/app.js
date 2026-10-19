/**
 * StarSim Web Dashboard Frontend Controller
 * Supports Sky Dome Radar with telescope FOV projection, live RSO transits,
 * tracking mode switching, and detailed object annotations export.
 */

document.addEventListener("DOMContentLoaded", () => {
    let currentSensors = [];
    let currentSensorProfile = null;
    let sitesDatabase = {};
    let simulationResult = null;
    let currentFrameIndex = 0;
    let isPlaying = false;
    let playInterval = null;
    let liveSatellites = [];
    let transitingSatellites = [];

    // DOM Elements
    const sitePresetSelect = document.getElementById("site-preset");
    const siteLatInput = document.getElementById("site-lat");
    const siteLonInput = document.getElementById("site-lon");
    const siteAltInput = document.getElementById("site-alt");

    const trackingCards = document.querySelectorAll(".tracking-card");
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
    const liveSatFields = document.getElementById("live-sat-fields");
    const liveSatSelect = document.getElementById("live-sat-select");
    const presetTleFields = document.getElementById("preset-tle-fields");
    const customTleFields = document.getElementById("custom-tle-fields");
    const btnUpdateLiveTles = document.getElementById("btn-update-live-tles");

    const btnRunSim = document.getElementById("btn-run-simulation");
    const loadingOverlay = document.getElementById("loading-spinner");
    const placeholderView = document.getElementById("placeholder-view");
    const simImage = document.getElementById("sim-image");
    const overlayCanvas = document.getElementById("overlay-canvas");
    const toggleAnnotations = document.getElementById("toggle-annotations");
    const toggleBurnin = document.getElementById("toggle-burnin");

    // Status bar
    const statusText = document.getElementById("status-text");
    const statusTime = document.getElementById("status-time");
    const statusDevice = document.getElementById("status-device");
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
    const btnDownloadAnnotatedPng = document.getElementById("btn-download-annotated-png");
    const btnDownloadCsv = document.getElementById("btn-download-csv");
    const btnDownloadAll = document.getElementById("btn-download-all");

    // Tabs
    const viewTabs = document.querySelectorAll(".view-tab");
    const tabPanels = document.querySelectorAll(".tab-panel");

    // Sky Dome Radar
    const skydomeCanvas = document.getElementById("skydome-canvas");
    const transitTableBody = document.getElementById("transit-table-body");
    const tableRsoBody = document.getElementById("table-rso-body");
    const tableStarsBody = document.getElementById("table-stars-body");

    // 1. Tab Switching
    function switchToTab(tabName) {
        viewTabs.forEach(t => {
            if (t.dataset.tab === tabName) {
                t.classList.add("active");
            } else {
                t.classList.remove("active");
            }
        });
        tabPanels.forEach(p => {
            if (p.id === `tab-${tabName}-panel`) {
                p.classList.add("active");
            } else {
                p.classList.remove("active");
            }
        });
        if (tabName === "skydome") {
            drawSkyDomeRadar();
            fetchTransitingSatellites();
        }
    }

    viewTabs.forEach(tab => {
        tab.addEventListener("click", () => {
            switchToTab(tab.dataset.tab);
        });
    });

    // 2. Tracking Mode Card Selection
    trackingCards.forEach(card => {
        card.addEventListener("click", () => {
            trackingCards.forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            const radio = card.querySelector("input[type='radio']");
            if (radio) radio.checked = true;
        });
    });

    // 3. Coordinate Frame Switch
    coordRadios.forEach(radio => {
        radio.addEventListener("change", (e) => {
            if (e.target.value === "radec") {
                radecInputs.style.display = "flex";
                altazInputs.style.display = "none";
            } else {
                radecInputs.style.display = "none";
                altazInputs.style.display = "flex";
            }
            drawSkyDomeRadar();
        });
    });

    // 4. Cloud Cover Slider
    cloudSlider.addEventListener("input", (e) => {
        cloudVal.textContent = `${e.target.value}%`;
    });

    // 5. Site Presets
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
            fetchLiveSkyMap();
        }
    });

    // 6. Sensor Manager
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

        const pixScale = 206265.0 * (profile.detector.pixel_size_um * 1e-6) / profile.optical.focal_length_m;
        const fovW = (profile.detector.width_px * pixScale) / 3600.0;
        const fovH = (profile.detector.height_px * pixScale) / 3600.0;
        pixelScaleDisplay.textContent = `角解析力: ${pixScale.toFixed(2)}" / 視場: ${fovW.toFixed(2)}°x${fovH.toFixed(2)}°`;
        drawSkyDomeRadar();
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
            .then(profile => updateSensorUI(profile))
            .catch(console.error);
    }

    sensorSelect.addEventListener("change", (e) => loadSensorDetails(e.target.value));

    btnUploadSensor.addEventListener("click", () => sensorFileInput.click());

    sensorFileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append("file", file);

        fetch("/api/sensor/upload", { method: "POST", body: formData })
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

    // 7. Orbit Mode Switch
    orbitModeSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        smartOrbitFields.style.display = val === "smart_transit" ? "block" : "none";
        liveSatFields.style.display = val === "live_sat" ? "block" : "none";
        presetTleFields.style.display = val === "preset_tle" ? "block" : "none";
        customTleFields.style.display = val === "custom_tle" ? "block" : "none";

        if (val === "live_sat") {
            fetchLiveSkyMap();
        }
    });

    // 8. CelesTrak Live TLE Update
    btnUpdateLiveTles.addEventListener("click", () => {
        btnUpdateLiveTles.textContent = "⏳ 更新中...";
        fetch("/api/rso/update?group=visual", { method: "POST" })
            .then(r => r.json())
            .then(res => {
                alert(res.message);
                btnUpdateLiveTles.textContent = "🔄 實時在軌數據已更新";
                fetchLiveSkyMap();
                fetchTransitingSatellites();
            })
            .catch(err => {
                alert(`更新失敗: ${err}`);
                btnUpdateLiveTles.textContent = "🔄 實時更新在軌衛星 (CelesTrak)";
            });
    });

    function fetchLiveSkyMap() {
        const lat = siteLatInput ? siteLatInput.value : 23.4694;
        const lon = siteLonInput ? siteLonInput.value : 120.8726;
        const alt = siteAltInput ? siteAltInput.value : 2862;
        const timeInput = document.getElementById("start-time");
        const time = timeInput ? timeInput.value : "2026-10-19T20:00:00Z";

        fetch(`/api/rso/sky_map?lat=${lat}&lon=${lon}&alt=${alt}&time=${encodeURIComponent(time)}&group=visual`)
            .then(r => r.json())
            .then(data => {
                liveSatellites = data.satellites || [];
                if (liveSatSelect) {
                    liveSatSelect.innerHTML = "";
                    liveSatellites.forEach(s => {
                        const opt = document.createElement("option");
                        opt.value = s.norad_id;
                        opt.textContent = `${s.name} (Az:${s.az_deg}°, Alt:${s.alt_deg}°, V:${s.vmag})`;
                        opt.dataset.tle1 = s.tle1;
                        opt.dataset.tle2 = s.tle2;
                        opt.dataset.vmag = s.vmag;
                        opt.dataset.name = s.name;
                        liveSatSelect.appendChild(opt);
                    });
                }
                drawSkyDomeRadar();
            })
            .catch(err => {
                console.warn("fetchLiveSkyMap error:", err);
            });
    }

    function fetchTransitingSatellites() {
        const lat = siteLatInput ? siteLatInput.value : 23.4694;
        const lon = siteLonInput ? siteLonInput.value : 120.8726;
        const alt = siteAltInput ? siteAltInput.value : 2862;
        const ra = document.getElementById("point-ra") ? document.getElementById("point-ra").value : 88.79;
        const dec = document.getElementById("point-dec") ? document.getElementById("point-dec").value : 7.41;
        const t0Input = document.getElementById("start-time");
        const t0 = t0Input ? t0Input.value : "2026-10-19T20:00:00Z";
        let dateObj = new Date(t0);
        if (isNaN(dateObj.getTime())) {
            dateObj = new Date();
        }
        const expTime = parseFloat(document.getElementById("exposure-time")?.value) || 2.0;
        const frames = parseInt(document.getElementById("frame-count")?.value) || 1;
        const totalDuration = (expTime + 0.5) * frames;
        const t1 = new Date(dateObj.getTime() + totalDuration * 1000).toISOString();

        const prof = buildCurrentSensorProfile();
        const pixScale = 206265.0 * (prof.detector.pixel_size_um * 1e-6) / prof.optical.focal_length_m;
        const fovW = (prof.detector.width_px * pixScale) / 3600.0;
        const fovH = (prof.detector.height_px * pixScale) / 3600.0;

        const coordFrame = document.querySelector("input[name='coord-frame']:checked") ? document.querySelector("input[name='coord-frame']:checked").value : "radec";
        const az = document.getElementById("point-az") ? document.getElementById("point-az").value : 180;
        const altPt = document.getElementById("point-alt") ? document.getElementById("point-alt").value : 65;

        fetch(`/api/rso/transits?lat=${lat}&lon=${lon}&alt=${alt}&ra=${ra}&dec=${dec}&coord_frame=${coordFrame}&az=${az}&alt_pt=${altPt}&fov_w=${fovW}&fov_h=${fovH}&start_time=${encodeURIComponent(t0)}&end_time=${encodeURIComponent(t1)}&group=visual`)
            .then(r => r.json())
            .then(data => {
                transitingSatellites = data.transits || [];
                renderTransitTable(transitingSatellites);
                drawSkyDomeRadar();
            })
            .catch(err => {
                console.warn("fetchTransitingSatellites error:", err);
            });
    }

    function renderTransitTable(transits) {
        transitTableBody.innerHTML = "";
        if (transits.length === 0) {
            transitTableBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">此時段天區無過境衛星（可點擊上方「🎯 一鍵瞄準最近過境衛星」或直接點擊天球雷達上的衛星圖示）</td></tr>`;
            return;
        }

        transits.slice(0, 15).forEach(t => {
            const tr = document.createElement("tr");
            const statusBadge = t.is_in_fov
                ? `<span style="color:#10b981; font-weight:bold;">⚡ 視場內穿透 (0.0°)</span>`
                : `<span style="color:#f59e0b;">角距 ${t.min_separation_deg}°</span>`;

            tr.innerHTML = `
                <td><strong>${t.name}</strong></td>
                <td>${t.transit_time_iso ? t.transit_time_iso.split('T')[1].replace('Z','') : '--'}</td>
                <td>${statusBadge}</td>
                <td>V=${t.vmag}</td>
                <td>${t.speed_deg_s}°/s</td>
                <td>
                    <button type="button" class="btn btn-primary btn-sm btn-align-transit"
                        data-tle1="${t.tle1}" data-tle2="${t.tle2}" data-name="${t.name}" data-vmag="${t.vmag}"
                        data-ra="${t.target_ra_deg}" data-dec="${t.target_dec_deg}"
                        data-az="${t.target_az_deg}" data-alt="${t.target_alt_deg}">
                        ${t.is_in_fov ? '設為目標' : '🎯 視場對齊並設為目標'}
                    </button>
                </td>
            `;
            transitTableBody.appendChild(tr);
        });

        document.querySelectorAll(".btn-align-transit").forEach(btn => {
            btn.addEventListener("click", (e) => {
                const b = e.target;
                if (b.dataset.az && b.dataset.alt) {
                    document.getElementById("point-az").value = b.dataset.az;
                    document.getElementById("point-alt").value = b.dataset.alt;
                }
                if (b.dataset.ra && b.dataset.dec) {
                    document.getElementById("point-ra").value = b.dataset.ra;
                    document.getElementById("point-dec").value = b.dataset.dec;
                }

                orbitModeSelect.value = "custom_tle";
                smartOrbitFields.style.display = "none";
                liveSatFields.style.display = "none";
                presetTleFields.style.display = "none";
                customTleFields.style.display = "block";

                document.getElementById("custom-tle1").value = b.dataset.tle1;
                document.getElementById("custom-tle2").value = b.dataset.tle2;
                document.getElementById("target-vmag").value = b.dataset.vmag;

                drawSkyDomeRadar();
                fetchTransitingSatellites();
                alert(`🎯 望遠鏡已成功對準「${b.dataset.name}」過境軌道！\n現在點擊「開始光學影像模擬」即可在畫面中央觀測到該衛星！`);
            });
        });
    }

    // Auto-point to nearest overhead satellite
    const btnPointNearest = document.getElementById("btn-point-nearest-rso");
    if (btnPointNearest) {
        btnPointNearest.addEventListener("click", () => {
            btnPointNearest.textContent = "⏳ 搜尋瞄準中...";
            const lat = siteLatInput.value;
            const lon = siteLonInput.value;
            const alt = siteAltInput.value;
            const ra = document.getElementById("point-ra").value;
            const dec = document.getElementById("point-dec").value;
            const time = document.getElementById("start-time").value;

            fetch(`/api/rso/nearest?lat=${lat}&lon=${lon}&alt=${alt}&ra=${ra}&dec=${dec}&time=${encodeURIComponent(time)}&group=visual`)
                .then(r => r.json())
                .then(res => {
                    btnPointNearest.textContent = "🎯 一鍵瞄準最近過境衛星";
                    if (res.satellite) {
                        const s = res.satellite;
                        document.getElementById("point-az").value = s.az_deg;
                        document.getElementById("point-alt").value = s.alt_deg;
                        document.getElementById("point-ra").value = s.ra_deg;
                        document.getElementById("point-dec").value = s.dec_deg;

                        orbitModeSelect.value = "custom_tle";
                        smartOrbitFields.style.display = "none";
                        liveSatFields.style.display = "none";
                        presetTleFields.style.display = "none";
                        customTleFields.style.display = "block";

                        document.getElementById("custom-tle1").value = s.tle1;
                        document.getElementById("custom-tle2").value = s.tle2;
                        document.getElementById("target-vmag").value = s.vmag;

                        drawSkyDomeRadar();
                        fetchTransitingSatellites();
                        alert(`🎯 望遠鏡已自動對準頭頂上空的「${s.name}」(仰角 ${s.alt_deg}°, 方位 ${s.az_deg}°)，並設定為模擬目標！\n點擊「開始光學影像模擬」即可直接看見！`);
                    } else {
                        alert("當前時刻天空中暫無高仰角衛星，建議點選天球雷達圖自選指向或使用「智慧視場穿透生成」！");
                    }
                })
                .catch(err => {
                    btnPointNearest.textContent = "🎯 一鍵瞄準最近過境衛星";
                    alert(`瞄準失敗: ${err}`);
                });
        });
    }

    // 9. Interactive Sky Dome Radar Canvas
    function drawSkyDomeRadar() {
        if (!skydomeCanvas) return;
        const ctx = skydomeCanvas.getContext("2d");
        const w = skydomeCanvas.width;
        const h = skydomeCanvas.height;
        const cx = w / 2;
        const cy = h / 2;
        const R = w * 0.42;

        ctx.clearRect(0, 0, w, h);

        // Sky dome base circle
        ctx.fillStyle = "#030712";
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, 2 * Math.PI);
        ctx.fill();

        // Grid circles (Alt = 0, 30, 60 deg)
        ctx.strokeStyle = "#1e293b";
        ctx.lineWidth = 1;
        [0, 30, 60].forEach(alt => {
            const r = R * (90 - alt) / 90;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, 2 * Math.PI);
            ctx.stroke();

            // Label
            ctx.fillStyle = "#475569";
            ctx.font = "9px Inter, sans-serif";
            ctx.fillText(`${alt}°`, cx + 4, cy - r + 10);
        });

        // Crosshairs (N-S, E-W)
        ctx.beginPath();
        ctx.moveTo(cx, cy - R);
        ctx.lineTo(cx, cy + R);
        ctx.moveTo(cx - R, cy);
        ctx.lineTo(cx + R, cy);
        ctx.stroke();

        // Cardinal Directions
        ctx.fillStyle = "#94a3b8";
        ctx.font = "bold 12px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("N (北 0°)", cx, cy - R - 14);
        ctx.fillText("S (南 180°)", cx, cy + R + 14);
        ctx.fillText("E (東 90°)", cx + R + 24, cy);
        ctx.fillText("W (西 270°)", cx - R - 24, cy);
        ctx.fillText("Zenith (天頂 90°)", cx, cy - 8);

        // Draw Live Satellites
        liveSatellites.forEach(sat => {
            const r = R * (90 - Math.max(0, sat.alt_deg)) / 90;
            const azRad = (sat.az_deg - 90) * Math.PI / 180;
            const sx = cx + r * Math.cos(azRad);
            const sy = cy + r * Math.sin(azRad);

            // Check if this satellite is transiting
            const transitMatch = transitingSatellites.find(t => t.name === sat.name);
            const isInsideFov = transitMatch && transitMatch.is_in_fov;

            if (isInsideFov) {
                // Pulsing Green Circle for in-FOV transit
                ctx.strokeStyle = "#10b981";
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.arc(sx, sy, 8, 0, 2 * Math.PI);
                ctx.stroke();

                ctx.fillStyle = "#34d399";
                ctx.beginPath();
                ctx.arc(sx, sy, 3.5, 0, 2 * Math.PI);
                ctx.fill();

                ctx.fillStyle = "#10b981";
                ctx.font = "bold 10px Inter, sans-serif";
                ctx.fillText(`🎯 ${sat.name}`, sx + 12, sy - 2);
            } else if (transitMatch) {
                // Orange Circle for nearby pass
                ctx.strokeStyle = "#f59e0b";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(sx, sy, 5, 0, 2 * Math.PI);
                ctx.stroke();

                ctx.fillStyle = "#fbbf24";
                ctx.beginPath();
                ctx.arc(sx, sy, 2.5, 0, 2 * Math.PI);
                ctx.fill();

                ctx.fillStyle = "#fbbf24";
                ctx.font = "9px Inter, sans-serif";
                ctx.fillText(`${sat.name}`, sx + 8, sy - 2);
            } else {
                ctx.fillStyle = "#38bdf8";
                ctx.beginPath();
                ctx.arc(sx, sy, 2.5, 0, 2 * Math.PI);
                ctx.fill();
            }
        });

        // Draw Telescope Pointing & FOV Footprint
        const az = parseFloat(document.getElementById("point-az").value) || 180;
        const alt = parseFloat(document.getElementById("point-alt").value) || 60;
        const fovR = R * (90 - Math.max(0, alt)) / 90;
        const fovAzRad = (az - 90) * Math.PI / 180;
        const tx = cx + fovR * Math.cos(fovAzRad);
        const ty = cy + fovR * Math.sin(fovAzRad);

        // FOV Box / Cone representation
        const prof = buildCurrentSensorProfile();
        const pixScale = 206265.0 * (prof.detector.pixel_size_um * 1e-6) / prof.optical.focal_length_m;
        const fovDeg = (prof.detector.width_px * pixScale) / 3600.0;
        const fovPx = Math.max(14, (fovDeg / 90) * R * 1.5);

        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 2;
        ctx.strokeRect(tx - fovPx / 2, ty - fovPx / 2, fovPx, fovPx);

        // Center reticle
        ctx.fillStyle = "#ef4444";
        ctx.beginPath();
        ctx.arc(tx, ty, 3, 0, 2 * Math.PI);
        ctx.fill();

        ctx.fillStyle = "#f87171";
        ctx.font = "bold 10px Inter, sans-serif";
        ctx.fillText(`望遠鏡視場 FOV (${az.toFixed(0)}°, ${alt.toFixed(0)}°)`, tx, ty + fovPx / 2 + 10);
    }

    // Click on Sky Dome to steer telescope or select a satellite
    skydomeCanvas.addEventListener("click", (e) => {
        const rect = skydomeCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const cx = skydomeCanvas.width / 2;
        const cy = skydomeCanvas.height / 2;
        const R = skydomeCanvas.width * 0.42;

        // Check if click hit a satellite dot
        let hitSat = null;
        for (const sat of liveSatellites) {
            const r = R * (90 - Math.max(0, sat.alt_deg)) / 90;
            const azRad = (sat.az_deg - 90) * Math.PI / 180;
            const sx = cx + r * Math.cos(azRad);
            const sy = cy + r * Math.sin(azRad);
            if (Math.hypot(mx - sx, my - sy) <= 12) {
                hitSat = sat;
                break;
            }
        }

        if (hitSat) {
            document.getElementById("point-az").value = hitSat.az_deg;
            document.getElementById("point-alt").value = hitSat.alt_deg;
            document.getElementById("point-ra").value = hitSat.ra_deg;
            document.getElementById("point-dec").value = hitSat.dec_deg;

            orbitModeSelect.value = "custom_tle";
            smartOrbitFields.style.display = "none";
            liveSatFields.style.display = "none";
            presetTleFields.style.display = "none";
            customTleFields.style.display = "block";

            document.getElementById("custom-tle1").value = hitSat.tle1;
            document.getElementById("custom-tle2").value = hitSat.tle2;
            document.getElementById("target-vmag").value = hitSat.vmag;

            drawSkyDomeRadar();
            fetchTransitingSatellites();
            alert(`🎯 望遠鏡已直接鎖定衛星「${hitSat.name}」！\n(方位角: ${hitSat.az_deg}°, 仰角: ${hitSat.alt_deg}°)\n現在點擊「開始光學影像模擬」即可看見衛星！`);
            return;
        }

        const dx = mx - cx;
        const dy = my - cy;
        const dist = Math.hypot(dx, dy);

        if (dist <= R) {
            const alt = Math.max(0, 90 - (dist / R) * 90);
            let az = (Math.atan2(dy, dx) * 180 / Math.PI) + 90;
            if (az < 0) az += 360;

            document.getElementById("point-az").value = az.toFixed(1);
            document.getElementById("point-alt").value = alt.toFixed(1);

            drawSkyDomeRadar();
            fetchTransitingSatellites();
        }
    });

    // 10. Assemble Full Configuration
    function buildFullConfig() {
        const coordRadio = document.querySelector("input[name='coord-frame']:checked");
        const coordFrame = coordRadio ? coordRadio.value : "radec";

        const trackingRadio = document.querySelector("input[name='tracking-mode']:checked");
        const trackingMode = trackingRadio ? trackingRadio.value : "sidereal";

        const orbitMode = orbitModeSelect ? orbitModeSelect.value : "smart_transit";

        const simRadio = document.querySelector("input[name='sim-engine']:checked");
        const simEngine = simRadio ? simRadio.value : "gpu";

        const gpuCheck = document.getElementById("use-gpu-check");
        const useGpu = gpuCheck ? gpuCheck.checked : true;

        let targets = [];
        const vmagInput = document.getElementById("target-vmag");
        const vmag = vmagInput ? (parseFloat(vmagInput.value) || 7.5) : 7.5;

        if (orbitMode === "smart_transit") {
            const altKm = parseFloat(document.getElementById("target-alt-km")?.value) || 500.0;
            const angle = parseFloat(document.getElementById("target-angle")?.value) || 35.0;
            targets.push({
                name: "Smart_Transit_RSO",
                mode: "smart_transit",
                transit_altitude_km: altKm,
                transit_angle_deg: angle,
                visual_magnitude: vmag
            });
        } else if (orbitMode === "live_sat") {
            const opt = liveSatSelect && liveSatSelect.selectedIndex >= 0 ? liveSatSelect.options[liveSatSelect.selectedIndex] : null;
            if (opt && opt.dataset && opt.dataset.tle1) {
                targets.push({
                    name: opt.dataset.name || "Live_RSO",
                    mode: "tle",
                    tle1: opt.dataset.tle1,
                    tle2: opt.dataset.tle2,
                    visual_magnitude: parseFloat(opt.dataset.vmag) || vmag
                });
            } else {
                targets.push({
                    name: "ISS",
                    mode: "tle",
                    visual_magnitude: vmag
                });
            }
        } else if (orbitMode === "preset_tle") {
            const presetSelect = document.getElementById("tle-preset-select");
            const presetKey = presetSelect ? presetSelect.value : "iss";
            targets.push({
                name: presetKey.toUpperCase(),
                mode: "tle",
                visual_magnitude: vmag
            });
        } else {
            const tle1Input = document.getElementById("custom-tle1");
            const tle2Input = document.getElementById("custom-tle2");
            targets.push({
                name: "Custom_TLE_Satellite",
                mode: "tle",
                tle1: tle1Input ? tle1Input.value.trim() : "",
                tle2: tle2Input ? tle2Input.value.trim() : "",
                visual_magnitude: vmag
            });
        }

        const expTime = parseFloat(document.getElementById("exposure-time")?.value) || 2.0;
        const frames = parseInt(document.getElementById("frame-count")?.value) || 1;
        const interval = expTime + 0.5;
        const totalDuration = interval * frames;

        const startTimeStr = document.getElementById("start-time") ? document.getElementById("start-time").value : "2026-10-19T20:00:00Z";
        let t0 = new Date(startTimeStr);
        if (isNaN(t0.getTime())) {
            t0 = new Date();
        }
        const t1 = new Date(t0.getTime() + totalDuration * 1000);

        const siteName = (sitePresetSelect && sitePresetSelect.selectedIndex >= 0 && sitePresetSelect.options[sitePresetSelect.selectedIndex])
            ? sitePresetSelect.options[sitePresetSelect.selectedIndex].text
            : "Lulin";

        return {
            site: {
                name: siteName,
                lat_deg: parseFloat(siteLatInput?.value) || 23.4694,
                lon_deg: parseFloat(siteLonInput?.value) || 120.8726,
                alt_m: parseFloat(siteAltInput?.value) || 2862.0
            },
            pointing: {
                coord_frame: coordFrame,
                ra_deg: parseFloat(document.getElementById("point-ra")?.value) || 88.79,
                dec_deg: parseFloat(document.getElementById("point-dec")?.value) || 7.41,
                az_deg: parseFloat(document.getElementById("point-az")?.value) || 180.0,
                alt_deg: parseFloat(document.getElementById("point-alt")?.value) || 65.0,
                roll_deg: parseFloat(document.getElementById("point-roll")?.value) || 0.0,
                tracking_mode: trackingMode
            },
            atmosphere: {
                seeing_fwhm_arcsec: parseFloat(document.getElementById("seeing-fwhm")?.value) || 1.5,
                extinction_kv: parseFloat(document.getElementById("extinction-kv")?.value) || 0.15,
                cloud_cover_percent: parseFloat(cloudSlider?.value) || 0.0,
                bortle_class: parseInt(document.getElementById("bortle-class")?.value) || 2,
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

    // 11. Run Simulation
    btnRunSim.addEventListener("click", () => {
        switchToTab("image");
        let config;
        try {
            config = buildFullConfig();
        } catch (e) {
            alert(`參數設定錯誤: ${e}`);
            return;
        }

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
            deviceBadge.textContent = res.device_info;

            placeholderView.style.display = "none";
            simImage.style.display = "block";

            // Frame Slider
            frameSlider.min = 1;
            frameSlider.max = res.num_frames;
            frameSlider.value = 1;

            updateFrameView(0);
            populateDataTables(res);

            // Enable download buttons
            btnDownloadAll.classList.remove("disabled");
            btnDownloadFits.classList.remove("disabled");
            btnDownloadPng.classList.remove("disabled");
            btnDownloadAnnotatedPng.classList.remove("disabled");
            btnDownloadCsv.classList.remove("disabled");
        })
        .catch(err => {
            loadingOverlay.style.display = "none";
            btnRunSim.disabled = false;
            statusText.textContent = "連線異常";
            statusText.style.color = "var(--danger)";
            alert(`網路連線異常: ${err}`);
        });
    });

    // 12. Viewport Display
    function updateFrameView(idx) {
        if (!simulationResult || !simulationResult.png_urls || !simulationResult.png_urls[idx]) return;
        currentFrameIndex = idx;

        const useBurnin = toggleBurnin.checked && simulationResult.annotated_png_urls && simulationResult.annotated_png_urls[idx];
        simImage.src = useBurnin ? simulationResult.annotated_png_urls[idx] : simulationResult.png_urls[idx];

        frameIndicator.textContent = `第 ${idx + 1} / ${simulationResult.num_frames} 幀`;
        frameSlider.value = idx + 1;

        // Download links
        btnDownloadFits.href = simulationResult.fits_urls[idx];
        btnDownloadPng.href = simulationResult.png_urls[idx];
        if (simulationResult.annotated_png_urls && simulationResult.annotated_png_urls[idx]) {
            btnDownloadAnnotatedPng.href = simulationResult.annotated_png_urls[idx];
        }
        if (simulationResult.csv_urls && simulationResult.csv_urls[idx]) {
            btnDownloadCsv.href = simulationResult.csv_urls[idx];
        }

        simImage.onload = () => {
            drawAnnotations();
        };
    }

    function drawAnnotations() {
        if (!simulationResult || !toggleAnnotations.checked || toggleBurnin.checked) {
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

        // Draw Stars overlay
        if (simulationResult.stars) {
            simulationResult.stars.forEach(s => {
                if (s.frame === currentFrameIndex) {
                    const x = s.x_px * scaleX;
                    const y = (imgH - s.y_px) * scaleY;
                    const r = Math.max(3, (s.size_px * scaleX) / 2);

                    ctx.strokeStyle = "#10b981";
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, 2 * Math.PI);
                    ctx.stroke();

                    if (s.vmag <= 10.5) {
                        ctx.fillStyle = "#34d399";
                        ctx.font = "10px Inter, sans-serif";
                        ctx.fillText(`${s.name} V=${s.vmag.toFixed(1)} S=${s.size_px}px`, x + r + 3, y - 3);
                    }
                }
            });
        }

        // Draw RSO Streak overlay
        if (simulationResult.targets) {
            simulationResult.targets.forEach(tgt => {
                if (tgt.frame === currentFrameIndex) {
                    const x0 = tgt.start_pixel[0] * scaleX;
                    const y0 = (imgH - tgt.start_pixel[1]) * scaleY;
                    const x1 = tgt.end_pixel[0] * scaleX;
                    const y1 = (imgH - tgt.end_pixel[1]) * scaleY;

                    // Streak line
                    ctx.strokeStyle = "#ef4444";
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(x0, y0);
                    ctx.lineTo(x1, y1);
                    ctx.stroke();

                    // Bounding box
                    ctx.strokeStyle = "#38bdf8";
                    ctx.lineWidth = 1.5;
                    const pad = 6;
                    ctx.strokeRect(
                        Math.min(x0, x1) - pad,
                        Math.min(y0, y1) - pad,
                        Math.abs(x1 - x0) + pad * 2,
                        Math.abs(y1 - y0) + pad * 2
                    );

                    // Tag
                    ctx.fillStyle = "#38bdf8";
                    ctx.font = "bold 11px Inter, sans-serif";
                    ctx.fillText(`🛰️ ${tgt.target_name} V=${tgt.vmag} Len=${tgt.streak_length_px}px SNR=${tgt.snr}`, Math.min(x0, x1), Math.min(y0, y1) - 8);
                }
            });
        }
    }

    function clearCanvas() {
        const ctx = overlayCanvas.getContext("2d");
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }

    toggleAnnotations.addEventListener("change", drawAnnotations);
    toggleBurnin.addEventListener("change", () => updateFrameView(currentFrameIndex));
    window.addEventListener("resize", drawAnnotations);

    // Contrast Stretch Toggles
    const stretchButtons = document.querySelectorAll(".btn-stretch");
    stretchButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            stretchButtons.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            applyStretch(btn.dataset.stretch);
        });
    });

    function applyStretch(mode) {
        if (!simImage) return;
        if (mode === "zscale") {
            simImage.style.filter = "contrast(1.25) brightness(1.1)";
        } else if (mode === "log") {
            simImage.style.filter = "contrast(0.9) brightness(1.4)";
        } else if (mode === "asinh") {
            simImage.style.filter = "contrast(1.45) brightness(1.15)";
        } else {
            simImage.style.filter = "none";
        }
    }

    // 13. Populate Data Catalog Tables
    function populateDataTables(res) {
        // RSO Table
        tableRsoBody.innerHTML = "";
        if (res.targets && res.targets.length > 0) {
            res.targets.forEach(t => {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td><strong>${t.target_name}</strong></td>
                    <td>(${t.center_pixel[0]}, ${t.center_pixel[1]})</td>
                    <td>${t.streak_length_px} px</td>
                    <td>${t.streak_width_px} px</td>
                    <td>[${t.bbox.join(', ')}]</td>
                    <td>${t.vmag}</td>
                    <td><span style="color:#10b981; font-weight:bold;">${t.snr}</span></td>
                    <td>${t.total_electrons} e-</td>
                `;
                tableRsoBody.appendChild(tr);
            });
        } else {
            tableRsoBody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">無目標記錄</td></tr>`;
        }

        // Stars Table
        tableStarsBody.innerHTML = "";
        if (res.stars && res.stars.length > 0) {
            res.stars.slice(0, 100).forEach(s => {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${s.name}</td>
                    <td>(${s.x_px}, ${s.y_px})</td>
                    <td>(${s.ra_deg}°, ${s.dec_deg}°)</td>
                    <td>${s.size_px} px (${s.size_arcsec}")</td>
                    <td>${s.vmag}</td>
                    <td>${s.snr}</td>
                    <td>${s.electrons} e-</td>
                    <td>${s.is_streak ? '條紋 (Stare)' : '點源 (Point)'}</td>
                `;
                tableStarsBody.appendChild(tr);
            });
        } else {
            tableStarsBody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">未偵測到恆星</td></tr>`;
        }
    }

    // 14. Playback Controls
    frameSlider.addEventListener("input", (e) => updateFrameView(parseInt(e.target.value) - 1));
    btnPrevFrame.addEventListener("click", () => {
        if (!simulationResult) return;
        updateFrameView((currentFrameIndex - 1 + simulationResult.num_frames) % simulationResult.num_frames);
    });
    btnNextFrame.addEventListener("click", () => {
        if (!simulationResult) return;
        updateFrameView((currentFrameIndex + 1) % simulationResult.num_frames);
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
                updateFrameView((currentFrameIndex + 1) % simulationResult.num_frames);
            }, 600);
        }
    });

    btnDownloadAll.addEventListener("click", () => {
        window.location.href = "/api/download/all";
    });

    // Initial setups
    drawSkyDomeRadar();
    fetchSensors("sony_imx455");
    fetchLiveSkyMap();
    fetchTransitingSatellites();
});
