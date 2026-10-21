"""Flask Web server and REST API for SatSim Native GUI dashboard.
Directly interfaces with Air Force Research Laboratory (AFRL) SatSim 0.26 engine.
"""

from __future__ import annotations
import os
import json
import zipfile
import tempfile
import time
import glob
from io import BytesIO
from typing import Dict, Any
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory

from ..config import StarSimConfig, SimulationEngine
from ..sensor import list_available_sensors, load_sensor, SensorProfile, get_default_sensor_dir
from ..site import list_preset_observatories, ObservationSite
from ..pointing import PointingDirection, TrackingMode
from ..atmosphere import AtmosphericConditions
from ..orbit import TargetOrbit, OrbitMode, POPULAR_TLES
from ..engine.satsim_bridge import SatSimBridgeEngine
from ..io import save_simulation_artifacts


def create_app(output_dir: str = "./output") -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config["OUTPUT_DIR"] = os.path.abspath(output_dir)
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    app.config["TEMPLATES_AUTO_RELOAD"] = True
    os.makedirs(app.config["OUTPUT_DIR"], exist_ok=True)

    satsim_engine = SatSimBridgeEngine()

    @app.after_request
    def add_cache_control(response):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    @app.route("/")
    def index():
        return render_template("index.html", version=int(time.time()))

    @app.route("/api/satsim/templates", methods=["GET"])
    def get_satsim_templates():
        """Return official native SatSim 0.26 JSON templates."""
        return jsonify(SatSimBridgeEngine.get_default_templates())

    @app.route("/api/satsim/generate_config", methods=["POST"])
    def generate_satsim_config():
        """Translate frontend form parameters into native SatSim 0.26 JSON configuration."""
        try:
            req_data = request.get_json(force=True)
            config = StarSimConfig.from_dict(req_data)
            ssp = satsim_engine.build_satsim_config(config)
            return jsonify({"success": True, "satsim_config": ssp})
        except Exception as e:
            return jsonify({"error": str(e)}), 400

    @app.route("/api/satsim/run", methods=["POST"])
    @app.route("/api/simulate", methods=["POST"])
    def run_satsim():
        """Run native SatSim simulation directly from either form parameters or raw SatSim JSON."""
        try:
            req_data = request.get_json(force=True)
            run_output_dir = os.path.join(app.config["OUTPUT_DIR"], "web_run")
            os.makedirs(run_output_dir, exist_ok=True)
            for old_f in glob.glob(os.path.join(run_output_dir, "frame_*.*")):
                try:
                    os.remove(old_f)
                except Exception:
                    pass

            # Case A: User supplied raw native SatSim JSON
            if "satsim_json" in req_data or "version" in req_data or "sim" in req_data:
                ssp = req_data.get("satsim_json", req_data)
                use_gpu = bool(req_data.get("use_gpu", True))
                device_id = int(req_data.get("device_id", 0))

                result = satsim_engine.run_raw(ssp, run_output_dir, use_gpu=use_gpu, device_id=device_id)
            else:
                # Case B: Standard form parameters
                config = StarSimConfig.from_dict(req_data)
                config.output_dir = run_output_dir
                result = satsim_engine.run(config)

            # Generate PNG preview images and CSV artifacts
            artifacts = save_simulation_artifacts(result, run_output_dir)

            # Build relative URLs for frontend display
            png_urls = [f"/output/web_run/{os.path.basename(p)}" for p in artifacts["png"]]
            fits_urls = [f"/output/web_run/{os.path.basename(p)}" for p in artifacts["fits"]]
            csv_urls = [f"/output/web_run/{os.path.basename(p)}" for p in artifacts.get("csv", [])]

            # SatNet annotation JSON files
            satnet_json_files = []
            satsim_run_dir = os.path.join(run_output_dir, "satsim_run")
            if os.path.exists(satsim_run_dir):
                for root, _, files in os.walk(satsim_run_dir):
                    for file in sorted(files):
                        if file.endswith(".json") and file.startswith("sat_"):
                            rel_p = os.path.relpath(os.path.join(root, file), run_output_dir).replace(os.sep, '/')
                            satnet_json_files.append(f"/output/web_run/{rel_p}")

            return jsonify({
                "success": True,
                "execution_time_s": result.execution_time_s,
                "device_info": result.device_info,
                "num_frames": len(result.frames),
                "png_urls": png_urls,
                "fits_urls": fits_urls,
                "csv_urls": csv_urls,
                "satnet_json_urls": satnet_json_files,
                "stars_count": len(result.stars_projected),
                "stars": result.stars_projected,
                "targets": result.targets_projected,
                "log_output": getattr(result, "log_output", ""),
                "satsim_config": result.config if isinstance(result.config, dict) else satsim_engine.build_satsim_config(result.config)
            })
        except Exception as e:
            import traceback
            traceback.print_exc()
            return jsonify({"error": str(e)}), 500

    @app.route("/api/sites", methods=["GET"])
    def get_sites():
        presets = list_preset_observatories()
        return jsonify({key: site.to_dict() for key, site in presets.items()})

    @app.route("/api/sensors", methods=["GET"])
    def get_sensors():
        return jsonify(list_available_sensors())

    @app.route("/api/sensor/<sensor_id>", methods=["GET"])
    def get_sensor_profile(sensor_id):
        try:
            profile = load_sensor(sensor_id)
            return jsonify(profile.to_dict())
        except Exception as e:
            return jsonify({"error": str(e)}), 404

    @app.route("/api/sensor/upload", methods=["POST"])
    def upload_sensor():
        """Upload custom sensor JSON file."""
        if "file" not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
        file = request.files["file"]
        if file.filename == "":
            return jsonify({"error": "Empty filename"}), 400

        try:
            content = file.read().decode("utf-8")
            data = json.loads(content)
            profile = SensorProfile.from_dict(data)
            save_path = os.path.join(get_default_sensor_dir(), f"{profile.sensor_id}.json")
            profile.to_json(save_path)
            return jsonify({
                "message": f"Sensor '{profile.name}' imported successfully",
                "profile": profile.to_dict()
            })
        except Exception as e:
            return jsonify({"error": f"Invalid sensor JSON: {str(e)}"}), 400

    @app.route("/api/tles", methods=["GET"])
    def get_tle_presets():
        return jsonify(POPULAR_TLES)

    @app.route("/output/<path:filename>")
    def serve_output(filename):
        return send_from_directory(app.config["OUTPUT_DIR"], filename)

    @app.route("/api/download/all", methods=["GET"])
    def download_all_zip():
        """Package all outputs into a ZIP archive for download."""
        web_run_dir = os.path.join(app.config["OUTPUT_DIR"], "web_run")
        if not os.path.isdir(web_run_dir):
            return jsonify({"error": "No simulation results found"}), 404

        memory_file = BytesIO()
        with zipfile.ZipFile(memory_file, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, _, files in os.walk(web_run_dir):
                for file in files:
                    full_p = os.path.join(root, file)
                    rel_p = os.path.relpath(full_p, web_run_dir)
                    zf.write(full_p, arcname=rel_p)

        memory_file.seek(0)
        return send_file(
            memory_file,
            mimetype="application/zip",
            as_attachment=True,
            download_name="satsim_simulation_results.zip"
        )

    return app


def start_server(host: str = "0.0.0.0", port: int = 5000, debug: bool = False, output_dir: str = "./output"):
    """Start Flask server for SatSim Native GUI."""
    app = create_app(output_dir=output_dir)
    app.run(host=host, port=port, debug=debug)

