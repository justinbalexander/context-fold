#!/usr/bin/env bash
# Offline Pi TUI check: cancel a stale-session prompt with an image, edit, then approve.
# Approved input reaches a throwing fixture provider; no network request is made.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI="${PI_BIN:-$(command -v pi)}"
command -v tmux >/dev/null
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-warning-check-XXXXXX")"
SOCKET="cf-warning-check-$$"
trap 'tmux -L "$SOCKET" kill-server 2>/dev/null || true' EXIT
mkdir -p "$WORK/agent"
echo "Artifacts: $WORK"
node --input-type=module - "$WORK" <<'JS'
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
const work = process.argv[2];
const timestamp = new Date(Date.now() - 31 * 60_000).toISOString();
const entries = [
  { type: 'session', version: 3, id: 'offline-warning', timestamp, cwd: work },
  { type: 'model_change', id: 'model', parentId: null, timestamp, provider: 'cache-warning-check', modelId: 'fixture' },
  { type: 'message', id: 'user', parentId: 'model', timestamp, message: { role: 'user', content: 'Previous task', timestamp: Date.parse(timestamp) } },
  { type: 'message', id: 'answer', parentId: 'user', timestamp, message: {
    role: 'assistant', content: [{ type: 'text', text: 'Previous answer' }], provider: 'cache-warning-check', model: 'fixture',
    api: 'openai-completions', stopReason: 'stop', timestamp: Date.parse(timestamp),
    usage: { input: 84000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 85000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } },
];
writeFileSync(`${work}/session.jsonl`, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
const chunk = (type, data) => {
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
writeFileSync(`${work}/image.png`, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0)),
]));
JS
printf -v CMD '%q ' env PI_OFFLINE=1 PI_CODING_AGENT_DIR="$WORK/agent" CF_WARNING_CHECK_LOG="$WORK/events.jsonl" \
  CONTEXTFOLD=1 CONTEXTFOLD_CONFIRM_COLD_PROMPT=on CONTEXTFOLD_CACHE_IDLE_MINUTES=30 \
  "$PI" --no-extensions --no-skills --no-prompt-templates --no-themes \
  -e "$REPO/scripts/fixtures/cache-warning.ts" --session "$WORK/session.jsonl" \
  --provider cache-warning-check --model fixture "@$WORK/image.png" 'inspect original'
tmux -L "$SOCKET" new-session -d -s check -x 48 -y 32 -c "$WORK" "$CMD; sleep 30"
wait_screen() {
  local needle="$1" file="$2"
  for ((i=0; i<100; i++)); do
    tmux -L "$SOCKET" capture-pane -p -t check > "$file"
    if grep -qF "$needle" "$file"; then return; fi
    sleep 0.1
  done
  cat "$file"
  echo "FAIL: screen did not contain '$needle'" >&2
  exit 1
}
wait_screen 'Keep draft' "$WORK/confirmation.txt"
if grep -q '"accepted"' "$WORK/events.jsonl"; then echo 'FAIL: prompt passed before approval'; exit 1; fi
tmux -L "$SOCKET" send-keys -t check Escape
wait_screen 'inspect original' "$WORK/cancelled.txt"
if grep -q '"accepted"' "$WORK/events.jsonl"; then echo 'FAIL: cancellation sent the prompt'; exit 1; fi
tmux -L "$SOCKET" send-keys -t check C-c
tmux -L "$SOCKET" send-keys -l -t check 'edited draft'
tmux -L "$SOCKET" send-keys -t check Enter
wait_screen 'Keep draft' "$WORK/confirmation-edited.txt"
tmux -L "$SOCKET" send-keys -t check Down Enter
for ((i=0; i<100; i++)); do
  if grep -q '"provider"' "$WORK/events.jsonl"; then break; fi
  sleep 0.1
done
tmux -L "$SOCKET" capture-pane -p -t check > "$WORK/approved.txt"
node --input-type=module - "$WORK" <<'JS'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const work = process.argv[2];
const events = readFileSync(`${work}/events.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
const requests = events.filter(e => e.provider);
assert.equal(requests.length, 1, 'Send anyway must reach the offline provider exactly once');
const userMessage = requests[0].provider.messages.filter(m => m.role === 'user').at(-1);
assert.equal(userMessage.content.find(c => c.type === 'text').text, 'edited draft');
assert.equal(userMessage.content.find(c => c.type === 'image').data, readFileSync(`${work}/image.png`).toString('base64'));
const accepted = events.filter(e => e.accepted);
assert.equal(accepted.length, 1);
assert.equal(accepted[0].accepted.text, 'edited draft');
assert.equal(accepted[0].accepted.images.length, 1);
assert.equal(accepted[0].accepted.images[0].data, readFileSync(`${work}/image.png`).toString('base64'));
assert.equal(accepted[0].accepted.images[0].mimeType, 'image/png');
const screen = readFileSync(`${work}/cancelled.txt`, 'utf8');
assert.ok(screen.includes('inspect original'));
assert.ok(screen.includes('image(s) kept'));
console.log('PASS: 48-column Pi confirmation, cancel/edit/image roundtrip through provider boundary, zero network requests');
JS
