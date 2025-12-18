"""
Command Line Interface

For local development and testing.
"""

import argparse
import json
from pathlib import Path
from loguru import logger

from .models import PersonalizationData, VideoTemplate, VoiceSegment, VisualSegment
from .pipeline import PersonalizationPipeline
from .pipeline.jobs import TemplateManager
from .voice import VoiceClient


def cmd_personalize(args):
    """Run a personalization job."""
    # Load personalization data
    with open(args.data) as f:
        data_dict = json.load(f)

    data = PersonalizationData(**data_dict)

    # Run pipeline
    pipeline = PersonalizationPipeline(lipsync_backend=args.backend)

    try:
        output_url = pipeline.personalize(args.template, data)
        print(f"Output: {output_url}")
    finally:
        pipeline.cleanup()


def cmd_create_template(args):
    """Create a template from a JSON definition."""
    with open(args.config) as f:
        config = json.load(f)

    template = VideoTemplate(
        id=config["id"],
        name=config["name"],
        base_video_path=config["base_video_path"],
        voice_id=config.get("voice_id"),
        voice_segments=[VoiceSegment(**s) for s in config.get("voice_segments", [])],
        visual_segments=[VisualSegment(**s) for s in config.get("visual_segments", [])],
    )

    templates = TemplateManager()
    templates.save_template(template)
    print(f"Template created: {template.id}")


def cmd_clone_voice(args):
    """Clone a voice from audio samples."""
    client = VoiceClient()

    audio_files = args.audio_files
    voice_id = client.clone_voice(args.name, audio_files, args.description)

    print(f"Voice cloned: {voice_id}")
    print("Save this voice_id in your template configuration.")


def cmd_serve(args):
    """Start the API server."""
    import uvicorn
    uvicorn.run(
        "src.api:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


def main():
    parser = argparse.ArgumentParser(
        description="Personalized Video Engine CLI"
    )
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # personalize command
    p = subparsers.add_parser("personalize", help="Run personalization")
    p.add_argument("--template", required=True, help="Template ID")
    p.add_argument("--data", required=True, help="Path to personalization JSON")
    p.add_argument("--backend", default="wav2lip", choices=["wav2lip", "synclabs"])
    p.set_defaults(func=cmd_personalize)

    # create-template command
    p = subparsers.add_parser("create-template", help="Create a template")
    p.add_argument("--config", required=True, help="Path to template JSON")
    p.set_defaults(func=cmd_create_template)

    # clone-voice command
    p = subparsers.add_parser("clone-voice", help="Clone a voice")
    p.add_argument("--name", required=True, help="Voice name")
    p.add_argument("--description", default="Cloned presenter voice")
    p.add_argument("audio_files", nargs="+", help="Audio sample files")
    p.set_defaults(func=cmd_clone_voice)

    # serve command
    p = subparsers.add_parser("serve", help="Start API server")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--reload", action="store_true")
    p.set_defaults(func=cmd_serve)

    args = parser.parse_args()

    if args.command:
        args.func(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
