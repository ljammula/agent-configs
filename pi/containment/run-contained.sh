#!/usr/bin/env bash
set -euo pipefail

workspace="${1:?usage: run-contained.sh WORKSPACE [pi arguments...]}"
shift
workspace="$(cd "$workspace" && pwd -P)"
case "$workspace" in
  /|"$HOME"|/Users|/Users/*/code) echo "refusing broad workspace mount: $workspace" >&2; exit 2 ;;
esac

image="${PI_SANDBOX_IMAGE:-pi-harness:0.83.0}"
agent_volume="${PI_SANDBOX_AGENT_VOLUME:-pi-harness-agent-home}"

exec docker run --rm -i \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=512 \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  --network=none \
  --mount "type=bind,src=$workspace,dst=/workspace,rw" \
  --mount "type=volume,src=$agent_volume,dst=/home/pi/.pi/agent,rw" \
  "$image" "$@"
