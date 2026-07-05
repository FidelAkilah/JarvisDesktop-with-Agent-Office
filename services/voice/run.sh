#!/bin/sh
# JARVIS voice loop launcher. The agent service must be running first
# (cd ../agent && npm run dev).
cd "$(dirname "$0")" || exit 1
UV="${UV:-$HOME/.local/bin/uv}"
command -v uv >/dev/null 2>&1 && UV=uv
exec "$UV" run python -m jarvis_voice "$@"
