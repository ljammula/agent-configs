#!/bin/bash
# Pipe a diff to the local ai-stack code model (port 8080, Qwen3.6-27B) for
# an adversarial second opinion before commit/PR. Output is evidence for
# Claude to triage, never an authoritative finding list -- this model
# self-corrects mechanical mistakes but not logic bugs, so it can *notice*
# things (off-by-ones, missed null checks, an unhandled branch) without
# being trusted to be right about them. Shared by before-done and
# self-review; referenced from both by absolute path.
set -euo pipefail

MODEL_URL="${MODEL_URL:-http://127.0.0.1:8080/v1}"

if ! curl -sf --max-time 2 "$MODEL_URL/models" >/dev/null 2>&1; then
  echo "error: local model not reachable at $MODEL_URL -- skip local review" >&2
  exit 1
fi

MODEL_ID=$(curl -sf "$MODEL_URL/models" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])')

PROMPT='Review this diff for correctness bugs only: logic errors, missed edge
cases, error-handling gaps, off-by-ones, concurrency issues. Do not comment
on style, formatting, naming, or suggest refactors. List each finding as a
single line: `file:line - issue`. If you find nothing, output exactly:
no findings.'

# Diff comes in on stdin, not argv -- a git diff can exceed the OS ARG_MAX
# (1MB on macOS) well before it exceeds the model's context window.
python3 -c '
import json, sys, urllib.error, urllib.request

model_url, model_id, prompt = sys.argv[1:4]
diff = sys.stdin.read()

MAX_CHARS = 60000
if len(diff) > MAX_CHARS:
    diff = diff[:MAX_CHARS] + "\n...[truncated, diff is larger]"

body = json.dumps({
    "model": model_id,
    "temperature": 0.0,
    "messages": [
        {"role": "system", "content": prompt},
        {"role": "user", "content": diff},
    ],
}).encode()
req = urllib.request.Request(
    f"{model_url}/chat/completions",
    data=body,
    headers={"Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.load(resp)
    print(data["choices"][0]["message"]["content"])
except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError) as e:
    print(f"error: local review request failed ({e}) -- skip local review", file=sys.stderr)
    sys.exit(1)
' "$MODEL_URL" "$MODEL_ID" "$PROMPT"
