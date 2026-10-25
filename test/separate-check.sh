#!/usr/bin/env bash
# Mirrors the SEP pipeline in src/extension.ts so it can be checked from a terminal.
#   ./test/separate-check.sh <song> <from-sec> <to-sec> [out-dir]
set -euo pipefail

song="$1"
from="$2"
to="$3"
dest="${4:-}"

work="$(mktemp -d "${TMPDIR:-/tmp}/myvsc-sep.XXXXXX")"
trap 'echo "work: $work"' EXIT

echo "== slicing $from - $to"
time ffmpeg -hide_banner -loglevel error -y \
  -ss "$from" -to "$to" -i "$song" -vn -ac 2 -ar 44100 "$work/region.wav"

echo "== demucs ${DEMUCS_DEVICE:+-d $DEMUCS_DEVICE}"
time demucs ${DEMUCS_DEVICE:+-d "$DEMUCS_DEVICE"} -n htdemucs -o "$work/out" "$work/region.wav"

echo "== stems"
find "$work/out" -name '*.wav' -type f | sort | while read -r f; do
  printf '%8s  %s\n' "$(du -h "$f" | cut -f1)" "$(basename "$f")"
done

if [ -n "$dest" ]; then
  mkdir -p "$dest"
  find "$work/out" -name '*.wav' -type f | sort | while read -r f; do
    cp "$f" "$dest/"
  done
  echo "== copied to $dest"
  ls -1 "$dest"
fi
