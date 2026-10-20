"""Compatibility alias for SatSimBridgeEngine.
Custom GPU renderer has been retired in favor of native SatSim engine.
"""

from .satsim_bridge import SatSimBridgeEngine

class GPURendererEngine(SatSimBridgeEngine):
    """Backward compatibility wrapper delegating directly to SatSim native engine."""
    pass
