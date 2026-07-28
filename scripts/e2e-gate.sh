#!/usr/bin/env bash
# e2e-gate.sh — end-to-end proof of the L0 ingestion gate against a real Pi session.
#
# Drives a headless Pi run that reads a large on-disk file, then asserts:
#   (a) the gate fired  — stderr carries an `l0-fold #<code> tool=<reader> <in>→<out>` line;
#   (b) ground truth kept — the session jsonl still contains the raw payload marker (observe-only);
#   (c) the view folded  — the next-turn outgoing view (CONTEXTFOLD_DUMP) has the pointer, not the
#       buried payload marker.
#
# Phase 2 extends this (see the recall block, enabled once P2.2 lands): after the fold, a second
# prompt makes the agent answer a buried-line question via recall grep/lines.
#
# Model: defaults to gpt-5.6-sol via the openai-codex provider (reliable tool use). Override with
# E2E_PROVIDER / E2E_MODEL. Requires auth for the chosen provider in the active agent dir.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROVIDER="${E2E_PROVIDER:-openai-codex}"
MODEL="${E2E_MODEL:-gpt-5.6-sol}"
PI="${PI_BIN:-${WILLOW_BIN:-$(command -v pi || echo "$HOME/.local/bin/pi")}}"

if [[ ! -x "$PI" ]]; then echo "FAIL: pi binary not found ($PI)"; exit 2; fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-e2e-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BIGFILE="$WORK/report.log"
SESSIONS="$WORK/sessions"
DUMP="$WORK/outgoing.json"
STDERR="$WORK/stderr.txt"
mkdir -p "$SESSIONS"

# ~40KB / ~800 lines (over the 2000-tok fold threshold, under the read tool's 50KB/2000-line cap).
MARKER="MARKER_C0FFEE_the_buried_answer_is_8931"
{
  for i in $(seq 1 400); do echo "line $i: routine log output, nothing notable here, just filler text to add bulk"; done
  echo "$MARKER"
  for i in $(seq 401 800); do echo "line $i: more routine log output continuing on with unremarkable detail"; done
} > "$BIGFILE"

PROMPT="Call exec_command exactly once with command cat -- '$BIGFILE' so the complete raw file is returned as one tool result. Do not use wc, grep, sed, head, tail, Python, or any filtering command. Then reply with ONLY the total number of lines in it."

echo "== driving pi ($PROVIDER/$MODEL) — reading a ~$(du -k "$BIGFILE" | cut -f1)KB file =="
CONTEXTFOLD_L0="${CONTEXTFOLD_L0:-1}" CONTEXTFOLD_DEBUG=1 CONTEXTFOLD_DUMP="$DUMP" \
  "$PI" -p --mode json --session-dir "$SESSIONS" --provider "$PROVIDER" --model "$MODEL" "$PROMPT" \
  >"$WORK/stdout.json" 2>"$STDERR"
RC=$?
echo "   pi exit=$RC"

fail=0
[[ $RC -eq 0 ]] || { echo "FAIL pi run exited $RC"; fail=1; }

# (a) the gate fired. Stock Pi may expose the file read as `read` or route it through the
# environment's shell tool (`exec_command` historically, `exec` since pi 0.80.x); all exercise
# the same text-result ingestion boundary.
FOLD_RE='l0-fold #[0-9a-z]{6} tool=(read|exec_command|exec) [0-9]+→[0-9]+'
if grep -qE "$FOLD_RE" "$STDERR"; then
  echo "PASS (a) gate fired: $(grep -oE "$FOLD_RE" "$STDERR" | head -1)"
else
  echo "FAIL (a) no l0-fold reader line on stderr"; grep -i 'context-fold\|error' "$STDERR" | head -5; fail=1
fi

# (b) ground truth: the raw payload survives verbatim in the session jsonl
if grep -rqF "$MARKER" "$SESSIONS"; then
  echo "PASS (b) raw payload marker present in session jsonl (observe-only kept ground truth)"
else
  echo "FAIL (b) marker missing from session jsonl"; fail=1
fi

# (c) the folded TOOL RESULT block carries the pointer, not the payload. (We check the tool_result
# block specifically — the model is free to quote a line in its own reasoning/text; that is not the
# gate's concern. The gate's guarantee is that the big RESULT was replaced by a pointer in the view.)
if [[ -f "$DUMP" ]]; then
  python3 - "$DUMP" "$MARKER" <<'PY'
import json, sys
msgs = json.load(open(sys.argv[1])); marker = sys.argv[2]
results = [m for m in msgs if m.get("role") == "toolResult"]
def text_of(m):
    c = m.get("content")
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict))
    return c if isinstance(c, str) else ""
