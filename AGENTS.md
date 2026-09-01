# AGENTS.md

## Environment

- Host machine: macOS 26.6.2 (Darwin 25.6.0, Apple Silicon M5), Homebrew at `/opt/homebrew` (brew 6.0.18, `make` 3.81), login shell zsh 5.9, git is Apple Git 2.50.1 (`/usr/bin/git`). Node/npm/npx come from Homebrew (`/opt/homebrew/bin`): node v26.7.0, npm 11.19.0.
- Homebrew toolchain is the default in new shells: `~/.zshrc` runs `brew shellenv`, so PATH starts with `/opt/homebrew/bin` — `bash` is Homebrew bash 5.3.15 and `python3` is Homebrew Python 3.14.7. macOS `/bin/bash` (GNU bash 3.2.57) and CLT `python3` (3.9.6) still exist and win only where PATH is not fixed (e.g. the dsh server process started before this change — restart dsh after PATH/profile edits).
- macOS caveats: `/bin/bash` 3.2.57 is what absolute `#!/bin/bash` shebangs get (unchanged by brew bash; do not symlink over `/bin/bash`); bash-4+ syntax is safe only when `bash` resolves to the Homebrew one.
- Agent shells and scripts must invoke Homebrew bash explicitly as `/opt/homebrew/bin/bash` when they need bash 4+ features. Do not rely on `bash` or `#!/bin/bash`: outside a Homebrew-shell PATH, those resolve to macOS `/bin/bash` 3.2.57.
- GNU tools (coreutils 9.11, gnu-sed 4.10, keg-only) are on PATH via the `gnubin` dirs in `~/.zshrc`: `timeout`, `sed`, `stat`, `sort`, `head`, `tail`, `cat`, `ls`, `realpath`, `sha256sum`, `md5sum`, `nproc` are GNU — so BSD-only flag habits (`ls -G`, `stat -f`, `sed -i ''`) no longer apply in those shells; `grep`/`awk` remain BSD (GNU grep = brew `grep`, `ggrep`). `g`-prefixed names (`gtimeout`, `gsed`, …) are in `/opt/homebrew/bin` and usable even in a non-restarted dsh server; plain unprefixed names need the dsh server restarted with the new PATH.
- DSH harness sandbox note: bash tools run under a macOS Seatbelt (`sandbox-exec`) workspace-write sandbox; writes outside the workspace + `/tmp` fail with `Operation not permitted`, and `sandbox-exec` cannot be nested (running it from inside a confined command fails with `sandbox_apply: Operation not permitted` — expected, not a broken install).
- Node.js `>=22.13.0`, ESM (`"type": "module"`).
- The `engines` field is the minimum actually required by current code + tests: 22.13.0 is pinned by the direct `@inquirer/core@12` dependency (its own engines are `>=23.5.0 || ^22.13.0 || ^20.17.0`), not by `--experimental-test-module-mocks` (used for `mock.module()` in tests), which still works on 22.x. Only bump it when a new dependency or a new Node API/flag actually requires a newer version; never because the installed homebrew Node is newer.
- Entry point: `index.js` (`npm start`); `npm run dev` runs with `--watch`.
- CLI exposes `--version` sourced from `package.json`.
- API keys are always enabled: `OPENROUTER_API_KEY` and `VENICE_API_KEY` are exported in `~/.zshrc` (lines ~112-113), so they are present in any user shell and live — no need to check availability before smoke tests. Caveat: the dsh server's bash tool environment does NOT load `~/.zshrc`, so there `env` shows no keys and the client exits with `Error: <NAME>_API_KEY environment variable is not set.` — run smoke tests via `zsh -c 'source ~/.zshrc && node index.js ...'` (or `script -q /dev/null zsh -c 'source ~/.zshrc && node index.js ...'` for a PTY when the sandbox allows it).
- Always run GitHub CI locally before a merge or push.

## Verification

- Run `npm test` (uses `node --test --experimental-test-module-mocks`) after any change.
- Run `npm run lint` (`eslint .`) and keep it passing.
- Run `npx --yes knip` (via `npx`, deliberately not a dependency) after any change and keep it clean — it flags unused files, dependencies, and unnecessary exports, which accumulate silently one task at a time.
- Baseline: full test suite (1616 tests), lint and `npx knip` pass on tag `3.48.1`; keep all three green.

## Git workflow

