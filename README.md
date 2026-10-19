# StarSim: 基於 SatSim 與 GPU 加速的高保真星空與空間目標光學圖片模擬器

**StarSim** 是一套專為空間態勢感知（Space Domain Awareness, SDA）與天文光學觀測打造的高保真星空與軌道空間物體（Resident Space Object, RSO）圖像模擬器。系統基於 **SatSim** 規範與 **GPU 頻域張量計算**，支援觀測站點、指向座標、天候大氣效應、時序曝光、感測器物理雜訊模型、自訂感測器 JSON 匯入/匯出，以及 RSO 軌道匯入（TLE / 軌道六根數）與獨家的「智慧型視場穿透生成器」。

---

## 🌟 核心功能特色

1. **🔭 靈活觀測站點 (Observation Site)**：
   - 支援大地座標（緯度、經度、海拔高度）自由設定。
   - 內建全球知名天文台預設（台灣鹿林天文台、塔塔加、夏威夷茂納凱亞、智利帕拉納爾 VLT、美國基特峰等）。
2. **🧭 多座標指向與追蹤模式 (Pointing & Tracking)**：
   - 支援 **赤道座標 (RA, Dec)** 與 **地平座標 (Az, Alt/El)** 自動互轉。
   - 提供三種專業望遠鏡追蹤模式：
     - **恆星追蹤 (Sidereal)**：恆星保持銳利點源，軌道衛星劃出光學亮線條紋 (Streak)。
     - **衛星追蹤 (Rate Track)**：望遠鏡跟隨指定衛星移動，衛星呈點源，背景恆星產生平行反向拖曳條紋。
     - **固定凝視 (Stare)**：望遠鏡地平固定，恆星與衛星皆產生不同速度的光學條紋。
3. **⛅ 天候與大氣效應模型 (Atmosphere & Weather)**：
   - **大氣視寧度 (Atmospheric Seeing)**：計算有效氣團量 $X(z)$ 並進行 Kolmogorov 湍流 Seeing PSF 模糊卷積。
   - **大氣消光 (Airmass Extinction)**：Rozenberg 氣團公式計算星等消光與光子通量衰減。
   - **雲層衰減 (Cloud Cover)**：模擬不同雲量下的天體光子衰減與散射。
   - **天光背景 (Sky Background)**：Bortle 暗空等級 (Class 1~9)、月相散射與曙暮光光害模型。
4. **⏱️ 精確時序與曝光 (Temporal Settings)**：
   - 支援 UTC ISO-8601 開始/結束時間設定。
   - 自訂曝光時間 $t_{exp}$ 與讀出延遲，自動生成時間序列影像。
5. **📷 感測器型號管理 (Sensor JSON Import/Export)**：
   - 內建多款科研級 CCD、高解析 BSI CMOS（如 Sony IMX455、FLI PL16803、Andor iKon-M、CubeSat 酬載）。
   - **完全支援透過 JSON 檔案動態匯入與匯出新感測器型號**，自動計算像元解析力 (arcsec/px) 與視場大小 (FOV)。
6. **🛰️ 軌道匯入與智慧視場穿透生成 (RSO Orbit & Smart Transit)**：
   - 支援 SGP4 兩行軌道要素 (TLE) 解析與傳播。
   - 內建 **智慧型視場穿透生成器 (Smart FOV Transit Generator)**：針對窄視場望遠鏡，能自動推算並生成保證在指定曝光時間內穿過畫面的物理合規軌道。
7. **⚡ 完整感測器物理雜訊管線 (Sensor Noise Physics)**：
   - 光子散粒雜訊 (Poisson Shot Noise)
   - 熱暗電流雜訊 (Dark Current Noise)
   - 讀出電子雜訊 (Gaussian Read Noise)
   - 光電響應不均勻性 (PRNU)
   - 系統增益、偏置底電平 (Bias)、全井容量飽和與 ADC 位元深度量化剪裁。
8. **🌌 真實星表天體測量學 (Star Catalog & Astrometry)**：
   - 內建全天球精選星表（涵蓋數萬顆恆星），採用標準天文切平面 Gnomonic (TAN) 投影。
   - 產出之 FITS 檔案包含完整的 **IAU WCS 標頭**（`CRVAL1/2`, `CRPIX1/2`, `CDELT1/2`, `CTYPE1='RA---TAN'`），可直接於 DS9、AstroImageJ 或 Astrometry.net 解析。
9. **🚀 GPU 加速支援 (GPU Acceleration)**：
   - 整合 SatSim 官方後端與 StarSim 原生 GPU/CUDA 張量渲染引擎，若無 GPU 則無縫回退至多執行緒 CPU。

---

## 🚀 快速上手 (Quick Start)

### 1. 啟動互動式 Web 儀表板

執行專案根目錄的啟動腳本：

```powershell
python run_simulator.py
```

