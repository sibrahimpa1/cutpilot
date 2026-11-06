#!/usr/bin/env bash
# Downloads a whisper.cpp GGML model for local transcription (default: base.en, ~148 MB).
set -euo pipefail
MODEL="${1:-base.en}"
DIR="${DATA_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data}/models"
mkdir -p "$DIR"
OUT="$DIR/ggml-$MODEL.bin"
if [ -f "$OUT" ]; then echo "Model already present: $OUT"; exit 0; fi
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
echo "Downloading $URL"
curl -L --fail --progress-bar -o "$OUT.part" "$URL"
mv "$OUT.part" "$OUT"
echo "Saved $OUT"
