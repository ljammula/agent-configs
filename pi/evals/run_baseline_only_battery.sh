#!/bin/bash
set -u
ROOT=/Users/kanna/code/agent-configs/pi/evals/battery-results/2026-08-20-seed20260802-baseline-only
mkdir -p "$ROOT"
cd /Users/kanna/code/agent-configs/pi/evals
for pair in 1 2 3 4 5 6 7 8 9; do
  echo "=== starting pair $pair ($(date)) ===" | tee -a "$ROOT/driver.log"
  python3 run_single_arm.py --seed 20260802 --pair "$pair" --arm baseline \
    --host kannasmacstudio.lan \
    --output "$ROOT/pair$pair" \
    2>&1 | tee -a "$ROOT/driver.log"
done
echo "=== ALL PAIRS DONE ($(date)) ===" | tee -a "$ROOT/driver.log"
