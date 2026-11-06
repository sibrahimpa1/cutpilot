#!/usr/bin/env bash
# Builds the README showcase media from rendered CutPilot videos.
# Usage: scripts/make-showcase.sh <cinematic-16x9.mp4> <narrated-9x16.mp4>
set -euo pipefail
CIN="$1"
NAR="$2"
OUT="$(cd "$(dirname "$0")/.." && pwd)/docs/showcase"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) Cinematic GIF: ~7 s of highlights (three shots), 600 px wide.
ffmpeg -v error -y \
  -ss 6.6 -t 2.4 -i "$CIN" -ss 14.6 -t 2.4 -i "$CIN" -ss 19 -t 2.4 -i "$CIN" \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0,fps=10,scale=600:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  "$OUT/cinematic.gif"

# 2) Six-shot frame grid (one frame from the middle of every shot), 1920 px wide.
i=0
for t in 3.0 7.9 11.8 15.7 20.1 24.5; do
  ffmpeg -v error -y -ss "$t" -i "$CIN" -frames:v 1 -vf scale=640:-2 "$TMP/f$i.png"
  i=$((i + 1))
done
ffmpeg -v error -y -i "$TMP/f0.png" -i "$TMP/f1.png" -i "$TMP/f2.png" -i "$TMP/f3.png" -i "$TMP/f4.png" -i "$TMP/f5.png" \
  -filter_complex "[0][1][2]hstack=3[top];[3][4][5]hstack=3[bot];[top][bot]vstack" -q:v 3 "$OUT/cinematic-shots.jpg"

# 3) Narrated vertical GIF: ~5.5 s with voice-led captions, 260 px wide.
ffmpeg -v error -y -ss 9.5 -t 5.5 -i "$NAR" \
  -vf "fps=10,scale=260:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  "$OUT/narrated-9x16.gif"

# 4) Vertical frame strip.
i=0
for t in 4.8 13.15 21.5 29.88 38.15 46.2; do
  ffmpeg -v error -y -ss "$t" -i "$NAR" -frames:v 1 -vf scale=320:-2 "$TMP/n$i.png"
  i=$((i + 1))
done
ffmpeg -v error -y -i "$TMP/n0.png" -i "$TMP/n1.png" -i "$TMP/n2.png" -i "$TMP/n3.png" -i "$TMP/n4.png" -i "$TMP/n5.png" \
  -filter_complex "hstack=6" -q:v 3 "$OUT/narrated-shots.jpg"

ls -la "$OUT"
