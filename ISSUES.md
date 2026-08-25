# Issues

Open items from the 2026-08-25 prompt-construction review run from the
kitbash repo (572 pi sessions scanned). One entry per issue; delete the
entry when it closes and name the closing commit in the message. Fix these
together once kitbash's neoskills changes (ADRs 0010 and 0011) settle,
since the post-compaction contract depends on both.

## C1. Compaction summary carries two trust instructions

`src/core/compact.ts:46-78` says "nothing is paraphrased" and then embeds
up to 4,000 chars of an earlier summary labelled "UNTRUSTED narrative".
One message, two claims about how far to trust it. Pick one framing.

## C2. Post-compaction message has no ordering contract

The summary arrives as a user message ("The conversation history before
this point was compacted…"). neoskills re-sends mode reminders and context
bodies as user-role custom messages at the same position. Compose one
message with a fixed order: summary, then mode bodies, then context
bodies, then reminders. That gives a single thing to keep verbatim and
removes the race between two extensions writing the same slot.

## C3. Folding contract lives only in tool descriptions

context-fold adds no system text; the whole contract is in the
`recall_folded` and `unfold` descriptions, and the sysprompt-editor core
restates it in three guideline bullets. When context-fold is absent, or a
no-op (claude-go keeps sending originals; README lines 148-155), the core
still tells the model about `{#code FOLDED}` pointers it will never see.
Either context-fold owns the guidance (a system fragment it adds when
active) or the core drops its restatement.

## C4. README drift against the code

- "keeping detected risk lines verbatim" applies only to tool results and
  is capped at six lines / 400 chars.
- The first threshold fold also needs a ladder step of savings, which the
  README does not say.
- "reachable through recall_folded" excludes custom, user, and tool-call
  bodies; only `tool_result` and `thinking` are maskable
  (`src/core/policy/fold-ladder.ts:39-40`).

## C5. Hard compaction keeps no skill body

A skill body delivered as a custom message is neither spooled nor indexed;
only bodies read via `read` are recallable. After kitbash makes `read` the
load event (kitbash ISSUES K4) this may resolve itself; confirm and either
close or spool custom-message bodies too.
