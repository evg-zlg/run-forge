#!/usr/bin/env sh
set -eu

IMAGE="${RUNFORGE_IMAGE:-runforge:local}"
REPO_PATH="${1:-$PWD}"
LOG_PATH="${2:?usage: docker-run-safe.sh <repo> <log> <out>}"
OUT_PATH="${3:?usage: docker-run-safe.sh <repo> <log> <out>}"

mkdir -p "$OUT_PATH"

docker run --rm \
  --network none \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -v "$REPO_PATH:/workspace/repo:ro" \
  -v "$LOG_PATH:/workspace/failure.log:ro" \
  -v "$OUT_PATH:/workspace/out:rw" \
  "$IMAGE" triage --repo /workspace/repo --log /workspace/failure.log --out /workspace/out
