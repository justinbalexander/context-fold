#!/usr/bin/env bash
# e2e-cache.sh — end-to-end check of prefix-stable folding against a real multi-turn Pi session
# on the free local Lemonade backend.
#
# Prompt-prefix caching is positional: the property that earns cache hits is the folded HEAD of
# the context being byte-identical from one request to the next. That is what this script
# measures directly — provider cache counters are printed from the telemetry sidecar when the
# backend reports them, but the hard assertions are mechanical and deterministic:
#
#   (a) folds fired under a deliberately low CONTEXTFOLD_BUDGET_CAP;
#   (b) with CONTEXTFOLD_PREFIX_STABLE=1, a layer commit is logged and the folded head blocks'
#       substitution text is BYTE-IDENTICAL between turn N and turn N+1 — across separate pi
#       processes on one session, so layer persistence/resume is exercised live;
#   (c) the <dump>.telemetry.json sidecar exists and parses; its hit ratios are printed
#       (informational — meaningful on providers that report cacheRead).
#
# A flag-off control run reports whether the head stayed stable without freezing (it may, while
# keel holds an epoch) — informational only, never a failure.
#
# The flood is an assistant ECHO, not a tool call, so the check does not depend on a small local
# model's tool-calling reliability. Requires the Lemonade server (default control port 13305).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI="${PI_BIN:-$(command -v pi || echo "$HOME/.local/bin/pi")}"
PROVIDER="${E2E_PROVIDER:-lemonade-current}"
MODEL="${E2E_MODEL:-current}"
LEMONADE_EXT="${LEMONADE_EXT:-$REPO/../lemonade-current/index.ts}"
CAP="${E2E_CAP:-1200}"

if [[ ! -x "$PI" ]]; then echo "FAIL: pi binary not found ($PI)"; exit 2; fi
if [[ ! -f "$LEMONADE_EXT" ]]; then echo "FAIL: lemonade extension not found ($LEMONADE_EXT)"; exit 2; fi
if ! curl -sf -m 3 "${LEMONADE_CONTROL_URL:-http://127.0.0.1:13305}/api/v1/models" >/dev/null; then
  echo "SKIP: lemonade server not reachable"; exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-e2e-cache-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# The flood must be ASSISTANT output (user messages are roots and never fold): a generation
# task producing ~200 numbered lines ≈ 2.5k est-tokens against the low cap.
FLOOD_PROMPT="Output the exact lines 'item N: the quick brown fox jumps over the lazy dog' for every N from 1 to 200, one line each, in order, with no other text before or after."

run_session() { # $1=tag $2=prefix_stable
  local tag="$1" stable="$2"
  local sess="$WORK/sessions-$tag" dump="$WORK/dump-$tag.json" sid="cfcache$$$tag"
  mkdir -p "$sess"
  local -a turns=("$FLOOD_PROMPT" "Reply with only the word OK." "Reply with only the word OK again.")
  for n in 1 2 3; do
    # Pinned to keel mode: this script proves the ORIGINAL Stage-2 prefix-stable mechanism
    # (assistant-echo floods; the default ladder masks only observations, so it would
    # correctly refuse to fold this flood). The ladder's live proof is e2e-ladder.sh.
    CONTEXTFOLD_MODE=keel \
    CONTEXTFOLD_L0=0 CONTEXTFOLD_DEBUG=1 CONTEXTFOLD_BUDGET_CAP="$CAP" \
    CONTEXTFOLD_PREFIX_STABLE="$stable" CONTEXTFOLD_DUMP="$dump" \
      "$PI" -p --mode json --session-dir "$sess" --session-id "$sid" \
      -e "$REPO/src/adapters/pi/index.ts" -e "$LEMONADE_EXT" \
      --provider "$PROVIDER" --model "$MODEL" "${turns[$((n - 1))]}" \
      >"$WORK/stdout-$tag-$n.json" 2>"$WORK/stderr-$tag-$n.txt"
    local rc=$?
    cp -f "$dump" "$WORK/view-$tag-$n.json" 2>/dev/null || true
    cp -f "$dump.telemetry.json" "$WORK/telemetry-$tag-$n.json" 2>/dev/null || true
    echo "   [$tag] turn $n exit=$rc  $(grep -oE 'layer [0-9]+ committed \([0-9]+ blocks frozen\)|consolidation: broke layer [0-9]+' "$WORK/stderr-$tag-$n.txt" | head -1)"
    [[ $rc -eq 0 ]] || { echo "FAIL [$tag] pi turn $n exited $rc"; grep -iE 'error|context-fold' "$WORK/stderr-$tag-$n.txt" | head -5; return 1; }
  done
  return 0
}

compare_views() { # $1=tag → prints STABLE_IDS=<n> CHANGED=<n>; exit 0 when all stable
  python3 - "$WORK/view-$1-2.json" "$WORK/view-$1-3.json" <<'PY'
import json, sys

def folded(path):
    out = {}
    for i, m in enumerate(json.load(open(path))):
        c = m.get("content")
        text = "\n".join(b.get("text", "") for b in c if isinstance(b, dict)) if isinstance(c, list) else (c or "")
        if "FOLDED}" in text:
            out[f"{m.get('role')}:{i}:{text.split('FOLDED}')[0]}"] = text
    return out

a, b = folded(sys.argv[1]), folded(sys.argv[2])
shared = set(a) & set(b)
changed = [k for k in shared if a[k] != b[k]]
print(f"STABLE_IDS={len(shared) - len(changed)} CHANGED={len(changed)} ONLY_TURN2={len(set(a) - shared)}")
sys.exit(0 if shared and not changed else 3)
PY
}

fail=0
echo "== prefix-stable run (flag on) =="
run_session on 1 || fail=1

if grep -qE 'layer [0-9]+ committed' "$WORK"/stderr-on-*.txt; then
  echo "PASS (a) folds fired and a frozen layer committed under cap=$CAP"
else
  echo "FAIL (a) no layer commit logged — did folding fire at all?"
  grep -h 'context-fold' "$WORK"/stderr-on-*.txt | head -5
  fail=1
fi

if out="$(compare_views on)"; then
  echo "PASS (b) folded head byte-identical across turns/processes: $out"
else
  echo "FAIL (b) folded head changed between turns with the flag on: ${out:-no folded blocks shared}"
  fail=1
fi

if python3 -c "import json,sys; t=json.load(open(sys.argv[1])); print(f'   telemetry: turns={t[\"turns\"]} hit={t[\"hitRatio\"]} last={t[\"lastHitRatio\"]}')" "$WORK/telemetry-on-3.json" 2>/dev/null; then
  echo "PASS (c) telemetry sidecar written and parses"
else
  echo "FAIL (c) telemetry sidecar missing/corrupt"; fail=1
fi

echo "== control run (flag off, informational) =="
if run_session off 0; then
  if out="$(compare_views off)"; then
    echo "NOTE control head also stable this run ($out) — keel's epoch hold can do that on short sessions"
  else
    echo "NOTE control head changed between turns ($out) — the instability the flag removes"
  fi
fi

if [[ $fail -eq 0 ]]; then echo "== e2e-cache: ALL PASS =="; exit 0; else echo "== e2e-cache: FAIL =="; exit 1; fi
