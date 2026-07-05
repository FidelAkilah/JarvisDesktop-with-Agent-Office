import argparse

from . import pipeline


def main() -> None:
    ap = argparse.ArgumentParser(description="JARVIS voice loop (Phase 1 CLI)")
    ap.add_argument("--input", help="audio file to replay instead of the mic (testing)")
    ap.add_argument("--no-speak", action="store_true", help="don't play TTS out loud")
    ap.add_argument("--once", action="store_true", help="exit after one interaction")
    args = ap.parse_args()

    source = None
    if args.input:
        from .audio import FileSource

        source = FileSource(args.input)

    result = pipeline.run(
        source=source, speak_replies=not args.no_speak, once=args.once
    )
    if args.once and result:
        heard, reply = result
        print(f"\n[once] heard={heard!r}\n[once] reply={reply!r}")


if __name__ == "__main__":
    main()
