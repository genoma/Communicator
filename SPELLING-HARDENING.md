# macOS spelling — hardening plan (source of truth for the next session)

**Status.** Written by the parent agent at the end of the 4.3.0 session; approved by the user as
the source of truth for a fresh session. Everything below is decided — implement it, do not
re-litigate it. Where a decision depends on user preference, it is marked *(do not change)*.

**Baseline.** `main` at `75fd5dc`, tag `4.3.0`, 1990 tests green on Node 22/24/26, eslint and knip
clean.

**Scope.** Three code changes — one test, one cleanup, one small policy fix — plus doc truth and a
PATCH release (4.3.1). No new features. Nothing here changes what a user sees except: faster recovery
after a transient helper failure, and a cache directory that stops accumulating.

**Lifecycle.** When every task is done and 4.3.1 is tagged, fold the outcomes into MEMORY.md and
delete this file (the `SURFACE-CLEANUP.md` precedent).

---

## 1. Ground truth you can rely on (do not re-derive)

Shipped in 4.2.0 → 4.3.0, all reviewed, all documented in MEMORY.md §macOS spelling semantics:

- **Feature**: macOS-only prose assistance in the prompt editor — typo underlines (Ctrl+. replacement
  list), a dim completion hint accepted with Tab, opt-in autocorrect (`/settings autocorrect on`,
  off by default). Inert off darwin. Settings: `spellingTypoDetection` / `spellingAutocomplete` /
  `spellingAutocorrect` in `~/.communicator.json`.
- **Backends**, both implementing `run(request, { signal }) -> Promise<reply>`:
  - `src/spelling/osascript.js` — one `/usr/bin/osascript` child per request (the fallback).
  - `src/spelling/helper-backend.js` — compiles `src/spelling/helper.m` once into
    `~/.communicator/spelling-helper-<16 hex>` and keeps ONE long-lived child that speaks
    newline-delimited JSON, with an id-matched protocol, a per-request watchdog, one restart then a
    session latch, and a silent fallback to osascript on every failure. Also exposes `whenReady()`.
  - `src/spelling/jxa.js` is the JXA program for the osascript path; `helper.m` is a
    **line-for-line semantic port** of it (nil-language `check` substring walk; explicit-language,
    word-aligned `guesses`/`correction`/`completions`; identical reply shapes). **They must stay in
    lockstep — Task 1 exists to pin that.**
  - Backend test seams: `createHelperBackend({ fallback, sourcePath, cacheDir, spawnFn, timeoutMs,
    buildTimeoutMs, maxBuffer, toolchainDirs })`; every existing test injects `spawnFn` +
    `toolchainDirs` and never compiles or spawns anything real.
- **Measured** (macOS 26.6.2, Apple Silicon): `check` ~0.9 ms via the helper vs ~69 ms via osascript
  (≈75×); `guesses`/`completions`/`correction` 3.8–5.9 ms vs 71.6–74.2 ms (13–19×). Cold build
  ~300 ms; first request after a child spawn ~14 ms.
- **Test harness** (`scripts/run-tests.js`): one test file per process with
  `--experimental-test-isolation=none` (no result frame channel), `NO_COLOR`, cleared keys,
  throwaway `HOME`. Counts are identical on 22/24/26. `npm test` is the only supported entry.
- **CI** (`.github/workflows/ci.yml`): `macos-latest` + `ubuntu-latest` + `windows-latest` × Node
  22/24, running `npm run lint` and `npm test`. No workflow change is needed for Task 1.
- **Open residuals** live in `KNOWN-ISSUES.md` **F44**; Tasks 1–2 close both of them.

Read before changing anything: `AGENTS.md`, `MEMORY.md` §macOS spelling semantics + §Tests, CI and
platform notes, `KNOWN-ISSUES.md` F34/O27 (closed) and F42 (upstream frame-channel bug, still open).

---

## 2. Task 1 — pin `helper.m` ↔ `jxa.js` parity in CI (the important one)

**Why.** Today the only parity evidence is a manual smoke: the suite may not compile, so a future
edit to `helper.m` can silently diverge from `jxa.js` and no gate would notice. The macOS CI runner
already exists and already runs `npm test`.

**New file**: `test/spelling-helper-parity.test.js` — the ONE deliberate exception to the
"no test compiles or spawns a real backend" rule. Record that exception in MEMORY.md and AGENTS.md
(exact wording in §5).

**Behaviour**

