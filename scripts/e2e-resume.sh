#!/usr/bin/env bash
# e2e-resume.sh — fold state survives a restart.
#
# Run 1 reads a large file under a low deterministic budget cap, causing a ladder fold. Run 2
# RESUMES the same session id and asks a question about a buried line. We assert:
#   (a) the resume restored spool entries and frozen layers;
#   (b) the prior read still renders as a pointer in run 2's outgoing view (restore worked — without
#       it the result would come back raw);
#   (c) the pointer resolves — the agent recovers the buried phrase via recall.
#
# Model defaults to gpt-5.6-sol (openai-codex). Override with E2E_PROVIDER / E2E_MODEL.
# Requires auth for the chosen provider in the active agent dir.
# No `set -e`: every check below accumulates into $fail so one failure still reports
# the rest. Errors are surfaced explicitly, never swallowed silently.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Load THIS working copy explicitly and disable extension discovery, so the run tests the source
# in this repo rather than whatever happens to be deployed in the caller's agent dir.
EXT="$REPO/src/adapters/pi/index.ts"
PROVIDER="${E2E_PROVIDER:-openai-codex}"
MODEL="${E2E_MODEL:-gpt-5.6-sol}"
PI="${PI_BIN:-$(command -v pi || echo "$HOME/.local/bin/pi")}"
[[ -x "$PI" ]] || { echo "FAIL: pi binary not found ($PI)"; exit 2; }
command -v python3 >/dev/null || { echo "FAIL: python3 is required by this script but was not found"; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-resume-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BIGFILE="$WORK/report.log"; SESS="$WORK/sessions"; DUMP="$WORK/outgoing2.json"; mkdir -p "$SESS"
SID="cfresume$$"
TOKEN="FINDME_RS9"; PHRASE="marmalade-outrigger-5"
{
  for i in $(seq 1 400); do echo "line $i: routine log output, unremarkable filler to exceed the fold threshold"; done
  echo "$TOKEN the phrase you want is $PHRASE and nothing more on this line"
  for i in $(seq 401 800); do echo "line $i: more routine filler continuing unremarkably along"; done
} > "$BIGFILE"

echo "== run 1: read + fold ($PROVIDER/$MODEL), session=$SID =="
CONTEXTFOLD_BUDGET_CAP="${E2E_CAP:-3000}" CONTEXTFOLD_DEBUG=1 \
  "$PI" -p --mode json -ne -e "$EXT" --session-dir "$SESS" --session-id "$SID" --provider "$PROVIDER" --model "$MODEL" \
  "Use the read tool to read the entire file at $BIGFILE in one call. After reading it, make a SEPARATE bash tool call that runs printf context-fold-checkpoint. Then reply with ONLY the total number of lines in the file." \
  >"$WORK/stdout1.json" 2>"$WORK/stderr1.txt"
RUN1_RC=$? # capture immediately: any later command (including an assignment) overwrites $?
FOLDLINE="$(grep -oE 'layer [0-9]+ committed \([0-9]+ blocks frozen\)' "$WORK/stderr1.txt" | head -1)"
echo "   run 1 exit=$RUN1_RC — ${FOLDLINE:-NO FOLD}"
[[ $RUN1_RC -eq 0 ]] || echo "   NOTE: run 1 exited $RUN1_RC"
if [[ -z "$FOLDLINE" ]]; then
  echo "FAIL (pre) ladder never folded in run 1 — the agent may have routed around the requested full read"
  echo "== e2e-resume: FAIL =="; exit 1
fi

# Delete the source file: run 2 can only answer through the restored fold's spool.
rm -f "$BIGFILE"

echo "== run 2: resume same session, recall a buried line =="
CONTEXTFOLD_BUDGET_CAP="${E2E_CAP:-3000}" CONTEXTFOLD_DEBUG=1 CONTEXTFOLD_DUMP="$DUMP" \
  "$PI" -p --mode json -ne -e "$EXT" --session-dir "$SESS" --session-id "$SID" --provider "$PROVIDER" --model "$MODEL" \
  "Earlier you read a file. Tell me the single phrase that appears immediately after the token $TOKEN on its line. Reply with ONLY that phrase." \
  >"$WORK/stdout2.json" 2>"$WORK/stderr2.txt"
echo "   run 2 exit=$?"

fail=0

# (a) restore happened
if grep -qE 'resume: restored [1-9][0-9]* spool entries, [0-9]+ unfolds, [1-9][0-9]* layers' "$WORK/stderr2.txt"; then
  echo "PASS (a) resume restored fold state: $(grep -oE 'resume: restored [0-9]+ spool entries, [0-9]+ unfolds, [0-9]+ layers[^\\]*' "$WORK/stderr2.txt" | head -1)"
else
  echo "FAIL (a) no restored spool/layer state in run 2 stderr"; grep -i 'context-fold' "$WORK/stderr2.txt" | head -3; fail=1
fi

# (b) the prior read still renders folded in run 2's view
if [[ -f "$DUMP" ]] && python3 - "$DUMP" <<'PY'
import json, sys
msgs = json.load(open(sys.argv[1]))
def text_of(m):
    c = m.get("content");
    return "\n".join(b.get("text","") for b in c if isinstance(b,dict)) if isinstance(c,list) else (c or "")
folded = [m for m in msgs if m.get("role")=="toolResult" and "FOLDED}" in text_of(m)]
sys.exit(0 if folded else 1)
PY
then
  echo "PASS (b) restored session renders the prior read as a pointer"
else
  echo "FAIL (b) prior read did not render folded after resume"; fail=1
fi

# (c) the restored pointer resolves via recall
if grep -qF "$PHRASE" "$WORK/stdout2.json"; then
  echo "PASS (c) agent recovered the buried phrase '$PHRASE' from the restored spool"
else
  echo "FAIL (c) answer did not contain '$PHRASE'"; fail=1
fi

if [[ $fail -eq 0 ]]; then echo "== e2e-resume: ALL PASS =="; exit 0; else echo "== e2e-resume: FAIL =="; exit 1; fi
