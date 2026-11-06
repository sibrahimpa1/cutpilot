#!/usr/bin/env sh
set -e
# Fetch the local Whisper model on first start (≈148 MB, kept in the data volume).
if [ "${WHISPER_AUTO_DOWNLOAD:-1}" = "1" ] && [ ! -f "${WHISPER_MODEL:-$DATA_DIR/models/ggml-base.en.bin}" ]; then
  bash /app/scripts/download-whisper-model.sh || echo "Whisper model download failed; transcription will be disabled."
fi
exec "$@"
