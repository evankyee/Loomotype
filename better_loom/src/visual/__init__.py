"""
Visual Replacement Module

Handles text and image overlays using FFmpeg.
No frame-by-frame processing - uses FFmpeg's native overlay filter.
"""

from .overlays import OverlayEngine, TextOverlay, ImageOverlay

__all__ = ["OverlayEngine", "TextOverlay", "ImageOverlay"]
