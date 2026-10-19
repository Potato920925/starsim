"""Quick launcher for StarSim.
Usage:
    python run_simulator.py             # Start Interactive Web Dashboard at http://127.0.0.1:5000
    python run_simulator.py --cli       # Run default CLI simulation
"""

import sys
import os

# Ensure current directory is in python path
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from starsim.cli import main

if __name__ == "__main__":
    if len(sys.argv) == 1:
        # Default behavior without args: start web dashboard
        from starsim.web.app import start_server
        print("=" * 60)
        print("  StarSim: Starry Sky & RSO Optical Imagery Simulator")
        print("  Launching interactive Web Dashboard...")
        print("  Access in your browser at: http://127.0.0.1:5000")
        print("=" * 60)
        start_server(host="127.0.0.1", port=5000, debug=False)
    else:
        main()
