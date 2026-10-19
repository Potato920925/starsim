from setuptools import setup, find_packages

setup(
    name="starsim",
    version="1.0.0",
    description="Starry Sky & Space Surveillance Optical Imagery Simulator based on SatSim and GPU Acceleration",
    author="StarSim Team",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "satsim>=0.26.0",
        "astropy>=5.0",
        "skyfield>=1.45",
        "sgp4>=2.20",
        "numpy>=1.21.0",
        "scipy>=1.9.0",
        "matplotlib>=3.5.0",
        "pillow>=9.0.0",
        "flask>=2.0.0",
    ],
    entry_points={
        "console_scripts": [
            "starsim=starsim.cli:main",
        ],
    },
)