folded = [m for m in results if "FOLDED}" in text_of(m) and "recall #" in text_of(m)]
# The gate's guarantee covers results it folds — i.e. results OVER the fold threshold. A small
# result quoting the marker (the model grep-echoing despite instructions) is model behavior,
# not a gate leak. 2000 est-tokens ≈ 8000 chars (the default CONTEXTFOLD_L0_THRESHOLD).
leaked = [m for m in results if marker in text_of(m) and len(text_of(m)) > 8000]
ok = True
if folded:
    print(f"PASS (c) {len(folded)}/{len(results)} tool_result block(s) rendered as a pointer with a recall handle")
else:
    print(f"FAIL (c) no tool_result block folded to a pointer (results={len(results)})"); ok = False
if leaked:
    print(f"FAIL (c) over-threshold result still carries the raw payload marker ({len(leaked)})"); ok = False
else:
    print("PASS (c) no over-threshold tool_result still carries the raw payload marker")
sys.exit(0 if ok else 3)
PY
  [[ $? -eq 0 ]] || fail=1
else
  echo "FAIL (c) no dump file written"; fail=1
fi

# ── Phase 2: recall a buried line the pointer does not carry (P2.2) ────────────
# Two calls on ONE session: call 1 forces the flood through the read tool; the file is then
# DELETED, so on call 2 the spool is the only place the answer exists — the agent must recall.
# (A single-call version let the agent bash-grep the still-on-disk file and skip recall entirely.)
if [[ "${E2E_PHASE2:-1}" == "1" ]]; then
  echo "== Phase 2: buried-line recall =="
  P2FILE="$WORK/report2.log"; P2SESS="$WORK/sessions2"; mkdir -p "$P2SESS"
  P2SID="cfgate$$"
  PHRASE="banana-hammock-7"; TOKEN="FINDME_XR7"
  {
    for i in $(seq 1 400); do echo "line $i: routine log output, nothing notable, filler for bulk to exceed the fold threshold"; done
    echo "$TOKEN the phrase you want is $PHRASE and nothing else on this line"
    for i in $(seq 401 800); do echo "line $i: more routine filler continuing along unremarkably"; done
  } > "$P2FILE"
  CONTEXTFOLD_L0="${CONTEXTFOLD_L0:-1}" CONTEXTFOLD_DEBUG=1 \
    "$PI" -p --mode json --session-dir "$P2SESS" --session-id "$P2SID" --provider "$PROVIDER" --model "$MODEL" \
    "Call exec_command exactly once with command cat -- '$P2FILE' so the complete raw file is returned as one tool result. Do not use wc, grep, sed, head, tail, Python, or any filtering command. Then reply with ONLY the total number of lines in it." \
    >"$WORK/stdout2a.json" 2>"$WORK/stderr2a.txt"
  P2_READ_RC=$?
  P2_FOLD="$(grep -oE "$FOLD_RE" "$WORK/stderr2a.txt" | head -1)"
  echo "   pi read-call exit=$P2_READ_RC  $P2_FOLD"
  if [[ $P2_READ_RC -ne 0 || -z "$P2_FOLD" ]]; then
    echo "FAIL (d) setup call did not produce a born-folded full-file result"
    grep -i 'context-fold\|error' "$WORK/stderr2a.txt" | head -5
    fail=1
  fi
  rm -f "$P2FILE" # the spool is now the only copy — recall is the only recovery path
  CONTEXTFOLD_L0="${CONTEXTFOLD_L0:-1}" CONTEXTFOLD_DEBUG=1 \
    "$PI" -p --mode json --session-dir "$P2SESS" --session-id "$P2SID" --provider "$PROVIDER" --model "$MODEL" \
    "Earlier you read a file that has since been deleted from disk. Tell me the single word/phrase that appears immediately after the token $TOKEN on its line. Reply with ONLY that phrase." \
    >"$WORK/stdout2.json" 2>"$WORK/stderr2.txt"
  echo "   pi recall-call exit=$?"

  if grep -rqiE '"(name|tool|toolName)"\s*:\s*"recall"' "$P2SESS" "$WORK/stdout2.json" 2>/dev/null; then
    echo "PASS (d) agent issued a recall call"
    if grep -rqiE 'grep|lines' "$P2SESS"/*/*.jsonl 2>/dev/null || grep -qiE '"(grep|lines)"' "$WORK/stdout2.json"; then
      echo "PASS (d) recall used partial retrieval (grep/lines)"
    else
      echo "NOTE (d) recall issued but grep/lines param not detected in trace (may have used full recall)"
    fi
  else
    echo "FAIL (d) no recall call found in the trace"; fail=1
  fi

  if grep -qF "$PHRASE" "$WORK/stdout2.json"; then
    echo "PASS (e) agent answered with the buried phrase '$PHRASE' (recovered via recall)"
  else
    echo "FAIL (e) answer did not contain the buried phrase '$PHRASE'"; fail=1
  fi
fi

if [[ $fail -eq 0 ]]; then echo "== e2e-gate: ALL PASS =="; exit 0; else echo "== e2e-gate: FAIL =="; exit 1; fi
