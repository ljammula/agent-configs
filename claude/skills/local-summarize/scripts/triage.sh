#!/bin/bash
# Triage a large log/output file through the local ai-stack general model
# (port 8081, Qwen3.6-35B-A3B) to flag which sections deserve Claude's
# direct read, instead of Claude reading the whole thing into context.
# Deliberately scoped to triage, not trusted summarization -- a hallucinated
# summary of a stack trace is worse than useless, so this never replaces
# reading the flagged sections yourself.
set -euo pipefail

MODEL_URL="${MODEL_URL:-http://127.0.0.1:8081/v1}"
FILE="${1:-}"

if [[ -z "$FILE" || ! -f "$FILE" ]]; then
  echo "usage: triage.sh <file>" >&2
  exit 1
fi

if ! curl -sf --max-time 2 "$MODEL_URL/models" >/dev/null 2>&1; then
  echo "error: local model not reachable at $MODEL_URL -- read the file directly" >&2
  exit 1
fi

MODEL_ID=$(curl -sf "$MODEL_URL/models" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])')

PROMPT='You are triaging a log/output file for a developer who cannot read
the whole thing right now. Do NOT summarize or paraphrase content. Instead,
scan for: errors, stack traces, failed assertions, warnings, and anomalies
(anything that looks unexpected or out of place). Output a line-number-
referenced list of sections worth reading in full: `lines N-M: why it
matters`. If nothing stands out, output exactly: no notable sections.'

python3 -c '
import json, sys, urllib.error, urllib.request

model_url, model_id, prompt, path = sys.argv[1:5]
with open(path) as f:
    content = f.read()

# Keep the payload bounded -- this is triage, not full-document analysis.
MAX_CHARS = 60000
if len(content) > MAX_CHARS:
    content = content[:MAX_CHARS] + "\n...[truncated, file is larger]"

numbered = "\n".join(f"{i+1}: {line}" for i, line in enumerate(content.splitlines()))

body = json.dumps({
    "model": model_id,
    "temperature": 0.0,
    "messages": [
        {"role": "system", "content": prompt},
        {"role": "user", "content": numbered},
    ],
}).encode()
req = urllib.request.Request(
    f"{model_url}/chat/completions",
    data=body,
    headers={"Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.load(resp)
    print(data["choices"][0]["message"]["content"])
except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError) as e:
    print(f"error: local triage request failed ({e}) -- read the file directly", file=sys.stderr)
    sys.exit(1)
' "$MODEL_URL" "$MODEL_ID" "$PROMPT" "$FILE"
