"""Flask Web server and REST API for StarSim interactive dashboard.
"""

from __future__ import annotations
import os
import json
import zipfile
import tempfile
from io import BytesIO
from typing import Dict, Any
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory

from ..config import StarSimConfig, SimulationEngine
from ..sensor import list_available_sensors, load_sensor, SensorProfile, get_default_sensor_dir
from ..site import list_preset_observatories, ObservationSite
from ..pointing import PointingDirection, TrackingMode
from ..atmosphere import AtmosphericConditions
from ..orbit import TargetOrbit, OrbitMode, POPULAR_TLES
from ..engine.gpu_renderer import GPURendererEngine
from ..engine.satsim_bridge import SatSimBridgeEngine
from ..io import save_simulation_artifacts, apply_contrast_stretch


def create_app(output_dir: str = "./output") -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config["OUTPUT_DIR"] = os.path.abspath(output_dir)
    os.makedirs(app.config["OUTPUT_DIR"], exist_ok=True)

    gpu_engine = GPURendererEngine()
    satsim_engine = SatSimBridgeEngine()

    @app.route("/")
    def index():
        return render_template("index.html")

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
            # Optionally save to data/sensors
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

    @app.route("/api/simulate", methods=["POST"])
    def run_simulation():
        try:
            req_data = request.get_json(force=True)
            config = StarSimConfig.from_dict(req_data)
            config.output_dir = os.path.join(app.config["OUTPUT_DIR"], "web_run")

            # Choose engine
            if config.engine == SimulationEngine.SATSIM:
                engine = satsim_engine
            else:
                engine = gpu_engine

            result = engine.run(config)
            artifacts = save_simulation_artifacts(result, config.output_dir)

            # Build relative URLs for frontend display
            png_urls = [f"/output/web_run/{os.path.basename(p)}" for p in artifacts["png"]]
            fits_urls = [f"/output/web_run/{os.path.basename(p)}" for p in artifacts["fits"]]

            return jsonify({
                "success": True,
                "execution_time_s": result.execution_time_s,
                "device_info": result.device_info,
                "num_frames": len(result.frames),
                "png_urls": png_urls,
                "fits_urls": fits_urls,
                "stars_count": len(result.stars_projected),
                "stars": result.stars_projected[:50],  # first 50 stars for inspect
                "targets": result.targets_projected,
                "config": config.to_dict()
            })
        except Exception as e:
            import traceback
            traceback.print_exc()
            return jsonify({"error": str(e)}), 500

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
            download_name="starsim_simulation_results.zip"
        )

    return app


def start_server(host: str = "127.0.0.1", port: int = 5000, debug: bool = False, output_dir: str = "./output"):
    app = create_app(output_dir)
    app.run(host=host, port=port, debug=debug)
