/**
 * SatSim Native GUI Frontend Controller
 * Direct interface for Air Force Research Laboratory (AFRL) SatSim 0.26
 * - Form & Raw SatSim JSON Editor synchronization
 * - Native SatSim multi-frame execution and log capture
 * - Astronomical FITS/PNG Optical Viewer with Zoom, Pan & Hover Inspector
 * - Standard SatNet annotations & CSV export
 */

document.addEventListener("DOMContentLoaded", () => {
    let currentSensors = [];
    let currentSensorProfile = null;
    let sitesDatabase = {};
    let simulationResult = null;
    let currentFrameIndex = 0;
    let isPlaying = false;
    let playInterval = null;
    let activeConfigMode = "form"; // "form" | "json"
    let cachedTemplates = {};

    // Zoom & Pan state
    let zoomScale = 1.0;
    let panX = 0;
    let panY = 0;
    let isPanning = false;
    let startMouseX = 0;
    let startMouseY = 0;
    let startPanX = 0;
    let startPanY = 0;

    // Hover Inspector state
    let hoveredObject = null;
    let pinnedObject = null;

    // Mode Switch Elements
    const tabBtnForm = document.getElementById("tab-btn-form");
    const tabBtnJson = document.getElementById("tab-btn-json");
    const modeFormContainer = document.getElementById("mode-form-container");
    const modeJsonContainer = document.getElementById("mode-json-container");

    // JSON Editor Elements
    const jsonTemplateSelect = document.getElementById("json-template-select");
    const satsimJsonEditor = document.getElementById("satsim-json-editor");
    const btnSyncFormToJson = document.getElementById("btn-sync-form-to-json");
    const btnSyncJsonToForm = document.getElementById("btn-sync-json-to-form");
    const btnExportJson = document.getElementById("btn-export-json");
    const btnImportJson = document.getElementById("btn-import-json");
    const jsonFileInput = document.getElementById("json-file-input");
    const jsonStatusMsg = document.getElementById("json-status-msg");

    // Form Elements
    const sitePresetSelect = document.getElementById("site-preset");
    const siteLatInput = document.getElementById("site-lat");
    const siteLonInput = document.getElementById("site-lon");
    const siteAltInput = document.getElementById("site-alt");

    const sensorSelect = document.getElementById("sensor-select");
    const pixelScaleDisplay = document.getElementById("pixel-scale-display");

    const trackingRadios = document.querySelectorAll("input[name='tracking-mode']");
    const radecInputs = document.getElementById("radec-inputs");
    const altazInputs = document.getElementById("altaz-inputs");

    const rsoModeSelect = document.getElementById("rso-mode");
    const rsoTleSection = document.getElementById("rso-tle-section");
    const rsoLineSection = document.getElementById("rso-line-section");
    const tlePresetSelect = document.getElementById("tle-preset-select");
    const customTle1 = document.getElementById("custom-tle1");
    const customTle2 = document.getElementById("custom-tle2");

    // Simulation & Status
    const btnRunSim = document.getElementById("btn-run-simulation");
    const loadingOverlay = document.getElementById("loading-spinner");
    const placeholderView = document.getElementById("placeholder-view");
    const simImage = document.getElementById("sim-image");
    const overlayCanvas = document.getElementById("overlay-canvas");
    const canvasViewport = document.getElementById("canvas-viewport");
    const canvasTransformContainer = document.getElementById("canvas-transform-container");
    const toggleAnnotations = document.getElementById("toggle-annotations");

    const statusText = document.getElementById("status-text");
    const statusTime = document.getElementById("status-time");
    const statusDevice = document.getElementById("status-device");
    const headerStatusBadge = document.getElementById("header-status-badge");
    const deviceBadge = document.getElementById("device-badge");

    // Zoom controls
    const btnZoomIn = document.getElementById("btn-zoom-in");
    const btnZoomOut = document.getElementById("btn-zoom-out");
    const btnZoom100 = document.getElementById("btn-zoom-100");
    const btnZoomFit = document.getElementById("btn-zoom-fit");
    const zoomLevelBadge = document.getElementById("zoom-level-badge");

    // Inspector elements
    const inspectorEmptyState = document.getElementById("inspector-empty-state");
    const inspectorDetailCard = document.getElementById("inspector-detail-card");
    const inspectorPinnedTag = document.getElementById("inspector-pinned-tag");
    const inspectorBadge = document.getElementById("inspector-badge");
    const inspectorName = document.getElementById("inspector-name");
    const inspectorPixel = document.getElementById("inspector-pixel");
    const inspectorRadec = document.getElementById("inspector-radec");
    const inspectorVmag = document.getElementById("inspector-vmag");
    const inspectorSnr = document.getElementById("inspector-snr");
    const inspectorStreak = document.getElementById("inspector-streak");
    const inspectorElectrons = document.getElementById("inspector-electrons");
    const inspectorBbox = document.getElementById("inspector-bbox");

    // Player
    const btnPrevFrame = document.getElementById("btn-prev-frame");
    const btnPlayPause = document.getElementById("btn-play-pause");
    const btnNextFrame = document.getElementById("btn-next-frame");
    const frameSlider = document.getElementById("frame-slider");
    const frameIndicator = document.getElementById("frame-indicator");

    // Console & Tables
    const consoleOutput = document.getElementById("console-output");
    const btnClearConsole = document.getElementById("btn-clear-console");
    const tableRsoBody = document.getElementById("table-rso-body");
    const tableStarsBody = document.getElementById("table-stars-body");

    // Download links
    const btnDownloadFits = document.getElementById("btn-download-fits");
    const btnDownloadPng = document.getElementById("btn-download-png");
    const btnDownloadSatnet = document.getElementById("btn-download-satnet");
    const btnDownloadCsv = document.getElementById("btn-download-csv");
    const btnDownloadAll = document.getElementById("btn-download-all");

    // View tabs
    const viewTabs = document.querySelectorAll(".view-tab");
    const tabPanels = document.querySelectorAll(".tab-panel");

    // ==========================================
    // 1. Navigation & Tabs
    // ==========================================
    function switchToTab(tabName) {
        viewTabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));
        tabPanels.forEach(p => p.classList.toggle("active", p.id === `tab-${tabName}-panel`));
        if (tabName === "image") {
            setTimeout(drawAnnotations, 50);
        }
    }

    viewTabs.forEach(tab => {
        tab.addEventListener("click", () => switchToTab(tab.dataset.tab));
    });

    // Configuration Mode Switch (Form vs Raw JSON)
    tabBtnForm.addEventListener("click", () => {
        activeConfigMode = "form";
        tabBtnForm.classList.add("active");
        tabBtnJson.classList.remove("active");
        modeFormContainer.style.display = "flex";
        modeJsonContainer.style.display = "none";
    });

    tabBtnJson.addEventListener("click", () => {
        activeConfigMode = "json";
        tabBtnJson.classList.add("active");
        tabBtnForm.classList.remove("active");
        modeFormContainer.style.display = "none";
        modeJsonContainer.style.display = "flex";

        if (!satsimJsonEditor.value.trim()) {
            syncFormToJson();
        }
    });

    // ==========================================
    // 2. SatSim JSON Editor & Presets
    // ==========================================
    function fetchTemplates() {
        fetch("/api/satsim/templates")
            .then(r => r.json())
            .then(data => {
                cachedTemplates = data;
                if (cachedTemplates["tle_transit"] && !satsimJsonEditor.value.trim()) {
                    satsimJsonEditor.value = JSON.stringify(cachedTemplates["tle_transit"].config, null, 2);
                    validateJsonEditor();
                }
            })
            .catch(console.error);
    }

    fetchTemplates();

    jsonTemplateSelect.addEventListener("change", (e) => {
        const key = e.target.value;
        if (cachedTemplates[key]) {
            satsimJsonEditor.value = JSON.stringify(cachedTemplates[key].config, null, 2);
            validateJsonEditor();
        }
    });

    function validateJsonEditor() {
        try {
            const parsed = JSON.parse(satsimJsonEditor.value);
            jsonStatusMsg.textContent = "格式驗證：有效 SatSim 0.26 JSON";
            jsonStatusMsg.style.color = "var(--success)";
            return parsed;
        } catch (err) {
            jsonStatusMsg.textContent = `語法錯誤: ${err.message}`;
            jsonStatusMsg.style.color = "var(--danger)";
            return null;
        }
    }

    satsimJsonEditor.addEventListener("input", validateJsonEditor);

    btnSyncFormToJson.addEventListener("click", () => {
        syncFormToJson();
    });

    function syncFormToJson() {
        let config;
        try {
            config = buildFullFormConfig();
        } catch (e) {
            alert(`表單參數解析異常: ${e}`);
            return;
        }

        fetch("/api/satsim/generate_config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config)
        })
        .then(r => r.json())
        .then(res => {
            if (res.satsim_config) {
                satsimJsonEditor.value = JSON.stringify(res.satsim_config, null, 2);
                validateJsonEditor();
            }
        })
        .catch(console.error);
    }

    btnSyncJsonToForm.addEventListener("click", () => {
        const parsed = validateJsonEditor();
        if (!parsed) {
            alert("請先修正 JSON 語法錯誤！");
            return;
        }

        // Apply geometry
        if (parsed.geometry) {
            const site = parsed.geometry.site || {};
            if (site.lat != null) siteLatInput.value = site.lat;
            if (site.lon != null) siteLonInput.value = site.lon;
            if (site.alt != null) siteAltInput.value = site.alt;

            const t = parsed.geometry.time;
            if (Array.isArray(t) && t.length >= 6) {
                const pad = (n) => String(Math.floor(n)).padStart(2, "0");
                document.getElementById("start-time").value = `${t[0]}-${pad(t[1])}-${pad(t[2])}T${pad(t[3])}:${pad(t[4])}:${pad(t[5])}Z`;
            }

            const track = site.track || {};
            if (track.mode === "fixed") {
                document.querySelector("input[name='tracking-mode'][value='stare']").checked = true;
                radecInputs.style.display = "none";
                altazInputs.style.display = "flex";
                if (track.az != null) document.getElementById("point-az").value = track.az;
                if (track.el != null) document.getElementById("point-alt").value = track.el;
            } else {
                document.querySelector("input[name='tracking-mode'][value='sidereal']").checked = true;
                radecInputs.style.display = "flex";
                altazInputs.style.display = "none";
                if (track.ra != null) document.getElementById("point-ra").value = track.ra;
                if (track.dec != null) document.getElementById("point-dec").value = track.dec;
            }

            const obsList = (parsed.geometry.obs && parsed.geometry.obs.list) ? parsed.geometry.obs.list : [];
            if (obsList.length > 0) {
                const target = obsList[0];
                if (target.mode === "tle") {
                    rsoModeSelect.value = "tle";
                    rsoTleSection.style.display = "block";
                    rsoLineSection.style.display = "none";
                    if (target.tle1) customTle1.value = target.tle1;
                    if (target.tle2) customTle2.value = target.tle2;
                } else if (target.mode === "line") {
                    rsoModeSelect.value = "line";
                    rsoTleSection.style.display = "none";
                    rsoLineSection.style.display = "block";
                    if (target.origin) {
                        document.getElementById("line-origin-x").value = target.origin[0];
                        document.getElementById("line-origin-y").value = target.origin[1];
                    }
                    if (target.velocity) {
                        document.getElementById("line-vel-x").value = target.velocity[0];
                        document.getElementById("line-vel-y").value = target.velocity[1];
                    }
                }
                if (target.mv != null) document.getElementById("target-vmag").value = target.mv;
            }
        }

        // Apply FPA
        if (parsed.fpa) {
            const fpa = parsed.fpa;
            if (fpa.width) document.getElementById("sensor-width").value = fpa.width;
            if (fpa.height) document.getElementById("sensor-height").value = fpa.height;
            if (fpa.time && fpa.time.exposure) document.getElementById("exposure-time").value = fpa.time.exposure;
            if (fpa.num_frames) document.getElementById("frame-count").value = fpa.num_frames;
            if (fpa.dark_current != null) document.getElementById("sensor-dark-curr").value = fpa.dark_current;
            if (fpa.bias != null) document.getElementById("sensor-bias").value = fpa.bias;
            if (fpa.noise && fpa.noise.read != null) document.getElementById("sensor-read-noise").value = fpa.noise.read;
        }

        alert("✅ 已成功從 SatSim JSON 設定檔同步至表單參數！");
    });

    btnExportJson.addEventListener("click", () => {
        const content = satsimJsonEditor.value;
        const blob = new Blob([content], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "satsim_config.json";
        a.click();
        URL.revokeObjectURL(url);
    });

    btnImportJson.addEventListener("click", () => jsonFileInput.click());

    jsonFileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            satsimJsonEditor.value = evt.target.result;
            validateJsonEditor();
        };
        reader.readAsText(file);
    });

    // ==========================================
    // 3. Form Controls & Sensor Profiles
    // ==========================================
    trackingRadios.forEach(radio => {
        radio.addEventListener("change", (e) => {
            if (e.target.value === "sidereal") {
                radecInputs.style.display = "flex";
                altazInputs.style.display = "none";
            } else {
                radecInputs.style.display = "none";
                altazInputs.style.display = "flex";
            }
        });
    });

    rsoModeSelect.addEventListener("change", (e) => {
        if (e.target.value === "tle") {
            rsoTleSection.style.display = "block";
            rsoLineSection.style.display = "none";
        } else {
            rsoTleSection.style.display = "none";
            rsoLineSection.style.display = "block";
        }
    });

    const PRESET_TLES = {
        starlink: {
            line1: "1 44713U 19074A   26292.83333333  .00001234  00000-0  56789-4 0  9991",
            line2: "2 44713  53.0543 280.1234 0001234  75.4321 284.6789 15.06412345 12345"
        },
        iss: {
            line1: "1 25544U 98067A   26292.85501157  .00016717  00000-0  10270-3 0  9993",
            line2: "2 25544  51.6416 112.5123 0005432 290.1234 165.4321 15.4987654312345"
        },
        hubble: {
            line1: "1 20580U 90037B   26292.74830116  .00001234  00000-0  45678-4 0  9992",
            line2: "2 20580  28.4698  55.1234 0002874  85.4321 274.6789 15.0934567812345"
        },
        tiangong: {
            line1: "1 48274U 21035A   26292.81234567  .00021345  00000-0  14567-3 0  9994",
            line2: "2 48274  41.4723  98.1234 0003456 220.1234 140.4321 15.6123456712345"
        }
    };

    tlePresetSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        if (PRESET_TLES[val]) {
            customTle1.value = PRESET_TLES[val].line1;
            customTle2.value = PRESET_TLES[val].line2;
        }
    });

    // Site Presets
    fetch("/api/sites")
        .then(r => r.json())
        .then(data => { sitesDatabase = data; })
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

    // Sensor Profiles
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
                currentSensorProfile = profile;
                document.getElementById("sensor-aperture").value = profile.optical.aperture_m;
                document.getElementById("sensor-focal-len").value = profile.optical.focal_length_m;
                document.getElementById("sensor-width").value = profile.detector.width_px;
                document.getElementById("sensor-height").value = profile.detector.height_px;
                document.getElementById("sensor-pix-size").value = profile.detector.pixel_size_um;
                document.getElementById("sensor-read-noise").value = profile.noise.read_noise_e;
                document.getElementById("sensor-dark-curr").value = profile.noise.dark_current_eps;
                document.getElementById("sensor-bias").value = profile.noise.bias_adu;

                const pixScale = 206265.0 * (profile.detector.pixel_size_um * 1e-6) / profile.optical.focal_length_m;
                const fovW = (profile.detector.width_px * pixScale) / 3600.0;
                const fovH = (profile.detector.height_px * pixScale) / 3600.0;
                pixelScaleDisplay.textContent = `角解析力: ${pixScale.toFixed(2)}" / 視場: ${fovW.toFixed(2)}°x${fovH.toFixed(2)}°`;
            })
            .catch(console.error);
    }

    sensorSelect.addEventListener("change", (e) => loadSensorDetails(e.target.value));
    fetchSensors("sony_imx455");

    function buildFullFormConfig() {
        const trackingMode = document.querySelector("input[name='tracking-mode']:checked").value;
        const isSidereal = trackingMode === "sidereal";

        const ap = parseFloat(document.getElementById("sensor-aperture").value) || 0.5;
        const fl = parseFloat(document.getElementById("sensor-focal-len").value) || 2.0;
        const wPx = parseInt(document.getElementById("sensor-width").value) || 1024;
        const hPx = parseInt(document.getElementById("sensor-height").value) || 1024;
        const pixUm = parseFloat(document.getElementById("sensor-pix-size").value) || 3.76;
        const expTime = parseFloat(document.getElementById("exposure-time").value) || 2.0;
        const frames = parseInt(document.getElementById("frame-count").value) || 1;

        let targets = [];
        const rsoMode = rsoModeSelect.value;
        const vmag = parseFloat(document.getElementById("target-vmag").value) || 7.5;

        if (rsoMode === "tle") {
            targets.push({
                name: "SatSim_TLE_Target",
                mode: "tle",
                tle1: customTle1.value.trim(),
                tle2: customTle2.value.trim(),
                visual_magnitude: vmag
            });
        } else {
            const ox = parseFloat(document.getElementById("line-origin-x").value) || 0.2;
            const oy = parseFloat(document.getElementById("line-origin-y").value) || 0.3;
            const vx = parseFloat(document.getElementById("line-vel-x").value) || 18.0;
            const vy = parseFloat(document.getElementById("line-vel-y").value) || 7.0;
            targets.push({
                name: "SatSim_Linear_RSO",
                mode: "line",
                origin: [ox, oy],
                velocity: [vx, vy],
                visual_magnitude: vmag
            });
        }

        const t0 = new Date(document.getElementById("start-time").value || "2026-10-19T20:00:00Z");
        const t1 = new Date(t0.getTime() + (expTime + 0.5) * frames * 1000);

        return {
            site: {
                name: "SatSim Observation Site",
                lat_deg: parseFloat(siteLatInput.value) || 23.4694,
                lon_deg: parseFloat(siteLonInput.value) || 120.8726,
                alt_m: parseFloat(siteAltInput.value) || 2862.0
            },
            pointing: {
                coord_frame: isSidereal ? "radec" : "altaz",
                ra_deg: parseFloat(document.getElementById("point-ra").value) || 88.79,
                dec_deg: parseFloat(document.getElementById("point-dec").value) || 7.41,
                az_deg: parseFloat(document.getElementById("point-az").value) || 180.0,
                alt_deg: parseFloat(document.getElementById("point-alt").value) || 75.0,
                roll_deg: 0.0,
                tracking_mode: trackingMode
            },
            atmosphere: {
                seeing_fwhm_arcsec: 1.5,
                extinction_kv: 0.15,
                bortle_class: parseInt(document.getElementById("bortle-class").value) || 2
            },
            sensor: {
                sensor_id: "satsim_sensor",
                name: "SatSim Sensor",
                optical: { aperture_m: ap, focal_length_m: fl, central_wavelength_nm: 550.0, bandwidth_nm: 100.0 },
                detector: { width_px: wPx, height_px: hPx, pixel_size_um: pixUm, bit_depth: 16, quantum_efficiency: 0.85, full_well_capacity_e: 50000.0 },
                noise: {
                    read_noise_e: parseFloat(document.getElementById("sensor-read-noise").value) || 2.0,
                    dark_current_eps: parseFloat(document.getElementById("sensor-dark-curr").value) || 0.005,
                    gain_e_per_adu: 1.0,
                    bias_adu: parseFloat(document.getElementById("sensor-bias").value) || 100.0
                }
            },
            targets: targets,
            start_time_iso: t0.toISOString(),
            end_time_iso: t1.toISOString(),
            exposure_time_s: expTime,
            readout_time_s: 0.5,
            engine: "satsim",
            use_gpu: document.getElementById("use-gpu-check").checked
        };
    }

    // ==========================================
    // 4. Run SatSim Native Simulation
    // ==========================================
    btnRunSim.addEventListener("click", () => {
        let payload = {};

        if (activeConfigMode === "json") {
            const parsed = validateJsonEditor();
            if (!parsed) {
                alert("❌ SatSim JSON 存在語法錯誤，請檢查修正後再執行！");
                return;
            }
            payload = {
                satsim_json: parsed,
                use_gpu: document.getElementById("use-gpu-check").checked
            };
        } else {
            try {
                payload = buildFullFormConfig();
            } catch (e) {
                alert(`表單參數錯誤: ${e}`);
                return;
            }
        }

        statusText.textContent = "SatSim 0.26 運算中...";
        statusText.style.color = "var(--warning)";
        headerStatusBadge.textContent = "運算中 (Computing)";
        headerStatusBadge.className = "badge badge-info";
        loadingOverlay.style.display = "flex";
        btnRunSim.disabled = true;

        consoleOutput.textContent += `\n[${new Date().toLocaleTimeString()}] 🚀 正在啟動 SatSim 0.26 原生核心運算...\n`;

        fetch("/api/satsim/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        })
        .then(r => r.json())
        .then(res => {
            loadingOverlay.style.display = "none";
            btnRunSim.disabled = false;

            if (res.error) {
                statusText.textContent = "失敗 (Error)";
                statusText.style.color = "var(--danger)";
                headerStatusBadge.textContent = "失敗 (Error)";
                headerStatusBadge.className = "badge";
                alert(`SatSim 模擬運算失敗: ${res.error}`);
                consoleOutput.textContent += `\n[ERROR] SatSim 執行異常: ${res.error}\n`;
                return;
            }

            simulationResult = res;
            currentFrameIndex = 0;
            pinnedObject = null;
            hoveredObject = null;
            resetInspectorPanel();

            statusText.textContent = "完成 (Completed)";
            statusText.style.color = "var(--success)";
            headerStatusBadge.textContent = "就緒 (Ready)";
            headerStatusBadge.className = "badge badge-action";

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

            // Populate Console Output
            if (res.log_output) {
                consoleOutput.textContent = res.log_output;
                consoleOutput.scrollTop = consoleOutput.scrollHeight;
            }

            // Sync generated JSON back to editor if in form mode
            if (res.satsim_config && activeConfigMode === "form") {
                satsimJsonEditor.value = JSON.stringify(res.satsim_config, null, 2);
                validateJsonEditor();
            }

            // Enable download buttons
            btnDownloadAll.classList.remove("disabled");
            btnDownloadFits.classList.remove("disabled");
            btnDownloadPng.classList.remove("disabled");
            btnDownloadCsv.classList.remove("disabled");
            if (res.satnet_json_urls && res.satnet_json_urls.length > 0) {
                btnDownloadSatnet.classList.remove("disabled");
            }

            switchToTab("image");
        })
        .catch(err => {
            loadingOverlay.style.display = "none";
            btnRunSim.disabled = false;
            statusText.textContent = "連線異常";
            statusText.style.color = "var(--danger)";
            alert(`網路連線異常: ${err}`);
        });
    });

    btnClearConsole.addEventListener("click", () => {
        consoleOutput.textContent = "已清除記錄。";
    });

    // ==========================================
    // 5. Image Viewer: Zoom, Pan & Hover Inspector
    // ==========================================
    function applyTransform() {
        if (!canvasTransformContainer) return;
        canvasTransformContainer.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
        if (zoomLevelBadge) {
            zoomLevelBadge.textContent = `${Math.round(zoomScale * 100)}%`;
        }
    }

    function zoomFit() {
        if (!simImage || !simImage.naturalWidth || !canvasViewport) return;
        const vpRect = canvasViewport.getBoundingClientRect();
        const pad = 24;
        const scaleX = (vpRect.width - pad) / simImage.naturalWidth;
        const scaleY = (vpRect.height - pad) / simImage.naturalHeight;
        zoomScale = Math.min(scaleX, scaleY, 1.0);
        if (zoomScale < 0.1) zoomScale = 0.5;

        const scaledW = simImage.naturalWidth * zoomScale;
        const scaledH = simImage.naturalHeight * zoomScale;
        panX = (vpRect.width - scaledW) / 2;
        panY = (vpRect.height - scaledH) / 2;
        applyTransform();
    }

    btnZoomIn.addEventListener("click", () => {
        zoomScale = Math.min(zoomScale * 1.25, 10.0);
        applyTransform();
    });

    btnZoomOut.addEventListener("click", () => {
        zoomScale = Math.max(zoomScale * 0.8, 0.2);
        applyTransform();
    });

    btnZoom100.addEventListener("click", () => {
        zoomScale = 1.0;
        if (simImage && simImage.naturalWidth && canvasViewport) {
            const vpRect = canvasViewport.getBoundingClientRect();
            panX = (vpRect.width - simImage.naturalWidth) / 2;
            panY = (vpRect.height - simImage.naturalHeight) / 2;
        } else {
            panX = 0;
            panY = 0;
        }
        applyTransform();
    });

    btnZoomFit.addEventListener("click", zoomFit);

    // Mouse wheel zoom centered at cursor
    canvasViewport.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = canvasViewport.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const delta = e.deltaY < 0 ? 1.15 : 0.87;
        const newScale = Math.min(Math.max(zoomScale * delta, 0.2), 10.0);

        panX = mouseX - (mouseX - panX) * (newScale / zoomScale);
        panY = mouseY - (mouseY - panY) * (newScale / zoomScale);
        zoomScale = newScale;
        applyTransform();
    }, { passive: false });

    // Drag to Pan
    canvasViewport.addEventListener("mousedown", (e) => {
        if (e.button === 0 || e.button === 1) {
            isPanning = true;
            startMouseX = e.clientX;
            startMouseY = e.clientY;
            startPanX = panX;
            startPanY = panY;
            canvasViewport.classList.add("grabbing");
        }
    });

    window.addEventListener("mousemove", (e) => {
        if (isPanning) {
            panX = startPanX + (e.clientX - startMouseX);
            panY = startPanY + (e.clientY - startMouseY);
            applyTransform();
        }
    });

    window.addEventListener("mouseup", () => {
        if (isPanning) {
            isPanning = false;
            canvasViewport.classList.remove("grabbing");
        }
    });

    function updateFrameView(idx) {
        if (!simulationResult || !simulationResult.png_urls || !simulationResult.png_urls[idx]) return;
        currentFrameIndex = idx;

        simImage.src = simulationResult.png_urls[idx];
        frameIndicator.textContent = `第 ${idx + 1} / ${simulationResult.num_frames} 幀`;
        frameSlider.value = idx + 1;

        // Download links
        btnDownloadFits.href = simulationResult.fits_urls[idx];
        btnDownloadPng.href = simulationResult.png_urls[idx];
        if (simulationResult.csv_urls && simulationResult.csv_urls[idx]) {
            btnDownloadCsv.href = simulationResult.csv_urls[idx];
        }
        if (simulationResult.satnet_json_urls && simulationResult.satnet_json_urls[idx]) {
            btnDownloadSatnet.href = simulationResult.satnet_json_urls[idx];
        }

        simImage.onload = () => {
            if (zoomScale === 1.0 && panX === 0 && panY === 0) {
                zoomFit();
            }
            drawAnnotations();
        };
    }

    function getInteractiveObjectsForCurrentFrame() {
        if (!simulationResult) return [];
        const items = [];

        // SatSim Targets
        if (simulationResult.targets) {
            simulationResult.targets.forEach(tgt => {
                if (tgt.frame === currentFrameIndex) {
                    items.push({
                        type: "rso",
                        name: tgt.target_name || "SatSim RSO",
                        x: tgt.center_pixel ? tgt.center_pixel[0] : 0,
                        y: tgt.center_pixel ? tgt.center_pixel[1] : 0,
                        start_pixel: tgt.start_pixel,
                        end_pixel: tgt.end_pixel,
                        bbox: tgt.bbox,
                        vmag: tgt.vmag,
                        snr: tgt.snr,
                        streak_length_px: tgt.streak_length_px,
                        streak_width_px: tgt.streak_width_px,
                        electrons: tgt.total_electrons,
                        radec: null
                    });
                }
            });
        }

        // SatSim Stars
        if (simulationResult.stars) {
            simulationResult.stars.forEach(s => {
                if (s.frame === currentFrameIndex) {
                    items.push({
                        type: "star",
                        name: s.name || `Star #${s.star_id || ""}`,
                        x: s.x_px,
                        y: s.y_px,
                        bbox: s.bbox,
                        vmag: s.vmag,
                        snr: s.snr,
                        size_px: s.size_px,
                        electrons: s.electrons,
                        radec: s.ra_deg != null ? `(${s.ra_deg.toFixed(3)}°, ${s.dec_deg.toFixed(3)}°)` : null
                    });
                }
            });
        }
        return items;
    }

    function drawAnnotations() {
        if (!simulationResult || !toggleAnnotations.checked) {
            clearCanvas();
            return;
        }

        if (!simImage || !simImage.naturalWidth) return;

        const imgW = simImage.naturalWidth;
        const imgH = simImage.naturalHeight;
        overlayCanvas.width = imgW;
        overlayCanvas.height = imgH;
        overlayCanvas.style.width = `${imgW}px`;
        overlayCanvas.style.height = `${imgH}px`;
        simImage.style.width = `${imgW}px`;
        simImage.style.height = `${imgH}px`;
        canvasTransformContainer.style.width = `${imgW}px`;
        canvasTransformContainer.style.height = `${imgH}px`;

        const ctx = overlayCanvas.getContext("2d");
        ctx.clearRect(0, 0, imgW, imgH);

        const items = getInteractiveObjectsForCurrentFrame();

        // Draw clean bounding boxes (NO TEXT on canvas)
        items.forEach(item => {
            const isHovered = (hoveredObject && hoveredObject.name === item.name) || (pinnedObject && pinnedObject.name === item.name);

            if (item.type === "rso") {
                ctx.strokeStyle = isHovered ? "#38bdf8" : "rgba(56, 189, 248, 0.85)";
                ctx.lineWidth = isHovered ? 3.0 : 1.6;

                const [x0, y0, x1, y1] = item.bbox;
                const bx = Math.min(x0, x1);
                const by = Math.min(y0, y1);
                const bw = Math.abs(x1 - x0);
                const bh = Math.abs(y1 - y0);

                ctx.strokeRect(bx, by, Math.max(bw, 10), Math.max(bh, 10));

                if (isHovered) {
                    ctx.fillStyle = "rgba(56, 189, 248, 0.15)";
                    ctx.fillRect(bx, by, Math.max(bw, 10), Math.max(bh, 10));
                }

                if (item.start_pixel && item.end_pixel && item.streak_length_px > 1) {
                    ctx.strokeStyle = "#ef4444";
                    ctx.lineWidth = 1.8;
                    ctx.beginPath();
                    ctx.moveTo(item.start_pixel[0], item.start_pixel[1]);
                    ctx.lineTo(item.end_pixel[0], item.end_pixel[1]);
                    ctx.stroke();
                }
            } else {
                ctx.strokeStyle = isHovered ? "#34d399" : "rgba(16, 185, 129, 0.75)";
                ctx.lineWidth = isHovered ? 2.5 : 1.2;

                const [x0, y0, x1, y1] = item.bbox;
                const bx = Math.min(x0, x1);
                const by = Math.min(y0, y1);
                const bw = Math.abs(x1 - x0);
                const bh = Math.abs(y1 - y0);

                ctx.strokeRect(bx, by, Math.max(bw, 8), Math.max(bh, 8));

                if (isHovered) {
                    ctx.fillStyle = "rgba(16, 185, 129, 0.15)";
                    ctx.fillRect(bx, by, Math.max(bw, 8), Math.max(bh, 8));
                }
            }
        });
    }

    function clearCanvas() {
        const ctx = overlayCanvas.getContext("2d");
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }

    // Hit-testing on mouse move over overlay canvas
    overlayCanvas.addEventListener("mousemove", (e) => {
        if (!simulationResult) return;

        const rect = overlayCanvas.getBoundingClientRect();
        const imgX = (e.clientX - rect.left) * (overlayCanvas.width / rect.width);
        const imgY = (e.clientY - rect.top) * (overlayCanvas.height / rect.height);

        const items = getInteractiveObjectsForCurrentFrame();
        const margin = 8;
        let found = null;

        for (const item of items) {
            const [x0, y0, x1, y1] = item.bbox;
            const minX = Math.min(x0, x1) - margin;
            const maxX = Math.max(x0, x1) + margin;
            const minY = Math.min(y0, y1) - margin;
            const maxY = Math.max(y0, y1) + margin;

            if (imgX >= minX && imgX <= maxX && imgY >= minY && imgY <= maxY) {
                found = item;
                break;
            }
        }

        if (found) {
            overlayCanvas.style.cursor = "pointer";
            if (!pinnedObject) {
                hoveredObject = found;
                updateInspectorPanel(found);
                drawAnnotations();
            }
        } else {
            overlayCanvas.style.cursor = "crosshair";
            if (!pinnedObject) {
                hoveredObject = null;
                resetInspectorPanel();
                drawAnnotations();
            }
        }
    });

    overlayCanvas.addEventListener("mouseleave", () => {
        if (!pinnedObject) {
            hoveredObject = null;
            resetInspectorPanel();
            drawAnnotations();
        }
    });

    overlayCanvas.addEventListener("click", () => {
        if (hoveredObject) {
            if (pinnedObject && pinnedObject.name === hoveredObject.name) {
                pinnedObject = null;
                inspectorPinnedTag.style.display = "none";
            } else {
                pinnedObject = hoveredObject;
                inspectorPinnedTag.style.display = "inline-block";
                updateInspectorPanel(pinnedObject);
            }
            drawAnnotations();
        } else if (pinnedObject) {
            pinnedObject = null;
            inspectorPinnedTag.style.display = "none";
            resetInspectorPanel();
            drawAnnotations();
        }
    });

    function updateInspectorPanel(item) {
        if (!item) {
            resetInspectorPanel();
            return;
        }

        inspectorEmptyState.style.display = "none";
        inspectorDetailCard.style.display = "flex";

        if (item.type === "rso") {
            inspectorBadge.textContent = "🛰️ 空間目標 (RSO)";
            inspectorBadge.className = "target-badge badge-rso";
            inspectorStreak.textContent = `${item.streak_length_px ? item.streak_length_px.toFixed(1) : 0} px (寬 ${item.streak_width_px ? item.streak_width_px.toFixed(1) : 1} px)`;
        } else {
            inspectorBadge.textContent = "⭐ 視場恆星 (Star)";
            inspectorBadge.className = "target-badge badge-star";
            inspectorStreak.textContent = `${item.size_px ? item.size_px.toFixed(1) : 3} px (點斑)`;
        }

        inspectorName.textContent = item.name;
        inspectorPixel.textContent = `(${Math.round(item.x)}, ${Math.round(item.y)})`;
        inspectorRadec.textContent = item.radec ? item.radec : "SatSim WCS 座標";
        inspectorVmag.textContent = item.vmag != null ? `V = ${item.vmag.toFixed(2)}` : "--";
        inspectorSnr.textContent = item.snr != null ? `${item.snr.toFixed(1)}` : "--";
        inspectorElectrons.textContent = item.electrons != null ? `${Math.round(item.electrons).toLocaleString()} e-` : "--";
        inspectorBbox.textContent = item.bbox ? `[${item.bbox.map(v => Math.round(v)).join(", ")}]` : "--";
    }

    function resetInspectorPanel() {
        inspectorEmptyState.style.display = "flex";
        inspectorDetailCard.style.display = "none";
        inspectorPinnedTag.style.display = "none";
    }

    toggleAnnotations.addEventListener("change", drawAnnotations);

    // Populate Data Catalog Tables
    function populateDataTables(res) {
        // RSO Table
        tableRsoBody.innerHTML = "";
        if (res.targets && res.targets.length > 0) {
            res.targets.forEach(t => {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td><strong>${t.target_name}</strong></td>
                    <td>(${t.center_pixel ? t.center_pixel[0] : '--'}, ${t.center_pixel ? t.center_pixel[1] : '--'})</td>
                    <td>${t.streak_length_px} px</td>
                    <td>${t.streak_width_px} px</td>
                    <td>[${t.bbox ? t.bbox.join(', ') : '--'}]</td>
                    <td>${t.vmag}</td>
                    <td><span style="color:#10b981; font-weight:bold;">${t.snr}</span></td>
                    <td>${Math.round(t.total_electrons).toLocaleString()} e-</td>
                `;
                tableRsoBody.appendChild(tr);
            });
        } else {
            tableRsoBody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">無目標記錄</td></tr>`;
        }

        // Stars Table
        tableStarsBody.innerHTML = "";
        if (res.stars && res.stars.length > 0) {
            res.stars.slice(0, 150).forEach(s => {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${s.name}</td>
                    <td>(${s.x_px}, ${s.y_px})</td>
                    <td>${s.ra_deg != null ? `(${s.ra_deg.toFixed(3)}°, ${s.dec_deg.toFixed(3)}°)` : '--'}</td>
                    <td>${s.size_px} px</td>
                    <td>${s.vmag}</td>
                    <td>${s.snr}</td>
                    <td>${Math.round(s.electrons).toLocaleString()} e-</td>
                `;
                tableStarsBody.appendChild(tr);
            });
        } else {
            tableStarsBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">未偵測到恆星</td></tr>`;
        }
    }

    // Playback
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
});
