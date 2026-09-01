#!/usr/bin/env bash
# e2e-compact-resume.sh — the ledger route survives hard compaction AND a restart.
#
# Run 1 reads a large file under a low deterministic fold cap (fold event), then reads a second
# large file; that second read's first delivery is always raw, and a project-level settings.json
# shrinks Pi's compaction headroom so the raw delivery pushes provider usage over the between-turn
# threshold and fires REAL hard compaction (answered by our det summary). Run 2 RESUMES the
# session and asks for a phrase buried in the FOLDED first file. We assert:
#   (a) run 1 hard-compacted through the deterministic summary;
#   (b) the resume restored fold entries and frozen layers;
#   (c) the agent recovers the buried phrase — recall re-locates the bytes in Pi's session
#       ledger, since the source file is deleted and no other copy exists;
#   (d) no spool/ directory exists anywhere; the seed index lives under context-fold/<sid>/.
#
# Model defaults to gpt-5.6-sol (openai-codex). Override with E2E_PROVIDER / E2E_MODEL.
# E2E_WINDOW must match the model's context window (default 1050000 for gpt-5.6-sol);
# compaction triggers when contextTokens > window - reserveTokens, so reserveTokens is set to
# window - 5000. Project-level settings are ignored for untrusted directories, so the compaction
# override rides in a TEMP AGENT DIR (PI_CODING_AGENT_DIR) that copies the real auth/models.
# No `set -e`: every check below accumulates into $fail so one failure still reports the rest.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$REPO/src/adapters/pi/index.ts"
PROVIDER="${E2E_PROVIDER:-openai-codex}"
MODEL="${E2E_MODEL:-gpt-5.6-sol}"
WINDOW="${E2E_WINDOW:-1050000}"
PI="${PI_BIN:-$(command -v pi || echo "$HOME/.local/bin/pi")}"
[[ -x "$PI" ]] || { echo "FAIL: pi binary not found ($PI)"; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-compact-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BIGFILE="$WORK/report.log"; BIGFILE2="$WORK/second.log"; SESS="$WORK/sessions"; AGENT="$WORK/agent"
mkdir -p "$SESS" "$AGENT"

# Temp agent dir: real credentials + model registry, plus the compaction override as GLOBAL
# settings (project settings would be ignored: the temp workdir is untrusted).
REAL_AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
for f in auth.json models.json; do [[ -f "$REAL_AGENT/$f" ]] && cp "$REAL_AGENT/$f" "$AGENT/$f"; done
export PI_CODING_AGENT_DIR="$AGENT"
SID="cfcompact$$"
TOKEN="FINDME_HC4"; PHRASE="periwinkle-astrolabe-7"
{
  for i in $(seq 1 400); do echo "line $i: routine log output, unremarkable filler to exceed the fold threshold"; done
  echo "$TOKEN the phrase you want is $PHRASE and nothing more on this line"
  for i in $(seq 401 800); do echo "line $i: more routine filler continuing unremarkably along"; done
} > "$BIGFILE"
for i in $(seq 1 800); do echo "entry $i: secondary log content, also unremarkable, padding the raw first delivery"; done > "$BIGFILE2"

# Compaction threshold at ~5k tokens, keep only ~1k recent, so the big reads leave live history
# at the cut.
cat > "$AGENT/settings.json" <<JSON
{ "compaction": { "enabled": true, "reserveTokens": $((WINDOW - 5000)), "keepRecentTokens": 1000 } }
JSON

echo "== run 1: read + fold + hard compaction ($PROVIDER/$MODEL), session=$SID =="
( cd "$WORK" && CONTEXTFOLD_BUDGET_CAP="${E2E_CAP:-3000}" CONTEXTFOLD_DEBUG=1 \
  "$PI" -p --mode json -ne -e "$EXT" --session-dir "$SESS" --session-id "$SID" --provider "$PROVIDER" --model "$MODEL" \
  "Use the read tool to read the entire file at $BIGFILE in one call. Then use the read tool to read the entire file at $BIGFILE2 in one call. Then make a SEPARATE bash tool call that runs printf checkpoint-one. Then reply with ONLY the total number of lines in the first file." \
  >"$WORK/stdout1.json" 2>"$WORK/stderr1.txt" )
echo "   run 1 exit=$?"

fail=0

# (a) hard compaction happened, through the det summary
if grep -q 'det compaction:.*summarized deterministically' "$WORK/stderr1.txt"; then
  echo "PASS (a) $(grep -o 'det compaction:.*' "$WORK/stderr1.txt" | head -1)"
else
  echo "FAIL (a) no deterministic hard compaction in run 1"
  grep -i 'context-fold' "$WORK/stderr1.txt" | head -5
  echo "== e2e-compact-resume: FAIL (no compaction — later checks would not test the claim) =="
  exit 1
fi

# The source files are gone: run 2 can only answer from Pi's session ledger.
rm -f "$BIGFILE" "$BIGFILE2"

echo "== run 2: resume after compaction, recall the buried phrase =="
( cd "$WORK" && CONTEXTFOLD_BUDGET_CAP="${E2E_CAP:-3000}" CONTEXTFOLD_DEBUG=1 \
  "$PI" -p --mode json -ne -e "$EXT" --session-dir "$SESS" --session-id "$SID" --provider "$PROVIDER" --model "$MODEL" \
  "Earlier you read a file that has since been deleted. Use the recall_folded tool (try search=$TOKEN) to find the single phrase that appears immediately after the token $TOKEN on its line. Reply with ONLY that phrase." \
  >"$WORK/stdout2.json" 2>"$WORK/stderr2.txt" )
echo "   run 2 exit=$?"

# (b) resume restored fold state
if grep -qE 'resume: restored [1-9][0-9]* fold entries' "$WORK/stderr2.txt"; then
  echo "PASS (b) $(grep -o 'resume: restored.*' "$WORK/stderr2.txt" | head -1)"
else
  echo "FAIL (b) no restored fold state in run 2 stderr"; grep -i 'context-fold' "$WORK/stderr2.txt" | head -3; fail=1
fi

# (c) recall answered from the ledger
if grep -qF "$PHRASE" "$WORK/stdout2.json"; then
  echo "PASS (c) agent recovered '$PHRASE' from the session ledger after compaction + restart"
else
  echo "FAIL (c) answer did not contain '$PHRASE'"; fail=1
fi

# (d) deletion is total: no spool anywhere, seed index in context-fold/<sid>/
if [[ ! -e "$SESS/spool" ]] && ! find "$WORK" -type d -name spool | grep -q .; then
  echo "PASS (d1) no spool/ directory anywhere"
else
  echo "FAIL (d1) a spool/ directory exists"; fail=1
fi
if [[ -f "$SESS/context-fold/$SID/seed-index.jsonl" ]]; then
  echo "PASS (d2) seed index at context-fold/$SID/seed-index.jsonl"
else
  echo "FAIL (d2) seed index not found under $SESS/context-fold/$SID/"; fail=1
fi

if [[ $fail -eq 0 ]]; then echo "== e2e-compact-resume: ALL PASS =="; exit 0; else echo "== e2e-compact-resume: FAIL =="; exit 1; fi
