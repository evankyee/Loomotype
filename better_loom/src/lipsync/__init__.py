"""
Lip-Sync Module

Uses Sync Labs API for production-ready lip synchronization.
"""

from .synclabs import (
    SyncLabsClient,
    LipSyncEngine,
    LipSyncResult,
    SyncLabsError,
    get_lipsync_engine,
    lipsync_segment,
)

__all__ = [
    "SyncLabsClient",
    "LipSyncEngine",
    "LipSyncResult",
    "SyncLabsError",
    "get_lipsync_engine",
    "lipsync_segment",
]