- Every change (feature, fix, refactor, chore) goes on a dedicated gitflow branch (`feat/...`, `fix/...`, `refactor/...`, `chore/...`, `docs/...`) merged into `main`; never commit directly to `main`. Trivial fixes (typo/doc-only fixes, one-line tweaks, small patch-level changes) may skip the full git flow and commit directly to `main`; when in doubt, branch.
- Tags start at `1.0.0` and increment following semantic versioning. Create a tag when a meaningful milestone is reached (e.g. `1.0.0`, `1.0.1`, `1.1.0`).
- Tag naming: bare version, **no `v` prefix** (e.g. `3.37.1`, not `v3.37.1`). The repo history contains a mix of both conventions; never add new `v`-prefixed tags and never re-tag an already-tagged release.
- Lightweight tags (`git tag 3.37.1`), not annotated, matching the existing series.
- Push tags to `origin` right after creating them (`git push origin <tag>` or `git push --follow-tags`), so local stray tags never accumulate and silently ride along on a later `--tags` push.
- Tag hygiene: whenever an orphan tag (points at a commit not reachable from `main`, e.g. a tag left on a deleted branch) or a duplicate tag (two tags referencing the same release/commit, e.g. `3.33.0` + `v3.33.0`) is ever found, delete it immediately — both locally and on `origin`.
- Keep `package.json` `version` in sync with the tags: bump it whenever a new tag is created.
- Whenever bumping the version for a tag, also run `npm install --package-lock-only` to keep the root `version` in `package-lock.json` in sync.
- Always tag correctly: after every merge into `main`, create a tag following semantic versioning (MAJOR for breaking changes, MINOR for features, PATCH for fixes) and keep it in sync with `package.json`/`package-lock.json`.
- **Version-bump (tag) commit messages are changelogs.** The commit that bumps the version for a new tag must always enumerate every change landed since the previous tag as a bulleted list of user-visible changes, prefixed as fixes or added features (e.g. `- fix: Esc stops a streaming generation` / `- feat: ...`), grouped under `### Fixes` and `### Features` headers. Derive the list from `git log --oneline <previous-tag>..HEAD`, distill it to user-visible changes, and never leave the message as a bare version bump.
- Delete branches once merged into main: local via `git branch -d`, using `git branch --merged main` as the check, and on the remote via `git push origin --delete <branch>` — the agent **may and should push** to `origin` after the merge into `main` (fast-forward or merge commit), including deleting merged remote branches. Pushing after a fast-forward merge is expected, not forbidden. The merge commit preserves the full history, so cleanup is lossless. Never delete unmerged branches.
- Merge with fast-forward when possible; if main has advanced, use a regular merge commit. Never rebase a pushed branch (avoids force-push).

## Code quality

- Write very clean code: readable, consistent with existing style, no dead code or leftovers.
- No comments unless they explain non-obvious intent.
- Terminal output layout is a contract: every repeated visual element (markers, separators, footers, banners) must keep the identical spacing in every stage that renders it — one blank line above and one below unless the established pattern says otherwise. Never let one code path (live stream, history replay, rebuild, continuation redraw) drift from the others; when a new stage re-renders an element, mirror the spacing of the existing stages (see MEMORY.md §Display consistency contract).
- No debug prints, no `console.log` leftovers in final code.
- Do not add dependencies without need; prefer built-in Node.js APIs where reasonable.
- Keep the CLI flag conventions: long-form flags (`--list-models`, `--output-dir`, `--reasoning-effort`, ...), single-character short flags only (Commander does not support multi-char short flags).

## Project notes

- CLI chat client for OpenRouter + Venice.ai with interactive model/provider selection, session persistence, usage/cost tracking, markdown export, and Venice image generation (`--image`, `--list-image-models`).
- The frame-diffing editor (in-repo `src/editor/`, merged Aug 2026) replaces the vendored read-multiline editor; its behaviour contract is in MEMORY.md §Command autocomplete and the parity tests in `test/editor-parity.test.js`.
- Streaming renderer, config file persistence (`--config`, `savePreferences`), per-request timeouts/retry with backoff (`fetchWithTimeout`/`fetchWithRetry` in `src/http.js`), and web search sources are implemented; keep them working when touching related code.
- OpenRouter's search-enabled delivery is **bursty by long-standing behavior, not a recent bug**: with `/web-search on` (auto) or `always`, OpenRouter can flush the whole reasoning block/content in a single SSE burst and can even run the search after the model already started answering (sub-ms delta spans, late-arriving sources, no incremental feedback). Symptoms like the compact meter checkpointing `· 0s` on a multi-second wait, the waiting row frozen on the spinner, or the whole answer popping at once are *expected* there — read `OPENROUTER.md` before investigating any web-search streaming anomaly, and remember the client already handles it (request-anchored clocks, sub-50 ms count-only suppression, smooth-streaming pacing).
- When testing image generation (Venice `--image`, OpenRouter image-output models), prefer cheap/fast models (e.g. `venice-sd35` on Venice, low-cost models on OpenRouter) unless the test genuinely needs the heavy hitters (`gpt-image-2`, `nano-banana-2`, ...) — high-end generations take minutes and cost more.
- Documentation update policy: see §Documentation & memory below.

## Text vs Image model separation

- Text models (chat REPL, `src/chat.js`) own only text and vision commands (`/attach`, `/reasoning`, `/web-search`, etc.). No image-specific commands are exposed in text chat — not even provider-specific ones like `/watermark`. The two REPLs never share image commands.
- Image models (image session REPL, `src/commands/image-session.js`) own all image generation commands (`/resolution`, `/quality`, `/format`, `/aspect`, `/variants`, `/seed`, `/watermark`). Each command is only shown when the active model's `constraints` object advertises support for that parameter (e.g., `/resolution` is hidden when `constraints.resolutions` is `null`).
- When an image session hands off to a text chat via `/model`, the image commands disappear. When a text model has `imageOutputSupported: true`, it does not get image parameter commands — it generates images through chat completions without user-facing sizing knobs.

## Documentation & memory (sources of truth)

- README.md + docs/ — committed, public, user-facing. Update on user-visible behavior changes only.
- AGENTS.md (repo root, committed) — agent instructions and environment facts.
- MEMORY.md (repo root, committed) — the single detailed source of truth for implementation facts and contracts (English). Every behavior change must update it.
- OPENROUTER.md (repo root, committed) — provider-behavior reference for OpenRouter specifics: the search "burst mode" delivery quirk (what it is, when it hits, what it breaks, how the client handles it) and its regression checklist. Consult it before investigating web-search streaming anomalies — it exists precisely because that behavior is easy to mistake for a recent bug.
- Memory rules: (1) one detailed home per fact — MEMORY.md; (2) on any behavior change, update MEMORY.md in the same session (same discipline as updating tests); (3) new long-form facts land in MEMORY.md.
- `MEMORY.md`, `AGENTS.md` and `OPENROUTER.md` are committed project files; keep them updated in the same commits as the changes they describe.