1. Skip (do not fail) unless `process.platform === 'darwin'` — use `t.skip('macOS only')`.
2. Skip when no toolchain is present: the same filesystem probe the backend uses
   (`/var/db/xcode_select_link` → `usr/bin/clang`, else `/Library/Developer/CommandLineTools` or
   `/Applications/Xcode.app/Contents/Developer`) — `t.skip('no Command Line Tools')`. Never invoke
   `/usr/bin/cc` to find out (macOS would offer the developer-tools installer).
3. Compile through the real path: `createHelperBackend({ cacheDir: <mkdtemp dir> })` and
   `await whenReady()` must be `true` (this also pins the build, the cache name and the spawn).
4. Drive **both** backends over the corpus below — the helper backend and a real
   `createOsascriptBackend()` — and assert the replies are equal once the protocol's `id` echo is
   removed:
   `const compare = (reply) => JSON.stringify({ ...reply, id: undefined })`.
5. Malformed requests are compared as *behaviour*, not text: `unknown op` and `missing text` must
   BOTH reject on each backend (the two backends word the error differently — that difference is
   accepted and must not fail the test).
6. Cleanup in `t.after`: `backend.dispose()`, then `rm(cacheDir, { recursive: true, force: true })`.
   No timing assertions (CI variance), no `osascript` mocking.

**Corpus** (extend it when a semantic edge is found; keep it cheap):

| request | why |
| --- | --- |
| `check` `"The quick brown fox wrold over teh lazy dog"` | two typos, one line |
| `check` `""` / `"   "` | empty shapes |
| `check` `"questo e bello"` | Italian must stay unflagged (nil-language semantics) |
| `check` `"привет мир"` | Russian, same reason |
| `check` `"this is an English wrnog inside italiano"` | the nil-language mixed case |
| `check` `"😀 https://example.com/a?b=1"` | emoji + URL |
| `check` `"wrold src/chat.js --rpg"` | the mask-shaped line |
| `guesses` `teh` / `wrold` | word-scoped, explicit language |
| `correction` `teh ` / `wrold ` | dictation |
| `correction` `world ` | a correct word → `null` |
| `completions` `recon` (alone and inside a sentence) | word-aligned, explicit language |
| `{ op: 'nope' }`, `{ op: 'check' }` (no text) | both backends reject |

**Acceptance**: the test RUNS (not skipped) on the macOS CI runner; skipped cleanly on Linux/Windows
and on a Mac without CLT; `npm test` counts one file more and stays green on 22/24/26. If the parity
test fails on a genuine semantic difference, fix `helper.m` (it is the newer implementation) — never
the fallback `jxa.js` semantics.

---

## 3. Task 2 — sweep stale cached binaries

**Why.** F44 residual (2): a source or toolchain change makes a new `spelling-helper-<hash>` and the
old file stays in `~/.communicator` forever (~54 KB each, no eviction).

**Behaviour** (`src/spelling/helper-backend.js`)

- Once per process, after the compiled path first becomes usable (a warm-cache hit counts), list
  `cacheDir` and remove entries whose name matches **exactly** `/^spelling-helper-[0-9a-f]{16}$/`
  and is not the current binary's basename.
- **Never** touch `*.tmp`: a concurrent session may be compiling into one right now.
- Ignore every error (a cache sweep must never fail a request); do not print anything.
- Deleting the file of a helper another session is *running* is safe (POSIX keeps the inode until
  the process exits) — note that in the comment; do not try to be clever about liveness.

**Acceptance**: a test in `test/spelling-helper-backend.test.js` with the existing fake harness —
write a stale `spelling-helper-0000000000000000` and a `spelling-helper-ffffffffffffffff.tmp` into
the temp cache dir, build normally, then assert: the stale file is gone, the `.tmp` survives, the
current binary exists, and a second backend on the same cache dir still starts (warm cache).

---

## 4. Task 3 — re-arm the restart budget after a proven-healthy run

**Why.** Today one transient helper failure spends the session's only restart, so a single hiccup
costs the fast path for the rest of the session (`MAX_HELPER_RESTARTS = 1`, never re-armed).

**Behaviour** (`src/spelling/helper-backend.js`)

- Count successful replies per helper child; when a child has answered
  `healthyBeforeRearm` (new option, default 20) requests, reset `restartsLeft` to
  `MAX_HELPER_RESTARTS` and the counter.
