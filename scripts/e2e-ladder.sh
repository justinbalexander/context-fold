#!/usr/bin/env bash
# e2e-ladder.sh — end-to-end proof of the DEFAULT mode (discrete fold ladder) against a real
# Pi session:
#
#   (a) a fold event fires under pressure (layer commit logged) and masks the tool flood;
#   (b) the seed index is emitted: seed-index.jsonl exists in the session spool dir, parses,
#       and carries the planted mid-output identifier + a span whose spool file is readable;
#   (c) the folded head is byte-identical on the next turn (prefix-stable layers);
#   (d) recall works from the masked pointer (agent answers a buried-line question).
#
# The pressure comes from CONTEXTFOLD_BUDGET_CAP (the cap trigger) so the check is independent
# of the live model's real context-window size. The L0 gate is disabled to isolate the ladder.
#
# Model: defaults to gpt-5.6-sol via openai-codex (reliable tool use). Override with
# E2E_PROVIDER / E2E_MODEL. Requires auth for the chosen provider in the active agent dir.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROVIDER="${E2E_PROVIDER:-openai-codex}"
MODEL="${E2E_MODEL:-gpt-5.6-sol}"
PI="${PI_BIN:-$(command -v pi || echo "$HOME/.local/bin/pi")}"
CAP="${E2E_CAP:-3000}"

if [[ ! -x "$PI" ]]; then echo "FAIL: pi binary not found ($PI)"; exit 2; fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-e2e-ladder-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BIGFILE="$WORK/report.log"
SESSIONS="$WORK/sessions"
DUMP="$WORK/outgoing.json"
SID="cfladder$$"
mkdir -p "$SESSIONS"

NEEDLE="LADDER_CAP_LIMIT=73114"
{
  for i in $(seq 1 400); do echo "line $i: routine log output, filler text to add bulk beyond any threshold"; done
  echo "  $NEEDLE assigned to the primary shard"
  for i in $(seq 401 800); do echo "line $i: more routine output continuing on unremarkably"; done
} > "$BIGFILE"

ENV_COMMON=(CONTEXTFOLD_L0=0 CONTEXTFOLD_DEBUG=1 CONTEXTFOLD_BUDGET_CAP="$CAP" CONTEXTFOLD_DUMP="$DUMP")

echo "== turn 1: flood ($PROVIDER/$MODEL, cap=$CAP) =="
env "${ENV_COMMON[@]}" \
  "$PI" -p --mode json --session-dir "$SESSIONS" --session-id "$SID" --provider "$PROVIDER" --model "$MODEL" \
  "Call exec_command exactly once with command cat -- '$BIGFILE' so the complete raw file is returned as one tool result. Do not use wc, grep, sed, head, tail, Python, or any filtering command. Then reply with ONLY the total number of lines in it." \
  >"$WORK/stdout1.json" 2>"$WORK/stderr1.txt"
echo "   exit=$?  $(grep -oE 'layer [0-9]+ committed \([0-9]+ blocks frozen\)' "$WORK/stderr1.txt" | head -1)"
cp -f "$DUMP" "$WORK/view1.json" 2>/dev/null || true

echo "== turn 2: follow-up (same session) =="
rm -f "$BIGFILE" # the spool is now the only copy — recall is the only recovery path
env "${ENV_COMMON[@]}" \
  "$PI" -p --mode json --session-dir "$SESSIONS" --session-id "$SID" --provider "$PROVIDER" --model "$MODEL" \
  "Earlier you read a file that has since been deleted. What exact value is assigned to LADDER_CAP_LIMIT in it? Reply with ONLY that number." \
  >"$WORK/stdout2.json" 2>"$WORK/stderr2.txt"
echo "   exit=$?"
cp -f "$DUMP" "$WORK/view2.json" 2>/dev/null || true

fail=0

# (a) fold event + layer commit
if grep -qE 'layer [0-9]+ committed' "$WORK/stderr1.txt" "$WORK/stderr2.txt"; then
  echo "PASS (a) fold event committed a frozen layer"
else
  echo "FAIL (a) no layer commit logged"; grep -i context-fold "$WORK"/stderr*.txt | head -5; fail=1
fi

# (b) seed index emitted with the planted identifier and a readable span
INDEX="$SESSIONS/spool/$SID/seed-index.jsonl"
if [[ -f "$INDEX" ]]; then
  python3 - "$INDEX" <<'PY'
import json, sys
recs = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ok = bool(recs)
ids = [i for r in recs for i in r.get("identifiers", [])]
if any("LADDER_CAP_LIMIT" in i for i in ids) and any("73114" in i for i in ids):
    print(f"PASS (b) seed index carries the planted identifier ({len(recs)} record(s))")
else:
    print(f"FAIL (b) planted identifier missing from index (ids sample: {ids[:8]})"); ok = False
spans = [s for r in recs for s in r.get("spans", [])]
readable = [s for s in spans if json.load(open(s["log"]["path"]))]
if spans and len(readable) == len(spans):
    print(f"PASS (b) all {len(spans)} span(s) point at readable spool envelopes")
else:
    print(f"FAIL (b) spans missing/unreadable ({len(readable)}/{len(spans)})"); ok = False
sys.exit(0 if ok else 3)
PY
  [[ $? -eq 0 ]] || fail=1
else
  echo "FAIL (b) seed-index.jsonl not written ($INDEX)"; fail=1
fi

# (c) folded head byte-identical across turns
python3 - "$WORK/view1.json" "$WORK/view2.json" <<'PY'
import json, sys
def folded(path):
    out = {}
    for i, m in enumerate(json.load(open(path))):
        c = m.get("content")
        text = "\n".join(b.get("text", "") for b in c if isinstance(b, dict)) if isinstance(c, list) else (c or "")
        if "FOLDED}" in text:
            out[f"{m.get('role')}:{text.split('FOLDED}')[0]}"] = text
    return out
try:
    a, b = folded(sys.argv[1]), folded(sys.argv[2])
except Exception as e:
    print(f"FAIL (c) view dump unreadable: {e}"); sys.exit(3)
shared = set(a) & set(b)
changed = [k for k in shared if a[k] != b[k]]
if shared and not changed:
    print(f"PASS (c) folded head byte-identical across turns ({len(shared)} block(s))")
    sys.exit(0)
print(f"FAIL (c) folded head unstable (shared={len(shared)} changed={len(changed)})"); sys.exit(3)
PY
[[ $? -eq 0 ]] || fail=1

# (d) the buried value came back through recall
if grep -q "73114" "$WORK/stdout2.json"; then
  echo "PASS (d) agent recovered the buried value from the masked pointer"
else
  echo "FAIL (d) buried value not recovered"; fail=1
fi

if [[ $fail -eq 0 ]]; then echo "== e2e-ladder: ALL PASS =="; exit 0; else echo "== e2e-ladder: FAIL =="; exit 1; fi