在瀏覽器中開啟 [http://127.0.0.1:5000](http://127.0.0.1:5000) 即可進入直覺的可視化操作介面：
- 調整觀測站點、方向、天候與曝光時間。
- 點選「匯入 JSON」可動態載入任意自訂感測器規格。
- 點選「開始光學影像模擬」，即可即時預覽星空成像、播放多幀序列、切換天文對比度拉伸（Z-Scale / Log / Asinh / Linear），並一鍵下載 FITS 與 PNG 檔案！

---

### 2. 命令列 (CLI) 操作

```powershell
# 檢視可用感測器型號
python -m starsim list-sensors

# 檢視內建天文台站點
python -m starsim list-sites

# 依指定組態檔執行模擬並輸出至 output/
python -m starsim run --config configs/default_sim.json --output output/my_run

# 覆寫感測器與曝光時間
python -m starsim run --sensor data/sensors/fli_proline_16803.json --exposure 5.0 --output output/fli_run
```

---

## 📷 感測器 JSON 規格定義 (Sensor Profile Schema)

您可以編寫任意符合以下格式的 JSON 檔案，並透過 Web 介面或 CLI 載入：

```json
{
  "sensor_id": "custom_cmos_1024",
  "name": "Custom Scientific CMOS 1024",
  "manufacturer": "Custom Optics Lab",
  "description": "科研級背照式 CMOS 規格",
  "optical": {
    "aperture_m": 0.5,
    "focal_length_m": 2.0,
    "filter_band": "V",
    "central_wavelength_nm": 550.0,
    "bandwidth_nm": 100.0
  },
  "detector": {
    "width_px": 1024,
    "height_px": 1024,
    "pixel_size_um": 3.76,
    "bit_depth": 16,
    "full_well_capacity_e": 51000.0,
    "quantum_efficiency": 0.85
  },
  "noise": {
    "read_noise_e": 1.5,
    "dark_current_eps": 0.003,
    "operating_temp_c": -10.0,
    "gain_e_per_adu": 0.78,
    "bias_adu": 100.0,
    "prnu_percent": 0.5,
    "hot_pixel_rate": 0.0001
  }
}
```

---

## 🧪 執行自動化測試 (Automated Tests)

本專案包含完整的單元測試套件，涵蓋感測器、站點座標轉換、大氣消光與 Seeing、SGP4 軌道傳播、星表天體投影、FITS WCS 標頭驗證：

```powershell
python -m pytest tests/ -v
```

---

## 💻 專案架構目錄說明

```
starsim/
├── run_simulator.py                   # 一鍵啟動入口（Web GUI / CLI）
├── setup.py                           # 套件安裝設定
├── requirements.txt                   # 依賴清單
├── configs/
│   ├── default_sim.json               # 預設模擬組態
│   └── satsim_template.json          # SatSim 模板
├── data/
│   ├── sensors/                       # 感測器型號 JSON 範例庫
│   │   ├── sony_imx455.json           # Sony 61MP 全幅天文 CMOS
│   │   ├── fli_proline_16803.json     # FLI 16MP 科研天文 CCD
│   │   ├── andor_ikon_m934.json       # 背照式高靈敏度 CCD
│   │   └── cubesat_imx296.json        # 立方衛星微型光學酬載
│   ├── stars/
│   │   └── star_catalog_bsc5.csv      # 內建全天球亮星星表
│   └── sites/
│       └── observatories.json         # 內建天文台座標資料庫
├── starsim/
│   ├── __init__.py
│   ├── __main__.py                    # CLI 模組入口
│   ├── config.py                      # 整合型參數模型
│   ├── sensor.py                      # 感測器資料模型、JSON 匯入/匯出與校驗
│   ├── site.py                        # 地面站點、天球與地平座標轉換
│   ├── pointing.py                    # 望遠鏡指向、追蹤模式 (Sidereal / Rate / Stare)
│   ├── atmosphere.py                  # 大氣消光、氣團量計算、Seeing PSF 模糊、天光背景
│   ├── orbit.py                       # TLE 解析、SGP4 傳播、智慧 FOV 穿透生成器
│   ├── stars.py                       # 星表載入、TAN 切平面天體投影 (WCS)、星等-光子數換算
│   ├── engine/
│   │   ├── base.py                    # 抽象引擎介面
│   │   ├── satsim_bridge.py          # SatSim CLI / API 轉換與呼叫橋接
│   │   └── gpu_renderer.py            # PyTorch CUDA / NumPy 高性能影像合成渲染器
│   ├── io.py                          # FITS 產生器 (含完整 WCS 標頭)、PNG 轉換、標註匯出
│   ├── cli.py                         # 命令列操作介面
│   └── web/                           # 現代化互動式 Web 儀表板
│       ├── app.py                     # Flask 後端 API 服務
│       ├── templates/index.html       # 單頁應用 Web 儀表板
│       └── static/                    # 前端 CSS 樣式與互動 JS
└── tests/                             # 單元測試集 (14 項測試全數通過)
```

---

## 📄 License
MIT License