- The **session latch stays terminal**: once two failures latch the compiled path off, later requests
  go to osascript and never touch the helper again (nothing retries behind the user's back). The
  re-arm only helps a helper that has proven healthy *before* the next hiccup.
- Reset the counter whenever a new helper child is spawned.

**Acceptance**: two tests in `test/spelling-helper-backend.test.js` with
`{ timeoutMs: 5, healthyBeforeRearm: 2 }`: (a) failure → two successful replies → failure spawns a
THIRD helper (budget re-armed, not latched); (b) without the healthy replies the second failure
latches (the existing test already pins this — keep it green).

---

## 5. Docs to update (same commits as the code)

- **MEMORY.md**
  - §Compiled helper: build, cache and cache name → the sweep (pattern, `.tmp` exclusion, once per
    process) and the note that unlinking a running binary is safe.
  - §Compiled helper: watchdog, restart budget, failure and dispose → the re-arm policy
    (`healthyBeforeRearm`, latch stays terminal for the session).
  - §Tests → the new parity test as the deliberate exception: “no test compiles or spawns a real
    backend **except `test/spelling-helper-parity.test.js`, which compiles the helper on darwin when
    a toolchain is present and drives both real backends; it skips on other platforms and without
    Command Line Tools**”. The `grep -rn osascript test/` review gate will now legitimately find
    this file.
  - The parity sentence (“the suite CANNOT pin that … the manual macOS smoke is the only check”)
    becomes “pinned by `test/spelling-helper-parity.test.js` on macOS CI; the manual smoke remains
    the local check after editing `helper.m`”.
- **KNOWN-ISSUES.md F44** → strike both residuals with provenance (parity now CI-pinned; the cache
  now sweeps), keep the entry as history, and say explicitly what still is not covered (nothing
  beyond: parity is only checked where a toolchain exists).
- **AGENTS.md** → the suite-count baseline (1990 → the new number, measured on 22/24/26) and the
  same "one deliberate exception" wording in the verification bullet.
- **README.md / docs/** → no change (nothing user-visible).

---

## 6. Explicitly NOT doing *(decisions already made — do not change)*

- **Removing the compiled helper and going back to full JS.** The helper buys ~75× on the hot path
  and 13–19× on the word ops; the user measured the per-request cost and asked for the bridge to be
  fixed. The fallback makes it unable to regress. Full JS would be simpler to maintain — if the cost
  were ever judged imperceptible again, that is the trade to reopen, with measurements.
- **Gating autocorrect on the typo-flagged range.** It would remove the `teh` asymmetry (never
  underlined, still corrected to `the`) and cut correction spawns, but it would delete a working
  correction. The asymmetry is the system checker reading different language inputs — documented,
  accepted.
- **Tab applying the highlighted replacement / a trailing space after an accepted hint.** Both are
  user decisions: Tab stays Up/Down + Enter, the accepted hint stays space-free.
- **Replacing `osascript` entirely.** No: the helper needs a compiler, and the fallback is what makes
  the compile step acceptable.

---

## 7. How to work on this

- **Release shape**: branch `fix/spelling-hardening` → commits → ff-merge into `main` → version bump
  to **4.3.1** in `package.json` + `npm install --package-lock-only`, with a `### Fixes` changelog
  commit → lightweight tag `4.3.1` → push `main` and the tag → delete the branch. Counts in
  AGENTS.md updated in the same release.
- **Review lanes**: one reviewer (robustness/parity) plus one gate runner is enough for this size;
  keep the parent on the intricate parts. A worker must never own a subsystem it cannot test itself.
- **Sandbox/gotchas** that cost time before: never run `npx <pkg>` (the fetch hangs — use
  `./node_modules/.bin/eslint`, `npx --yes knip` with its warm cache, `npm test`); put long
  subagent scripts in a file and pass `workflowScriptPath` (inline JSON escaping ate a `\n` once);
  the wrapper runs one test file per process, so per-file `node --test` runs are legitimate
  debugging.
- **Never** let the parity test make the suite compile on Linux/Windows, and never let any other test
  compile or spawn a real backend.

## 8. Verification checklist (run all of it before the release commit)

```sh
npm test                                                        # expect suites+1, all green, no skips on macOS
./node_modules/.bin/eslint .                                    # exit 0
npx --yes knip                                                  # exit 0
/opt/homebrew/opt/node@22/bin/node scripts/run-tests.js         # identical counts to npm test
/opt/homebrew/opt/node@24/bin/node scripts/run-tests.js
grep -rn "osascript\|/usr/bin/cc" test/                         # only test/spelling-helper-parity.test.js (and the fake-harness strings)
```

Plus, after touching `helper.m` or `helper-backend.js`, the local macOS smoke: delete
`~/.communicator/spelling-helper-*`, run the real backend with an anchor (a bare script cannot await
a spelling op — every handle is `unref`ed), and check the four ops plus a cold-build time (~300 ms)
and `pgrep -fl spelling-helper-` empty after `dispose()`.
