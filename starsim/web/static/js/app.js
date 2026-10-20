/**
 * StarSim Web Dashboard Frontend Controller
 * - Native SatSim physics engine integration
 * - 3D Earth Globe visualizer with telescope FOV cone frustum and real-time transiting satellite highlights
 * - Optical imagery viewer with Zoom & Pan (mouse wheel + drag)
 * - Clean bounding boxes with hover-based Side Inspector Window
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

    // Zoom & Pan state
    let zoomScale = 1.0;
    let panX = 0;
    let panY = 0;
    let isPanning = false;
    let startMouseX = 0;
    let startMouseY = 0;
    let startPanX = 0;
    let startPanY = 0;

    // Inspector & Hover state
    let hoveredObject = null;
    let pinnedObject = null;

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

    const btnRunSim = document.getElementById("btn-run-simulation");
    const loadingOverlay = document.getElementById("loading-spinner");
    const placeholderView = document.getElementById("placeholder-view");
    const simImage = document.getElementById("sim-image");
    const overlayCanvas = document.getElementById("overlay-canvas");
    const canvasViewport = document.getElementById("canvas-viewport");
    const canvasTransformContainer = document.getElementById("canvas-transform-container");
    const toggleAnnotations = document.getElementById("toggle-annotations");

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

    // 3D Globe & Tables
    const transitTableBody = document.getElementById("transit-table-body");
    const tableRsoBody = document.getElementById("table-rso-body");
    const tableStarsBody = document.getElementById("table-stars-body");

    // ==========================================
    // 1. Tab Switching & Initialization
    // ==========================================
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
            if (!globeInitialized) {
                initEarthGlobe();
            } else {
                resizeGlobeRenderer();
            }
            updateGlobeVisuals();
            fetchLiveSkyMap();
            fetchTransitingSatellites();
        } else if (tabName === "image") {
            setTimeout(drawAnnotations, 50);
        }
    }

    viewTabs.forEach(tab => {
        tab.addEventListener("click", () => {
            switchToTab(tab.dataset.tab);
        });
    });

    // ==========================================
    // 2. Tracking Mode & Pointing Inputs
    // ==========================================
    trackingCards.forEach(card => {
        card.addEventListener("click", () => {
            trackingCards.forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            const radio = card.querySelector("input[type='radio']");
            if (radio) radio.checked = true;
        });
    });

    coordRadios.forEach(radio => {
        radio.addEventListener("change", (e) => {
            if (e.target.value === "radec") {
                radecInputs.style.display = "flex";
                altazInputs.style.display = "none";
            } else {
                radecInputs.style.display = "none";
                altazInputs.style.display = "flex";
            }
            updateGlobeVisuals();
        });
    });

    ["point-ra", "point-dec", "point-az", "point-alt"].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("input", () => {
                updateGlobeVisuals();
            });
        }
    });

    cloudSlider.addEventListener("input", (e) => {
        cloudVal.textContent = `${e.target.value}%`;
    });

    // Site Presets
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
            updateGlobeVisuals();
            fetchLiveSkyMap();
            fetchTransitingSatellites();
        }
    });

    [siteLatInput, siteLonInput, siteAltInput].forEach(inp => {
        if (inp) {
            inp.addEventListener("change", () => {
                updateGlobeVisuals();
                fetchLiveSkyMap();
                fetchTransitingSatellites();
            });
        }
    });

    // ==========================================
    // 3. Sensor Profile Manager
    // ==========================================
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
        updateGlobeVisuals();
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

    // ==========================================
    // 4. Orbit Target & Real-Time Tracking
    // ==========================================
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
                updateGlobeSatellites();
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
                updateGlobeSatellites();
            })
            .catch(err => {
                console.warn("fetchTransitingSatellites error:", err);
            });
    }

    function renderTransitTable(transits) {
        transitTableBody.innerHTML = "";
        if (transits.length === 0) {
            transitTableBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">此時段天區無過境衛星（可點擊上方「🎯 一鍵瞄準最近過境衛星」或在 3D 地球儀上選取目標）</td></tr>`;
            return;
        }

        transits.slice(0, 15).forEach(t => {
            const tr = document.createElement("tr");
            const statusBadge = t.is_in_fov
                ? `<span style="color:#10b981; font-weight:bold;">⚡ 穿透視場中 (0.0°)</span>`
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
                        ${t.is_in_fov ? '設為目標' : '🎯 對齊並設為目標'}
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

                updateGlobeVisuals();
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

                        updateGlobeVisuals();
                        fetchTransitingSatellites();
                        alert(`🎯 望遠鏡已自動對準頭頂上空的「${s.name}」(仰角 ${s.alt_deg}°, 方位 ${s.az_deg}°)，並設定為模擬目標！\n點擊「開始光學影像模擬」即可直接看見！`);
                    } else {
                        alert("當前時刻天空中暫無高仰角衛星，建議點選地球儀自選指向或使用「智慧視場穿透生成」！");
                    }
                })
                .catch(err => {
                    btnPointNearest.textContent = "🎯 一鍵瞄準最近過境衛星";
                    alert(`瞄準失敗: ${err}`);
                });
        });
    }

    // ==========================================
    // 5. 3D Earth Globe Visualizer (Three.js)
    // ==========================================
    let globeScene, globeCamera, globeRenderer, globeControls;
    let earthMesh, siteMarkerGroup, fovFrustumGroup, satMarkersGroup;
    let isGlobeRotating = false;
    let globeInitialized = false;
    const EARTH_RADIUS = 100.0;

    function initEarthGlobe() {
        const container = document.getElementById("earth-globe-container");
        if (!container || globeInitialized) return;

        const w = container.clientWidth || 600;
        const h = container.clientHeight || 450;

        globeScene = new THREE.Scene();
        globeScene.background = new THREE.Color(0x02040a);

        globeCamera = new THREE.PerspectiveCamera(45, w / h, 1, 3000);
        globeCamera.position.set(0, 160, 280);

        globeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        globeRenderer.setSize(w, h);
        globeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.innerHTML = "";
        container.appendChild(globeRenderer.domElement);

        if (THREE.OrbitControls) {
            globeControls = new THREE.OrbitControls(globeCamera, globeRenderer.domElement);
            globeControls.enableDamping = true;
            globeControls.dampingFactor = 0.05;
            globeControls.minDistance = 115;
            globeControls.maxDistance = 800;
            globeControls.autoRotate = false;
            globeControls.autoRotateSpeed = 0.6;
        }

        // Ambient Light
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        globeScene.add(ambientLight);

        // Directional Sun Light
        const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
        sunLight.position.set(300, 200, 200);
        globeScene.add(sunLight);

        // Earth Mesh with Texture
        const sphereGeo = new THREE.SphereGeometry(EARTH_RADIUS, 64, 64);
        const textureLoader = new THREE.TextureLoader();
        textureLoader.load(
            "/static/textures/earth.jpg",
            (texture) => {
                const earthMat = new THREE.MeshStandardMaterial({
                    map: texture,
                    roughness: 0.85,
                    metalness: 0.1
                });
                earthMesh = new THREE.Mesh(sphereGeo, earthMat);
                globeScene.add(earthMesh);
            },
            undefined,
            () => {
                // Fallback procedural Earth if texture fails
                const earthMat = new THREE.MeshStandardMaterial({
                    color: 0x1d4ed8,
                    wireframe: false,
                    roughness: 0.8
                });
                earthMesh = new THREE.Mesh(sphereGeo, earthMat);
                globeScene.add(earthMesh);
            }
        );

        // Subtle Atmosphere glow sphere
        const atmoGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.015, 64, 64);
        const atmoMat = new THREE.MeshBasicMaterial({
            color: 0x38bdf8,
            transparent: true,
            opacity: 0.12,
            side: THREE.BackSide
        });
        const atmoMesh = new THREE.Mesh(atmoGeo, atmoMat);
        globeScene.add(atmoMesh);

        // Groups for dynamic elements
        siteMarkerGroup = new THREE.Group();
        fovFrustumGroup = new THREE.Group();
        satMarkersGroup = new THREE.Group();
        globeScene.add(siteMarkerGroup);
        globeScene.add(fovFrustumGroup);
        globeScene.add(satMarkersGroup);

        // Toolbar Buttons
        const btnFocusSite = document.getElementById("btn-globe-focus-site");
        if (btnFocusSite) {
            btnFocusSite.addEventListener("click", focusGlobeOnSite);
        }

        const btnFocusSat = document.getElementById("btn-globe-focus-sat");
        if (btnFocusSat) {
            btnFocusSat.addEventListener("click", focusGlobeOnTransitingSat);
        }

        const btnToggleRotate = document.getElementById("btn-globe-toggle-rotate");
        if (btnToggleRotate) {
            btnToggleRotate.addEventListener("click", () => {
                isGlobeRotating = !isGlobeRotating;
                if (globeControls) globeControls.autoRotate = isGlobeRotating;
                btnToggleRotate.classList.toggle("active", isGlobeRotating);
            });
        }

        const btnGlobeReset = document.getElementById("btn-globe-reset");
        if (btnGlobeReset) {
            btnGlobeReset.addEventListener("click", () => {
                if (globeControls) {
                    globeControls.reset();
                    globeControls.target.set(0, 0, 0);
                }
                globeCamera.position.set(0, 160, 280);
            });
        }

        // Raycasting for clicking satellites in 3D
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        container.addEventListener("dblclick", (e) => {
            const rect = container.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / container.clientWidth) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / container.clientHeight) * 2 + 1;

            raycaster.setFromCamera(mouse, globeCamera);
            const intersects = raycaster.intersectObjects(satMarkersGroup.children, true);
            if (intersects.length > 0) {
                const hitMesh = intersects[0].object;
                if (hitMesh.userData && hitMesh.userData.satellite) {
                    const sat = hitMesh.userData.satellite;
                    document.getElementById("point-az").value = sat.az_deg;
                    document.getElementById("point-alt").value = sat.alt_deg;
                    document.getElementById("point-ra").value = sat.ra_deg;
                    document.getElementById("point-dec").value = sat.dec_deg;

                    orbitModeSelect.value = "custom_tle";
                    smartOrbitFields.style.display = "none";
                    liveSatFields.style.display = "none";
                    presetTleFields.style.display = "none";
                    customTleFields.style.display = "block";

                    document.getElementById("custom-tle1").value = sat.tle1;
                    document.getElementById("custom-tle2").value = sat.tle2;
                    document.getElementById("target-vmag").value = sat.vmag;

                    updateGlobeVisuals();
                    fetchTransitingSatellites();
                    alert(`🎯 望遠鏡已鎖定衛星「${sat.name}」！\n(方位: ${sat.az_deg}°, 仰角: ${sat.alt_deg}°)\n現在點擊「開始光學影像模擬」即可看見！`);
                }
            }
        });

        globeInitialized = true;
        animateGlobe();
        updateGlobeVisuals();
    }

    function resizeGlobeRenderer() {
        const container = document.getElementById("earth-globe-container");
        if (!container || !globeRenderer || !globeCamera) return;
        const w = container.clientWidth || 600;
        const h = container.clientHeight || 450;
        globeCamera.aspect = w / h;
        globeCamera.updateProjectionMatrix();
        globeRenderer.setSize(w, h);
    }

    window.addEventListener("resize", () => {
        resizeGlobeRenderer();
    });

    function animateGlobe() {
        requestAnimationFrame(animateGlobe);
        if (globeControls) globeControls.update();
        if (globeRenderer && globeScene && globeCamera) {
            globeRenderer.render(globeScene, globeCamera);
        }
    }

    // Convert (lat, lon) in degrees to 3D Cartesian on sphere
    function latLonToVector3(latDeg, lonDeg, radius = EARTH_RADIUS) {
        const phi = (90 - latDeg) * (Math.PI / 180);
        const theta = (lonDeg + 180) * (Math.PI / 180);
        const x = -(radius * Math.sin(phi) * Math.cos(theta));
        const z = radius * Math.sin(phi) * Math.sin(theta);
        const y = radius * Math.cos(phi);
        return new THREE.Vector3(x, y, z);
    }

    // Compute topocentric local tangent coordinate frame (Up, North, East) at site
    function getSiteFrame(latDeg, lonDeg) {
        const sitePos = latLonToVector3(latDeg, lonDeg, EARTH_RADIUS);
        const u = sitePos.clone().normalize(); // Up

        const northPole = new THREE.Vector3(0, 1, 0);
        const northProj = northPole.clone().sub(u.clone().multiplyScalar(northPole.dot(u)));
        const n = northProj.normalize(); // North tangent

        const e = n.clone().cross(u).normalize(); // East tangent
        return { sitePos, u, n, e };
    }

    // Compute pointing vector in 3D world space
    function getTelescopePointingVector(latDeg, lonDeg, azDeg, altDeg) {
        const { sitePos, u, n, e } = getSiteFrame(latDeg, lonDeg);
        const azRad = azDeg * (Math.PI / 180);
        const altRad = altDeg * (Math.PI / 180);

        // Horizontal direction
        const h = n.clone().multiplyScalar(Math.cos(azRad)).add(e.clone().multiplyScalar(Math.sin(azRad))).normalize();
        // Combined with altitude
        const dir = h.clone().multiplyScalar(Math.cos(altRad)).add(u.clone().multiplyScalar(Math.sin(altRad))).normalize();
        return { sitePos, dir, u };
    }

    function updateGlobeVisuals() {
        if (!globeInitialized) return;

        const lat = parseFloat(siteLatInput?.value) || 23.4694;
        const lon = parseFloat(siteLonInput?.value) || 120.8726;
        const az = parseFloat(document.getElementById("point-az")?.value) || 180.0;
        const alt = parseFloat(document.getElementById("point-alt")?.value) || 65.0;

        // 1. Draw Observation Site Pin
        siteMarkerGroup.clear();
        const { sitePos, dir, u } = getTelescopePointingVector(lat, lon, az, alt);

        // Amber Site Sphere
        const pinGeo = new THREE.SphereGeometry(1.8, 16, 16);
        const pinMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
        const pinMesh = new THREE.Mesh(pinGeo, pinMat);
        pinMesh.position.copy(sitePos.clone().multiplyScalar(1.008));
        siteMarkerGroup.add(pinMesh);

        // Site Ring
        const ringGeo = new THREE.RingGeometry(2.5, 3.2, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, side: THREE.DoubleSide });
        const ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.position.copy(sitePos.clone().multiplyScalar(1.002));
        ringMesh.lookAt(sitePos.clone().multiplyScalar(2));
        siteMarkerGroup.add(ringMesh);

        // 2. Draw Telescope FOV Cone Frustum
        fovFrustumGroup.clear();
        const prof = buildCurrentSensorProfile();
        const pixScale = 206265.0 * (prof.detector.pixel_size_um * 1e-6) / prof.optical.focal_length_m;
        const fovW = (prof.detector.width_px * pixScale) / 3600.0;
        const fovH = (prof.detector.height_px * pixScale) / 3600.0;
        const fovRadiusDeg = Math.max(Math.hypot(fovW, fovH) / 2.0, 1.5);
        const coneLength = 75.0;
        const baseRadius = coneLength * Math.tan(fovRadiusDeg * (Math.PI / 180) * 1.5);

        // Center line
        const endPoint = sitePos.clone().add(dir.clone().multiplyScalar(coneLength));
        const lineGeo = new THREE.BufferGeometry().setFromPoints([sitePos, endPoint]);
        const lineMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2 });
        fovFrustumGroup.add(new THREE.Line(lineGeo, lineMat));

        // Conical Frustum Mesh
        const coneGeo = new THREE.ConeGeometry(baseRadius, coneLength, 32, 1, true);
        coneGeo.translate(0, -coneLength / 2, 0);
        coneGeo.rotateX(Math.PI / 2);

        const coneMat = new THREE.MeshBasicMaterial({
            color: 0x38bdf8,
            transparent: true,
            opacity: 0.22,
            side: THREE.DoubleSide
        });
        const coneMesh = new THREE.Mesh(coneGeo, coneMat);
        coneMesh.position.copy(sitePos);
        coneMesh.lookAt(endPoint);
        fovFrustumGroup.add(coneMesh);

        // Outer wireframe cone ring
        const baseRingGeo = new THREE.RingGeometry(baseRadius * 0.96, baseRadius, 32);
        const baseRingMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide });
        const baseRingMesh = new THREE.Mesh(baseRingGeo, baseRingMat);
        baseRingMesh.position.copy(endPoint);
        baseRingMesh.lookAt(sitePos);
        fovFrustumGroup.add(baseRingMesh);

        updateGlobeSatellites();
    }

    function updateGlobeSatellites() {
        if (!globeInitialized || !satMarkersGroup) return;
        satMarkersGroup.clear();

        const lat = parseFloat(siteLatInput?.value) || 23.4694;
        const lon = parseFloat(siteLonInput?.value) || 120.8726;
        const az = parseFloat(document.getElementById("point-az")?.value) || 180.0;
        const alt = parseFloat(document.getElementById("point-alt")?.value) || 65.0;
        const { sitePos, dir } = getTelescopePointingVector(lat, lon, az, alt);

        const prof = buildCurrentSensorProfile();
        const pixScale = 206265.0 * (prof.detector.pixel_size_um * 1e-6) / prof.optical.focal_length_m;
        const fovDeg = Math.max((prof.detector.width_px * pixScale) / 3600.0, 1.5);

        liveSatellites.forEach(sat => {
            const transitMatch = transitingSatellites.find(t => t.name === sat.name);
            const isInFov = transitMatch && transitMatch.is_in_fov;

            // Compute 3D Satellite position from topocentric Az/Alt/Dist
            const satAzRad = sat.az_deg * (Math.PI / 180);
            const satAltRad = Math.max(0, sat.alt_deg) * (Math.PI / 180);
            const { n, e, u } = getSiteFrame(lat, lon);
            const satH = n.clone().multiplyScalar(Math.cos(satAzRad)).add(e.clone().multiplyScalar(Math.sin(satAzRad))).normalize();
            const satDir = satH.clone().multiplyScalar(Math.cos(satAltRad)).add(u.clone().multiplyScalar(Math.sin(satAltRad))).normalize();

            // Distance scaled to Earth radius (LEO ~ 500-1500km corresponds to 8-25 units)
            const distKm = sat.distance_km || 1000.0;
            const distUnits = Math.min(Math.max((distKm / 6378.137) * EARTH_RADIUS, 10), 65);
            const satPos = sitePos.clone().add(satDir.multiplyScalar(distUnits));

            if (isInFov) {
                // Highlighting: Transiting through FOV (pulsing emerald beacon)
                const satGeo = new THREE.SphereGeometry(2.4, 16, 16);
                const satMat = new THREE.MeshBasicMaterial({ color: 0x10b981 });
                const satMesh = new THREE.Mesh(satGeo, satMat);
                satMesh.position.copy(satPos);
                satMesh.userData = { satellite: sat, isTransit: true };
                satMarkersGroup.add(satMesh);

                // Emerald Beacon Ring
                const ringGeo = new THREE.RingGeometry(3.2, 4.4, 32);
                const ringMat = new THREE.MeshBasicMaterial({ color: 0x34d399, side: THREE.DoubleSide });
                const ringMesh = new THREE.Mesh(ringGeo, ringMat);
                ringMesh.position.copy(satPos);
                ringMesh.lookAt(globeCamera.position);
                satMarkersGroup.add(ringMesh);

                // Line connecting from site to satellite
                const rayGeo = new THREE.BufferGeometry().setFromPoints([sitePos, satPos]);
                const rayMat = new THREE.LineBasicMaterial({ color: 0x10b981, linewidth: 2 });
                satMarkersGroup.add(new THREE.Line(rayGeo, rayMat));
            } else {
                // Sleek target satellite point
                const satGeo = new THREE.SphereGeometry(1.2, 12, 12);
                const satMat = new THREE.MeshBasicMaterial({ color: transitMatch ? 0xf59e0b : 0x38bdf8 });
                const satMesh = new THREE.Mesh(satGeo, satMat);
                satMesh.position.copy(satPos);
                satMesh.userData = { satellite: sat, isTransit: false };
                satMarkersGroup.add(satMesh);
            }
        });
    }

    function focusGlobeOnSite() {
        if (!globeControls || !globeCamera) return;
        const lat = parseFloat(siteLatInput?.value) || 23.4694;
        const lon = parseFloat(siteLonInput?.value) || 120.8726;
        const targetPos = latLonToVector3(lat, lon, EARTH_RADIUS);
        const camPos = targetPos.clone().multiplyScalar(2.1);

        smoothMoveCamera(camPos, targetPos);
    }

    function focusGlobeOnTransitingSat() {
        if (!globeControls || !globeCamera) return;
        if (transitingSatellites.length > 0 && transitingSatellites[0].is_in_fov) {
            focusGlobeOnSite();
        } else {
            focusGlobeOnSite();
        }
    }

    function smoothMoveCamera(newPos, newTarget) {
        if (!globeControls || !globeCamera) return;
        let t = 0;
        const startPos = globeCamera.position.clone();
        const startTarget = globeControls.target.clone();

        function step() {
            t += 0.05;
            globeCamera.position.lerpVectors(startPos, newPos, Math.min(t, 1.0));
            globeControls.target.lerpVectors(startTarget, newTarget, Math.min(t, 1.0));
            globeControls.update();
            if (t < 1.0) {
                requestAnimationFrame(step);
            }
        }
        step();
    }

    // ==========================================
    // 6. Image Viewer: Zoom, Pan & Inspector
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
        panX = 0;
        panY = 0;
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

        // Adjust pan to zoom towards mouse position
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

    // ==========================================
    // 7. Clean Annotations & Side Inspector
    // ==========================================
    function getInteractiveObjectsForCurrentFrame() {
        if (!simulationResult) return [];
        const items = [];

        // RSO Targets
        if (simulationResult.targets) {
            simulationResult.targets.forEach(tgt => {
                if (tgt.frame === currentFrameIndex) {
                    items.push({
                        type: "rso",
                        name: tgt.target_name || "RSO Target",
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

        // Stars
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

        // Size overlay canvas exactly 1:1 with detector resolution
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

        // Draw ONLY clean bounding boxes (NO TEXT ON CANVAS)
        items.forEach(item => {
            const isHovered = (hoveredObject && hoveredObject.name === item.name) || (pinnedObject && pinnedObject.name === item.name);

            if (item.type === "rso") {
                // RSO: Cyan Box
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

                // Streak line if elongated
                if (item.start_pixel && item.end_pixel && item.streak_length_px > 1) {
                    ctx.strokeStyle = "#ef4444";
                    ctx.lineWidth = 1.8;
                    ctx.beginPath();
                    ctx.moveTo(item.start_pixel[0], item.start_pixel[1]);
                    ctx.lineTo(item.end_pixel[0], item.end_pixel[1]);
                    ctx.stroke();
                }
            } else {
                // Stars: Emerald Green Box
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
            inspectorStreak.textContent = `${item.size_px ? item.size_px.toFixed(1) : 3} px (點斑光度)`;
        }

        inspectorName.textContent = item.name;
        inspectorPixel.textContent = `(${Math.round(item.x)}, ${Math.round(item.y)})`;
        inspectorRadec.textContent = item.radec ? item.radec : "依相機 WCS 自動校準";
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

    // ==========================================
    // 8. Run Simulation & Native SatSim Execution
    // ==========================================
    function buildFullConfig() {
        const coordRadio = document.querySelector("input[name='coord-frame']:checked");
        const coordFrame = coordRadio ? coordRadio.value : "radec";

        const trackingRadio = document.querySelector("input[name='tracking-mode']:checked");
        const trackingMode = trackingRadio ? trackingRadio.value : "sidereal";

        const orbitMode = orbitModeSelect ? orbitModeSelect.value : "smart_transit";

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
            engine: "satsim",
            use_gpu: useGpu,
            device_id: 0
        };
    }

    btnRunSim.addEventListener("click", () => {
        switchToTab("image");
        let config;
        try {
            config = buildFullConfig();
        } catch (e) {
            alert(`參數設定錯誤: ${e}`);
            return;
        }

        statusText.textContent = "SatSim 原生運算中...";
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
                statusText.textContent = "運算失敗 (Error)";
                statusText.style.color = "var(--danger)";
                alert(`模擬失敗: ${res.error}`);
                return;
            }

            simulationResult = res;
            currentFrameIndex = 0;
            pinnedObject = null;
            hoveredObject = null;
            resetInspectorPanel();

            statusText.textContent = "完成 (Completed)";
            statusText.style.color = "var(--success)";
            statusTime.textContent = `${res.execution_time_s} s`;
            statusDevice.textContent = res.device_info;

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

    function updateFrameView(idx) {
        if (!simulationResult || !simulationResult.png_urls || !simulationResult.png_urls[idx]) return;
        currentFrameIndex = idx;

        simImage.src = simulationResult.png_urls[idx];
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
            if (zoomScale === 1.0 && panX === 0 && panY === 0) {
                zoomFit();
            }
            drawAnnotations();
        };
    }

    // ==========================================
    // 9. Data Catalog & Export
    // ==========================================
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
                    <td>${s.is_streak ? '條紋 (Stare)' : '點斑 (Point)'}</td>
                `;
                tableStarsBody.appendChild(tr);
            });
        } else {
            tableStarsBody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">未偵測到恆星</td></tr>`;
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

    // Stretch Filters
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

    // Initial Setups
    fetchSensors("sony_imx455");
    fetchLiveSkyMap();
    fetchTransitingSatellites();
});
