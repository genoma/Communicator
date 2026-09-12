# Surface cleanup (4.0.0) — execution plan

The approved direction for the "too many one-shots" complaint: remove the bare "set a preference
and exit" dispatch and the generation/export knobs that duplicate the image REPL, replacing every
lost capability with an in-app setter **before** anything is removed.

**Status: completed in 4.0.0** (tag `4.0.0`, pushed, CI green on macOS/Ubuntu/Windows). Branch: `feat/surface-cleanup`, cut from
`main` at tag `3.49.2`.
How to use: stages are ordered and each ends with a green gate plus one commit. Tick the boxes as
they land. Do not start a stage before the previous one is green.

Owner confirmations (recorded 2026-09-12): **E1 approved as designed** (a bare non-prompt flag
opens a chat); **O26 closure approved** — `--seed` stays `--image`-only and the item closes as
documented behavior (the alternative resurrects the silent-no-op class); **Stage 2 as written**
(the five image knobs go; the image REPL commands and their persisted defaults stay).

Landed: Stage 1 (`8104f5f` `/safe-mode`, `49b6d6e` export-format persistence + `/export-format`,
`851e0e6` review fixes) — gate 1854/1854, lint and knip clean. Stage 2 (`900cd7d` the five image
sizing flags removed; the image-session channel and its persisted defaults are the in-app path) —
gate 1851/1851, lint and knip clean. Stage 3 (`--budget` removed with the standing pref; the
resolver/constraint errors that only the image session can trigger lost their flag prefix, the
owner-approved naming fix) — gate 1850/1850, lint and knip clean. Stage 4 (the set-and-exit
`config-set.js` dispatch, its two call sites, the four predicates and the `--output-dir` bare form
are gone; `budget` left `applyPreferenceUpdates`; docs/backlog swept) — gate 1821/1821, lint and
knip clean. Stage 5 (the O1/O31/O15/O26 strikes with provenance F37, the F29/O16 clause refresh,
MEMORY's completed status and the `exportFormat` contract) — gate 1822/1822, lint and knip clean.
Stage 6 (4.0.0 bump + changelog, fast-forward into `main`, tag pushed, CI green on all three
platforms, branch deleted).

Baseline at plan time: `npm test` 1842/1842, `npm run lint`, `npx knip` clean, CI green on
macOS/Ubuntu/Windows for `3.49.2`.

## Owner decisions (resolved)

- **D1 — standing budget: dropped.** `/budget` stays session-only; no standing-budget command. The
  standing `prefs.budget` default goes with `--budget`.
- **D2 — export directory: no command.** `--export --output-dir <path>` already persists
  `prefs.outputDir` (`src/cli-main.js:248` reads it, `:253-259` writes it back). The bare
  `--output-dir` form goes; `--output-dir` then requires `--export` or `--image`.
- **D3 — export format: stays, persists, gains a command.** `--export-format` never had a bare
  setter (validation requires `--export`), it just never persisted. An export run will persist
  `prefs.exportFormat`, later `--export` runs read it, and `/export-format markdown|jsonl` sets it
  in chat (parity rule: every pref needs an in-app setter).
- **D4 — explicit pixels: dropped.** `--width`/`--height` go with no `/size` replacement. Sizing
  is capability-driven (aspect list or pixel-model divisor; the 4.0.0-era snapshot read roughly
  34 aspect-list + 8 pixel across the then-41 Venice image models, divisors 8/16 plus
  `bria-bg-remover`'s 1 — live on 2026-09-12 the catalog was 41: 33 aspect-list, 7 pixel-divisor
  (8 or 16), 1 utility).
- **D5 — budget flag: removed entirely.** "Budget goes and stays in chat": the `--budget` flag and
  the `prefs.budget` fallback in `resolveSessionFlags` both go; `/budget <usd>` is the single cap
  path; a resume still restores the session's own cap from its payload.
- **D6 — safe mode: command approved.** `/safe-mode on|off` in the image REPL (Venice only,
  mirroring `/watermark`), persisting `prefs.safeMode` on every change.
- **D7 — `--config` view: stays.** Family-1 inspector (bare prints the default config; a path
  selects a prefs file for the run), outside the setter dispatch.

## Scope

### Removed
- Flags: `--variants`, `--resolution`, `--quality`, `--width`, `--height`, `--budget`.
- The bare set-and-exit dispatch: `src/commands/config-set.js`, its two call sites in
  `src/cli-main.js`, and `isConfigSetDispatch` / `isPureConfigSetter` / `hasConfigSetterFlags` /
  `isConfigSetter` in `src/cli-validation.js`.
- The "bare use saves the default" meaning of `-m`, `--temperature`, `--top-p`, `--reasoning-effort`,
  `--web-search`, `--web-results`, `--smooth-speed`, `--no-smooth-streaming`, `--compact-thinking`,
  `--no-watermark`, `--no-safe-mode`, `--aspect-ratio`, `--image-format`, `--output-dir`.

### Added
- `/safe-mode on|off` (image REPL, Venice only) — persists `prefs.safeMode` (D6).
- `/export-format markdown|jsonl` (text chat) + `prefs.exportFormat` (D3); an
  `--export --export-format <fmt>` run also persists it.
- `ChatState.webResultsExplicit`-style explicitness where needed for the new writers.

### Unchanged (must not regress)
- `--seed` (run flag) and the image REPL commands `/variants`, `/resolution`, `/quality`,
  `/format`, `/aspect`, `/seed`, `/watermark` — the REPL keeps persisting its per-provider
  defaults, and those defaults still reach `--image`/`-m <image-model>` runs.
- `--aspect-ratio` / `--image-format` run forms (persist per-provider, F24) and their notices.
- `--no-watermark` / `--no-safe-mode` run forms (persist on every launch path, F22/F25).
- Every `/command` in both REPLs; `--config` view (D7); exit modes (`--list-*`, `--export`,
  `--delete`, `--delete-all-sessions`); `--resume`/`--rpg`.

## Parity matrix (no capability loss)

| Capability | Bare form today | Replacement after the cleanup |
|---|---|---|
| last model / provider | `-m <id>` alone | picker or `/model`; `-m <id>` alone now opens a chat with that model |
| temperature / top-p | bare flag | `/temp`, `/top-p`; run flags still persist on exit |
| reasoning effort | bare flag | `/reasoning`; run flag still persists |
| web search mode / count | bare flag | `/web-search`, `/web-results`; run flags still persist |
| smooth streaming | bare flags | `/smooth` (persists) |
| compact thinking | bare flag | `/compact-thinking` (persists) |
| watermark / safe mode | bare flags | `/watermark`, new `/safe-mode`; run flags still persist |
| image aspect / format defaults | bare flags | image REPL `/aspect`, `/format`; run flags persist |
| image resolution / quality / variants | bare flags | image REPL `/resolution`, `/quality`, `/variants` (persist); flags removed |
| export directory | bare `--output-dir` | `--export --output-dir <path>` (persists, D2) |
| export format | — (never persisted) | `/export-format`; `--export --export-format` persists (D3) |
| session budget | bare `--budget` | `/budget <usd>` (session-only, D1/D5) |

## New behavior rules (pin these in tests and docs)

- **E1 — a flag with no prompt opens a run.** After the dispatch is gone, `--temperature 0.5`,
  `--smooth-speed fast`, `-m <id>` etc. with no prompt on a TTY start an interactive chat instead
  of saving and exiting. Flags that persist on run paths (F22/F24) still persist; runtime-only
  knobs (`--smooth-speed`, `--compact-thinking`) apply to that session and are persisted by their
  `/commands`. With **piped stdin** a bare flag cannot open a chat: the run takes the one-shot
  path and fails at the model-selection TTY gate (`Interactive selection needs a TTY. Use -m
  <model-id> when piping input.`, exit 1) — the pre-existing behavior of a piped run without `-m`,
  now also what `echo hi | communicator --no-watermark` does instead of persisting and exiting.
- **E2 — `-m <id>` alone no longer validates-and-exits**; the model is validated when the chat
  starts (same error surfacing). `--list-models`/`--list-endpoints <id>` remain the catalog
  inspectors.
- **E3 — removed flags error via Commander**: `error: unknown option '--variants'`, exit 1.
- **E4 — `--output-dir` requires `--export` or `--image`, always** (run-shape condition deleted
  with the dispatch).
- **E5 — no prefs migration**: removed flags' prefs keys were never written (sizing) or become
  inert (`budget`); every surviving reader keeps working.

## Stages

### Stage 0 — baseline

- [ ] Confirm the branch: `feat/surface-cleanup` from `main` at `3.49.2`, clean tree.
- [ ] Run the gate once and record the count: `npm test` (expect 1842), `npm run lint`, `npx knip`.

### Stage 1 — parity first (nothing removed yet)

**1.1 — `/safe-mode on|off` (image REPL, Venice only)** — commit `feat: add /safe-mode to the Venice image session`
- [x] `src/commands/image-session.js`: add `'/safe-mode'` to `IMAGE_COMMAND_HELP` (first + `extra`
      usage line), push it in `imageSessionCommands()` next to `/watermark` under the
      `providerName === 'venice'` gate, and mirror the `/watermark` dispatch branch (`:248-256`).
- [x] `src/commands/image-gen.js`: add `handleSafeModeCommand` mirroring `handleWatermarkCommand`
      (no args → print `Venice safe mode is on|off.`; `on`/`off` → `savePrefs({ safeMode })` +
      confirmation; non-Venice → the same provider error shape as `/watermark`).
- [x] `src/status-line.js`: optional badge `safe mode off` beside `watermark off` when the pref is
      false (keeps the image status line symmetric).
- [x] Tests: `test/image-session.test.js` — help visibility (Venice yes, OpenRouter no), show
      state, `on`/`off` persist `prefs.safeMode`, the next generation in the same session uses the
      new value (`runImageGeneration` reads the pref per call), non-Venice refusal.
- [x] Docs: `docs/images.md` safe-mode section (command line), `MEMORY.md` §Text vs Image command
      separation (image REPL owns it).
- [x] Verify: PTY smoke on a Venice image session — `/safe-mode` shows state, `/safe-mode off`
      persists and the next generation request carries `safe_mode: false`; gate green.

**1.2 — export format: persist + `/export-format`** — commit `feat: persist the export format and add /export-format`
- [x] `src/flags.js`: add `resolveExportFormat(value)` (markdown|jsonl, same message as today:
      `--export-format expects "markdown" or "jsonl".`); use it in `src/cli-validation.js:222-227`.
- [x] `src/config.js`: `applyPreferenceUpdates` accepts `exportFormat` (assign when defined).
- [x] `src/cli-main.js` export block (`:246-261`): `const exportFormat = opts.exportFormat ||
      prefs.exportFormat || 'markdown'`; persist `exportFormat` (and `outputDir`) in one
      `savePreferences` call when the flag differs from the pref.
- [x] `src/commands/chat/index.js`: `COMMAND_DESCRIPTIONS['/export-format']` + `COMMAND_USAGE`
      (`/export-format <markdown|jsonl>`) + handler (no args → show current + default; arg →
      resolve, `ctx.savePrefs({ exportFormat })`, confirmation, `showStatus`).
- [x] Counts: `test/suggest.test.js` 24 → 25; MEMORY §command registry `24 commands` → `25`.
- [x] Tests: command handler (persist/show/bad value), export dispatch (`--export --export-format
      jsonl` persists and the next `--export` uses jsonl), resolver unit test.
- [x] Docs: `docs/commands.md` (`--export-format` row + chat-commands table row + examples),
      `docs/chat.md` if it lists chat commands.
- [x] Verify: `communicator --export --export-format jsonl` writes `exportFormat`; `/export-format
      jsonl` in chat does the same; a bare `--export` then emits JSONL; gate green.

### Stage 2 — remove the image sizing flags

Commit `feat!: remove the image sizing flags (the image REPL keeps them)`.

- [x] `index.js`: drop `--variants` (21), `--resolution` (23), `--quality` (24), `--width` (26),
      `--height` (27). Keep `--seed`, `--aspect-ratio`, `--image-format`.
- [x] `src/cli-validation.js`: `imageOnlyFlags` → `['seed']`; deleted the `--width`/`--height`
      conflict rules; the `--image` exclusion message now names only the flags that exist.
- [x] `src/commands/image-gen.js`: removed the `opts.width`/`opts.height` reads, the width/height
      divisibility check in `validateSizingConstraints`, and the derivation guard (pixel models
      always derive the pixels from the ratio now). The saved-default application for
      resolution/quality/variants stays and now runs for every run.
      **Deviation (required for correctness): the `opts.resolution`/`opts.quality`/`opts.variants`
      reads stay.** The image session passes its live command values through `opts`
      (`src/commands/image-session.js:412-419`), so removing those reads would silently break
      `/resolution`, `/quality` and `/variants` — the exact silent-no-op class this cleanup exists
      to remove. Only the CLI flags go; the internal channel stays.
- [x] `src/flags.js`: `resolveWidth`/`resolveHeight` and their `resolveImageDimension` helper are
      gone (knip clean); `resolveVariants`/`resolveResolution`/`resolveQuality` stay (the REPL).
- [x] Tests: removed the `resolveWidth`/`resolveHeight` cases, the `--width`/`--height` validation
      conflict test and the `--width`/`--height` passthrough case; added
      "`--image` applies the image-session defaults for resolution/quality/variants" (a persisted
      `imageDefaults.venice` set reaching a run) and kept the aspect/quality/resolution constraint
      rejections.
- [x] Docs: `docs/commands.md` (rows + examples), `docs/images.md` (flag table, sizing-defaults
      bullets, the explicit-flag paragraph; the resolution/quality enum lists moved to the image
      session text to keep the docs-consistency token check passing), `MEMORY.md` (Text vs Image).
- [x] Verify: `--image --resolution 2K` → `error: unknown option '--resolution'`, exit 1;
      `--image --width 512` likewise; `--image --seed 5` still parses (reaches model selection);
      gate green at 1851 tests + lint + knip.

Open wording follow-up (owner-visible, not fixed here): with the flags gone, the shared resolvers
and the constraints check still phrase their errors with the flag names — `--variants must be an
integer between 1 and 4.`, `--resolution must be one of: 1K, 2K, 4K.`, `--quality must be one of:
low, medium, high.`, `--variants N is not supported by <id>`. Those messages are now reachable only
from the image session (`/variants 5` etc.), so they name a flag that no longer exists. Rewording
them (e.g. to `/variants` or a command-agnostic phrasing) changes visible text and the tests that
pin it, so it needs the owner's call — raise it in the Stage 2 review pass.

### Stage 3 — remove `--budget`

Commit `feat!: remove --budget; the cap is per-session via /budget`.

- [x] `index.js`: drop `--budget`.
- [x] `src/session-setup.js`: remove `forcedBudget` from `resolveFlagValues` destructuring and both
      returns; fresh runs resolve `budget: null` (no `prefs.budget` read — D5); resume keeps
      `result.budget`.
- [x] `src/cli-validation.js`: remove `budget` from `hasConfigSetterFlags` and the image-exclusion
      message, and drop budget-specific rules if any.
- [x] `src/flags.js`: keep `resolveBudget` (the `/budget` handler uses it).
- [x] Tests: remove the `--budget` flag tests; keep `/budget` tests; add one asserting a legacy
      `{"budget": 2}` pref no longer caps a fresh session.
- [x] Docs: README budget bullet, `docs/commands.md` row + examples, MEMORY §Budget semantics
      (`--budget` gone; `/budget` only; the standing pref is inert).
- [x] Verify: `--budget 2` → unknown option; `/budget 0.5` caps the session; an old config with
      `budget` is ignored; gate green.
- [x] Owner-approved wording (choice "a"): the sizing resolver errors and the
      resolution/quality/variants constraint errors are dash-free now (`Resolution must be one of:
      1K, 2K, 4K.`, `Variants 5 is not supported by <id>.`) because only the image-session commands
      can reach them; the `--aspect-ratio`/`--image-format` messages keep their flag names.

### Stage 4 — remove the set-and-exit dispatch

Commit `feat!: remove the bare set-and-exit config dispatch`.

- [x] Delete `src/commands/config-set.js`; delete both `configSetRun` branches in
      `src/cli-main.js` (TTY and piped).
- [x] `src/cli-validation.js`: delete `isConfigSetDispatch`, `isPureConfigSetter`,
      `hasConfigSetterFlags`, `isConfigSetter`; the `--web-results` deferral becomes
      `opts.resume !== undefined`; the `--output-dir` rule becomes simply "requires `--export` or
      `--image`" (E4).
- [x] Tests: delete `test/config-set.test.js` and `test/config-set-command.test.js`; rewrite the
      F21-era cases in `test/cli-main.test.js` (system-prompt/scrape now always shape the run);
      update `test/cli-validation.test.js` and `test/cli-validation-image.test.js` (predicates and
      imports gone); add cases for E1/E2/E4 (bare flag opens a chat; `-m <id>` opens a chat;
      `--output-dir` alone errors).
- [x] Docs: delete/rewrite the "Standalone config commands" section and the `--output-dir` row in
      `docs/commands.md`; remove every "Bare use saves the default" phrase (7 today); drop the
      "With `--model` alone, saves the per-model default" clauses; `docs/images.md` config-setter
      mentions; MEMORY §Pending surface cleanup → completed; the `cli-main`/`cli-validation`
      bullets; KNOWN-ISSUES F21/F24/F26/F29 entries that describe the dispatch.
- [x] Verify: `communicator --no-watermark` alone opens a chat and persists on exit;
      `communicator -m <id>` opens the chat; `communicator --temperature 0.5` alone opens a chat;
      `--list-models --no-watermark` still errors; `--config` view still works; gate green.

### Stage 5 — sweep and backlog close-out

Commit `docs: close the surface-cleanup backlog items`.

- [x] `grep -rn "config-set\|set-and-exit\|Bare use saves\|isConfigSetDispatch" src docs README.md
      MEMORY.md AGENTS.md index.js` → expect nothing stale.
- [x] KNOWN-ISSUES: strike `O1`, `O31` (surface removed) and `O15` (moot); close `O26` as documented
      behavior — `--seed` stays `--image`-only because validation cannot know whether `-m <id>` is
      an image model; the image REPL `/seed` remains the session-level control. Record provenance
      entries for each.
- [x] MEMORY: move the new contracts to their homes (Text vs Image for `/safe-mode`; Web search
      semantics for the export-format pref if related; command registry count), mark
      `§Pending surface cleanup` completed with a pointer to this file's final state.
- [x] AGENTS: sources-of-truth list mentions `SURFACE-CLEANUP.md` (added when the file landed).
- [x] Verify: gate green; `npx knip` clean (it will flag every leftover export).

### Stage 6 — release 4.0.0

Commit `chore: bump version to 4.0.0` with the AGENTS changelog.

- [x] `package.json` → `4.0.0`; `npm install --package-lock-only`.
- [x] Changelog: `### Features` for `/safe-mode`, `/export-format`, the persisted export format;
      `### Fixes` for anything fixed along the way; every removal listed as a breaking feat
      (Commander now rejects those flags). No prefs migration (E5).
- [x] Gate: `npm test` 1822/1822, `npm run lint`, `npx knip`.
- [x] Merge `feat/surface-cleanup` → `main` (fast-forward to `ed8c0ac`), tag `4.0.0`, push `main`
      + tag, CI green on macOS/Ubuntu/Windows, merged branch deleted.

## Verification matrix

| Stage | Commands that must behave as stated |
|---|---|
| 1.1 | `/safe-mode`, `/safe-mode off` in a Venice image session; OpenRouter shows no `/safe-mode` |
| 1.2 | `--export --export-format jsonl`; `/export-format jsonl`; bare `--export` afterwards |
| 2 | `--image --resolution 2K` (unknown option); `--image --seed 5`; REPL `/resolution` → later `--image` |
| 3 | `--budget 2` (unknown option); `/budget 0.5`; legacy `budget` pref ignored |
| 4 | `--no-watermark` alone; `-m <id>` alone; `--temperature 0.5` alone; `--output-dir` alone errors; `--list-models --no-watermark` errors; `--config` view |
| 5–6 | gate + CI on three platforms |

## Risks and rollback

- **Docs-consistency test** (`test/docs-consistency.test.js`) enumerates flags vs docs and MEMORY
  field counts: run it per stage; it is the safety net for missed doc rows.
- **knip** will flag orphaned resolvers/exports after each removal — delete them in the same stage.
- **Commander** rejects removed options with `error: unknown option '--x'` (exit 1); no custom
  handling needed, but the help text must be updated so it does not advertise dead flags.
- **Behavior change (E1)**: a bare flag now opens a chat. This is the point of the cleanup; it is
  documented and pinned, and is the one change most likely to surprise old habits.
- Rollback: every stage is one commit on `feat/surface-cleanup`; `git revert <stage commit>` (or
  dropping the branch) restores the previous behavior with no prefs migration either way.

## Done criteria

- Every capability in the parity matrix has a working in-app setter (or run form) and a test.
- No `config-set`/dispatch code remains; `--output-dir` requires `--export`/`--image`.
- Docs, MEMORY, AGENTS and KNOWN-ISSUES describe only surviving behavior; `SURFACE-CLEANUP.md`
  marked completed.
- `4.0.0` tagged and pushed with green CI on all three platforms.
