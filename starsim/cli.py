"""Command-line interface for StarSim.
Usage:
    python -m starsim run --config configs/default_sim.json --output output/
    python -m starsim serve --port 5000
    python -m starsim list-sensors
    python -m starsim list-sites
"""

from __future__ import annotations
import argparse
import sys
import os
import json

from .config import StarSimConfig, SimulationEngine
from .sensor import list_available_sensors, load_sensor
from .site import list_preset_observatories
from .engine.gpu_renderer import GPURendererEngine
from .engine.satsim_bridge import SatSimBridgeEngine
from .io import save_simulation_artifacts


def main():
    parser = argparse.ArgumentParser(description="StarSim: Starry Sky & Space Surveillance Imagery Simulator")
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # Command: run
    run_parser = subparsers.add_parser("run", help="Run a simulation from config file or options")
    run_parser.add_argument("--config", "-c", type=str, default=None, help="Path to StarSim JSON config")
    run_parser.add_argument("--sensor", "-s", type=str, default=None, help="Sensor ID or path to sensor JSON")
    run_parser.add_argument("--output", "-o", type=str, default="./output", help="Output directory")
    run_parser.add_argument("--exposure", "-e", type=float, default=None, help="Exposure time in seconds")
    run_parser.add_argument("--engine", type=str, choices=["gpu", "satsim"], default=None, help="Simulation engine")
    run_parser.add_argument("--frames", "-n", type=int, default=None, help="Number of frames")

    # Command: serve
    serve_parser = subparsers.add_parser("serve", help="Launch interactive Web GUI dashboard")
    serve_parser.add_argument("--host", type=str, default="127.0.0.1", help="Host interface to bind")
    serve_parser.add_argument("--port", "-p", type=int, default=5000, help="Port to listen on")
    serve_parser.add_argument("--debug", action="store_true", help="Run in debug mode")

    # Command: list-sensors
    subparsers.add_parser("list-sensors", help="List available sensor profiles")

    # Command: list-sites
    subparsers.add_parser("list-sites", help="List pre-configured observatory sites")

    args = parser.parse_args()

    if args.command == "list-sensors":
        sensors = list_available_sensors()
        print("\n=== Available Sensor Profiles ===")
        for s in sensors:
            print(f"- {s['sensor_id']:<20} | {s['name']} ({s['pixel_scale']}, FOV {s['fov']})")
        print()
        return

    if args.command == "list-sites":
        sites = list_preset_observatories()
        print("\n=== Pre-configured Observatory Sites ===")
        for key, site in sites.items():
            print(f"- {key:<15} | {site.name:<32} (Lat: {site.lat_deg:7.3f}°, Lon: {site.lon_deg:8.3f}°, Alt: {site.alt_m:5.0f}m)")
        print()
        return

    if args.command == "serve":
        from .web.app import start_server
        print(f"Starting StarSim Web Dashboard at http://{args.host}:{args.port}")
        start_server(host=args.host, port=args.port, debug=args.debug)
        return

    if args.command == "run":
        if args.config and os.path.isfile(args.config):
            config = StarSimConfig.from_json(args.config)
        else:
            config = StarSimConfig()

        if args.sensor:
            config.sensor = load_sensor(args.sensor)
        if args.output:
            config.output_dir = args.output
        if args.exposure:
            config.exposure_time_s = args.exposure
        if args.engine:
            config.engine = SimulationEngine(args.engine)

        print(f"\n[StarSim] Running simulation...")
        print(f"  Sensor: {config.sensor.name} ({config.sensor.detector.width_px}x{config.sensor.detector.height_px})")
        print(f"  Site: {config.site.name} (Lat {config.site.lat_deg}°, Lon {config.site.lon_deg}°)")
        print(f"  Pointing: Frame {config.pointing.coord_frame}, Tracking: {config.pointing.tracking_mode.value}")
        print(f"  Exposure: {config.exposure_time_s}s, Frames: {config.num_frames}")
        print(f"  Engine: {config.engine.value}")

        if config.engine == SimulationEngine.SATSIM:
            engine = SatSimBridgeEngine()
        else:
            engine = GPURendererEngine()

        result = engine.run(config)
        artifacts = save_simulation_artifacts(result, config.output_dir)

        print(f"\n[StarSim] Simulation completed in {result.execution_time_s:.2f}s using {result.device_info}")
        print(f"  FITS files: {len(artifacts['fits'])}")
        print(f"  PNG files: {len(artifacts['png'])}")
        print(f"  Output folder: {os.path.abspath(config.output_dir)}")
        print()
        return

    parser.print_help()


if __name__ == "__main__":
    main()
