# Releasing

The package is publish-ready. What remains are the steps that leave this machine, which is why
they are a checklist rather than a script.

## Before the first publish

1. **Create the public repository.** `package.json` declares
   `https://github.com/Middlewatch/context-fold` in `repository`, `homepage` and `bugs`. That
   repository does not exist yet. Either create it under that name and push this history, or change
   all three fields first — a package whose repository link 404s is worse than one with no link.

   ```bash
   gh repo create Middlewatch/context-fold --public --source=. --remote=origin --push
   ```

2. **Check the name is still free.** It was unclaimed when this was prepared, but names go fast.

   ```bash
   npm view context-fold   # expect: E404
   ```

3. **Log in.** `npm whoami` should print your account; `npm login` if not.

## Every publish

```bash
npm install                # a clean node_modules, so the checks below test what ships
npm run typecheck
npm test                   # prepublishOnly runs both again, but fail early
npm pack --dry-run         # read the file list; nothing from tests/ or scripts/ belongs in it
npm publish --access public
```

`prepublishOnly` runs typecheck and the full suite, so a broken tree cannot be published by
accident.

## What ships

The `files` allowlist in `package.json` is deliberately narrow: `src/`, `docs/`, `DESIGN.md` and
`CHANGELOG.md`, plus the `README.md`, `LICENSE` and `package.json` npm always includes. Tests, the
live e2e scripts, `tsconfig.json` and `vitest.config.ts` stay out — Pi loads the TypeScript source
directly through jiti, so there is no build step and no compiled output to ship.

`tsconfig.json` is excluded on purpose: its `paths` point into this repo's `node_modules`, which
does not exist inside an installed package.

## Dependencies

The package installs **nothing**. Pi bundles `typebox` and `@earendil-works/pi-coding-agent` and
injects them into extensions at runtime, so both are declared as *optional* peer dependencies —
optional so that npm 7+ does not try to install a copy of the whole Pi CLI alongside the extension,
and peers so nobody vendors a second copy that would miss the engine's model registry.

If you add a real runtime dependency, it goes in `dependencies` (Pi runs `npm install --omit=dev`
when installing a package, so `devDependencies` are not available at runtime).

## Verifying the published package

```bash
pi -e npm:context-fold           # one session, no install
CONTEXTFOLD_DEBUG=1 pi -e npm:context-fold
```

With `CONTEXTFOLD_DEBUG=1` each turn prints a one-line fold summary, so you can see the extension
loaded and is folding. `/context-fold` reports status inside a session.

## Live end-to-end checks

`scripts/e2e-*.sh` drive real Pi sessions against a real provider and therefore cost money. They
are not part of `npm test`. Run them against a release candidate when the folding path itself
changed:

```bash
scripts/e2e-ladder.sh   # fold event fires, index emitted, head byte-stable, buried value recalled
scripts/e2e-gate.sh     # L0 gate folds a real flood; agent recovers a buried line via recall
scripts/e2e-resume.sh   # folds survive a session restart
```

Override the provider and model with `E2E_PROVIDER` / `E2E_MODEL`. These scripts were written
against a model with reliable tool use; a weaker model can fail a check for its own reasons rather
than the extension's, so read a failure before believing it.

The full ladder, including check (c) and the wire-level check (e), passes against
`openai-codex/gpt-5.6-sol` (last run 2026-07-30, all five checks green). One known way (c) can fail spuriously: an earlier run against
a local model reported `shared=0`, which is the script finding **no folded block present in both
turns to compare**, not bytes moving — it happens when the agent chooses `unfold` over `recall` in
turn 2, deliberately rendering the block raw and removing it from turn 2's folded set. If (c)
fails that way, compare the two `CONTEXTFOLD_DUMP` views directly and check whether the agent
called `unfold` before concluding the head is unstable. The underlying byte-stability property is
also asserted deterministically in `tests/frozen-layers.test.ts`.

## Versioning

Semver, starting at `0.1.0`. While the major is `0`, treat a change to fold *timing* or to the
seed-index record shape as a minor bump and document it in `CHANGELOG.md` — downstream recall
tooling reads that format.
