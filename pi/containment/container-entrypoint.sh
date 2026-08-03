#!/usr/bin/env bash
set -euo pipefail

agent_home="${PI_AGENT_DIR:-$HOME/.pi/agent}"
harness_root="${PI_HARNESS_ROOT:-/opt/pi-harness}"
mkdir -p "$agent_home/extensions" "$agent_home/prompts" "$agent_home/skills"
ln -sfn "$harness_root/AGENTS.md" "$agent_home/AGENTS.md"

for kind in extensions prompts skills; do
  for source in "$harness_root/$kind"/*; do
    [[ -e "$source" ]] || continue
    case "$(basename "$source")" in
      co-change-suggest.ts|continuation-nudge.ts) continue ;;
    esac
    ln -sfn "$source" "$agent_home/$kind/$(basename "$source")"
  done
done

exec pi "$@"
