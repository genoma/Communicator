# Compilation plan — allowing compiled artifacts

**Status: draft, not merged.** Branch `docs/compilation-plan`, cut from `main` at `5e26bb8` (`5.0.6`).
This branch adds this plan and the `AGENTS.md` policy section only; no behavior changes. Implementation
starts only after the owner decisions in §5 are answered and each stage's UX gate is passed.

Baseline this plan was written against: `npm test` **2250/2250, 0 fail, 0 skipped** (119 suites, Node 26.9.0
on macOS 27.0/M5, one process per file) and `npm run lint` clean, both re-run on this branch. The CI matrix
(macOS/Ubuntu/Windows × Node 22/24) runs the same gate; it was not re-verified here.

How to use: this plan is the source of truth for what "we can compile" means, what it unlocks, and the
order of work. Stages are ordered and each ends with a green gate plus its own commit; do not start a
stage before the previous one is green. `AGENTS.md` §Compiled artifacts carries the binding policy —
read it before proposing any new dependency.

## 1. Decision: what "we can compile" means here

The project's rule was never "no compilation" as such; it was **no build step and no native dependency**:
`README.md:38` advertises "five runtime dependencies, pure Node.js ESM" and `docs/platforms.md:5,16` says
"no native dependencies". The one exception already in the tree is the macOS spelling helper
(`src/spelling/helper.m`), which compiles lazily on first use with a filesystem-probed toolchain and an
osascript fallback.

Allowing compiled artifacts changes *delivery*, not the runtime contract. Three models were evaluated:

| Model | Verdict |
|---|---|
| **A. Build on install** (`node-gyp`/`install` scripts) | **Rejected.** It re-creates the failure modes the spelling helper works ~180 LOC to avoid (missing toolchain, developer-tools installer prompt, read-only homes) at `npm install` time, where there is no fallback. `nodehun` is auto-rejected by this rule even though it is the fastest Hunspell binding. |
| **B. Prebuilt per-platform packages** (`optionalDependencies` with `os`/`cpu`/`libc`) | **Adopted for native code.** The esbuild/sharp/biome pattern: npm skips non-matching platform packages and does not fail the install. Requires a per-platform release story. |
| **C. Committed WASM / pure-JS artifacts** | **Adopted for computation.** One artifact, all platforms, no install risk. This is the same class as a dependency's data file. |

Invariants (binding, see `AGENTS.md` §Compiled artifacts):

1. The user's machine never compiles at install time.
2. Compilation is never required to run: every native artifact loads behind try/catch at feature scope and
   the feature degrades exactly like the existing platform gates (clipboard probe, spelling darwin gate).
3. Tests stay hermetic without the artifact, via an injectable seam (the existing `platform`/`spawnFn`/
   `requestFn` precedent). No test may require a real native dependency.
4. A dependency is justified only where pure JS cannot do the job; the docs claims above are updated in the
   same commit as the first dependency that invalidates them.
5. User-visible consequences follow §UX change approval like any other change.

### 1.1 The finding that shapes this plan

Seven recon lanes (four repo scouts, two external researchers, one evidence audit) were run against
`5e26bb8` to test the original hypothesis that compiling unlocks spelling, tokens, images and clipboard.
The audited result is narrower and more useful:

> **Compilation buys exactly one capability in this application: local image decoding/encoding
> (`W3`).** Cross-platform spelling, token counting and clipboard read are all achievable with pure
> JS/WASM and were gated by the dependency policy, not by compilation. The renderer stays pure JS.
> Startup/packaging gains measured as noise.

Everything below is therefore organized by *need*, and only `W3` is a compile-dependent workstream.

## 2. Ground truth (verified against `5e26bb8`, do not re-derive)

### 2.1 Spelling seam

- The platform gate is one line: `src/spelling/index.js:10` (`platform !== 'darwin' → null`), otherwise
  `createHelperBackend()` at `:11`. Nothing downstream checks the platform — `src/editor/*` and
  `src/input.js:45` gate purely on provider presence, and `/spelling` is hidden via
  `spellingSupported` (`src/commands/chat/index.js:768-778`).
- `provider.js` (419 LOC) and `mask.js` (50 LOC) are platform-free and stay unchanged. The backend
  contract is two calls: `backend.run(request, { signal }) → Promise<answer|null>` (awaited at
  `provider.js:169`; a rejection counts toward the 3-failure session latch) and optional
  `backend.dispose?.()` (`provider.js:412`).
- Request shapes: `{op:'check', text}`; `{op:'completions'|'guesses'|'correction', text, location, length}`.
  Replies: `{ranges:[[start,length],…]}`, `{words:[…]}`, `{correction:string|null}`, or `{error}` (rejects).
- Failure semantics are three independent layers and must not be merged: osascript rejects per request;
  the helper layer owns the 1-restart budget, the terminal `compiled=false` latch and the cached-binary
  drop; the provider owns the 3-consecutive-failure session latch plus a silent re-arm via `setFeatures`.
- Test ownership: 130 spelling tests across 7 files. `helper-backend` runtime-build machinery is pinned by
  11 tests in `test/spelling-helper-backend.test.js` and 6 in `test/spelling-fallback-paths.test.js`;
  `test/spelling-helper-parity.test.js` is the suite's only real compile (darwin + toolchain, skipped
  elsewhere) and pins `helper.m` ↔ `jxa.js` semantics.
- macOS-only semantics that no portable engine reproduces: the user's whole active dictionary set
  (`check` passes a nil language on purpose), the user's own learned words (document tag 0), and
  `completionsForPartialWordRange`-style prefix completions.

### 2.2 Token seam

- Token numbers are provider-reported, with exactly one local estimate: `estimatePromptTokens`
  (`src/providers/openrouter.js:25-40`, `chars/4`, images as 340 tokens) whose only consumer is the
  Anthropic `cache_control` TTL choice (`:379-383`). It is never displayed, costed or persisted.
- There is **no pre-flight prompt-size check, no history trimming and no context-overflow branch**
  anywhere; every 4xx becomes a generic `ApiError` (`src/errors.js:130`). `maxCompletionTokens` is
  fetched and dropped (`src/providers/openrouter.js:363`, `src/providers/venice.js:158,261`).
- `contextLength` is display/persistence only: banner and `/status` badge (`src/status-line.js:59`),
  footer CTX row (`src/tracker.js:135,170`), resume summary (`src/chat.js:239-240`), session payload.
- Integration seam: `src/turn-runner.js:196-204` (message array + model + window all in scope), mirrored
  by the one-shot twin (`src/commands/one-shot.js:145-148, 196-215, 263, 272`). A shared helper is the
  parity-compliant shape, matching the `seedTracker` precedent.
- OpenRouter's `/models` exposes `architecture.tokenizer` — a coarse **family** enum
  (`GPT | Claude | Gemini | Gemma | Grok | Cohere | Nova | Qwen | Qwen3 | DeepSeek | Mistral | Llama2 |
  Llama3 | Llama4 | Router | Media | Other | Unrecognized<string>`), not an encoding. The repo currently
  keeps only the two modality arrays (`src/providers/openrouter.js:112-118`).

### 2.3 Image seam

- The wire shape is built once in `attachments.js:197-211` (`buildContent`/`toPart`) and forwarded
  verbatim by both providers (`openrouter.js:370-373`, `venice.js:300`). **Provider request builders need
  zero changes** for any preprocessing.
- The transform seam is `loadAttachment` (`attachments.js:102-143`), between `readFile` (`:128`) and the
  return branches (`:135`, `:142`), preserving `{kind, filename, mime, size, data}`. Every consumer
  (interactive, one-shot, queue, session externalize/hydrate, export) then sees transformed bytes.
  The pre-read size gate on `stat().size` (`:108-123`) must re-check the post-transform payload.
- Current rules: images are `png jpg jpeg gif webp bmp` only (`attachments.js:6-14,49`); HEIC/HEIF/AVIF/
  TIFF/SVG hard-fail with `Unsupported file type` (`:93-104`); office is Venice-only; text is inlined.
  The image limit compares the **base64-encoded** length against 20 MiB (`:114-117`) — i.e. the raw
  ceiling is ≈15.0 MiB, while the download path applies the same constant to raw bytes
  (`attachment-store.js:170`) and the error says "(image limit is 20 MB)". No resize, transcode, EXIF or
  orientation handling exists anywhere.
- Storage is content-addressed `sha256.<ext>` refs with a `[a-z0-9]{1,5}` ext grammar
  (`attachment-store.js:11-16`), `wx` writes that never overwrite, and a hydrate path that rebuilds mime
  **from the extension only** (`:124-127`) — new formats must extend `MIME_EXT` and `REF_NAME_RE`
  together.
- Capability gating happens only at attach time (`attachments.js:184-192`); `hydrateAttachments` has no
  gate, so a resumed session can send image parts to a non-vision model today (pre-existing gap).

### 2.4 Infra facts

- Production `process.platform` branches: `src/clipboard.js:3-11,13`, `src/spelling/index.js:9-11`,
  `src/spelling/helper-backend.js:57,80-81`, macOS toolchain paths `:41-43,60-66,327`, and the UI gate
  `src/commands/chat/index.js:704,768-778`. Nothing else.
- Clipboard is write-only (`src/clipboard.js:1-50`) and probed at call time: `pbcopy` / `clip` /
  `wl-copy` → `xclip` → `xsel`, 10 s timeout per tool, EPIPE fallthrough, final message at `:18`.
  `/copy` is `src/commands/chat/index.js:628-636`.
- `package.json` has 5 runtime deps, no `optionalDependencies`, no `os`/`cpu` entries in the lockfile
  (lockfileVersion 3, 108 packages), no install scripts, `files: ["src/"]`, and **no publish automation
  at all** (no `publishConfig`, `repository`, `.npmrc`, `CHANGELOG`, release workflow; version bumps are
  manual commits). CI is `.github/workflows/ci.yml` (lowercase; `AGENTS.md`/MEMORY say `CI.yml`) with a
  3-OS × Node 22/24 matrix plus `npm audit --omit=dev --audit-level=high`.
- Test hermeticity comes from `scripts/run-tests.js`: cleared keys/color/debug, throwaway
  `HOME`/`USERPROFILE` (which is what keeps `DATA_DIR` caches out of the developer's home), one process
  per file, console guard. There is no network block, so hermeticity of a new artifact rests on
  convention + injection seams.
- Startup is not a compile target: measured medians on this machine are inside process noise
  (`node -e ""` 72.4 ms; `node index.js --version` 70.5 ms; `--help` 71.0 ms). `module.enableCompileCache`
  is unused and unnecessary.
- `knip.json` has only a test entry; a path-read WASM is invisible to knip, while dynamic platform
  packages will need `ignoreDependencies`. `npm pack --dry-run` confirms `files: ["src/"]` ships non-JS
  assets (it already ships `helper.m`).

### 2.5 External options (audited; corrections applied)

Audited corrections to the raw research are marked **[audit]**. All sizes are npm `unpackedSize`.

**Spelling.** No packaged option backs all four ops off macOS: Hunspell engines offer spell+suggest,
Windows `ISpellChecker` has no completion method at all, and the one 2026 darwin+win addon ships only a
`darwin-arm64` prebuild.

| Option | License | Platforms | Size | Covers |
|---|---|---|---|---|
| **nspell 2.1.5** (pure JS) | MIT | all | 42 KB | `check` (as a CLI-side tokenizer), `guesses`, `correction`; **no completions** |
| **dictionary-en 4.0.0** | MIT AND BSD | data | 575 KB | en_US (SCOWL-derived) |
| Typo.js 1.3.2 (pure JS) | BSD-3-Clause | all | 1.98 MB | check/suggest; no completions |
| hunspell-wasm 0.3.0 (WASM) | LGPL/GPL/MPL tri-license | all | 1.05 MB | spell/suggest; no completions |
| @farscrl/hunspell-wasm 1.0.1 | MIT wrapper (bundled Hunspell tri-licensed) | all, **engines ≥24** | 2.07 MB | spell/suggest; engines collide with `>=22.15.0` |
| nodehun 3.0.2 (N-API) | MIT | toolchain required, **no prebuilds** | 7.17 MB | rejected by policy §1-A |
| @arcstudio-labs/…spellcheck 0.1.0 | MIT | darwin-arm64 prebuild only; Linux out of scope | 97 KB | check/suggest; no completions |

Dictionary licenses matter: en is MIT+BSD, ru BSD-3-Clause, fr MPL-2.0, but **de is GPL-2.0-or-3 and it is
GPL-3.0** — shipping those is a legal decision, not a packaging one.

**Tokenizers.** tiktoken ships OpenAI encodings only (`gpt2`, `p50k`, `p50k_edit`, `r50k`, `cl100k`,
`o200k`) — that is the whole family. Options:

| Option | License | Size | Note |
|---|---|---|---|
| js-tiktoken/lite + one rank | MIT | ~2.4 MB | pure JS, tree-shakeable; OpenAI encodings |
| @huggingface/tokenizers 0.2.0 | Apache-2.0 | 96 KB (dist) / 361 KB pkg | any HF `tokenizer.json`; backend of transformers.js v4 |
| tokenizers 0.23.2 (official Rust napi) | Apache-2.0 | **66.7 MB** (all 13 platforms in one tarball) | any HF `tokenizer.json`; only compiled option, worst packaging |
| @lenml/tokenizers family pkgs | Apache-2.0 | 76–254 MB each | bundled data; rejected on size |

**[audit]** measured `tokenizer.json` sizes are 1.96 MB (Mistral-7B-v0.3), 7.03 MB (Qwen2.5-7B),
17.2 MB (Llama-3.1-8B) — budget 2–17 MB per family, not "9–33 MB"; `architecture.tokenizer` is a family
tag that still needs an explicit family→encoding map; the claim that OpenRouter usage counts are produced
by each family's native tokenizer is unverified.

**Image codecs.**

| Option | License | Matrix | Size/platform | Note |
|---|---|---|---|---|
| **sharp 0.35.4** + `@img/*` | wrapper Apache-2.0; libvips packages **LGPL-3.0-or-later** **[audit]** | darwin arm64/x64, linux x64/arm64 **glibc+musl**, win x64/arm64 (+arm/ppc64/s390x/riscv64/ia32) | ~18–19 MB (win-arm64 16.7 MB) | AVIF/TIFF/JPEG/PNG/WebP/GIF/SVG, resize; metadata stripped by default (`keepMetadata()` opt-in); **no HEIC/HEIF in prebuilds**; no install script (safe with `--ignore-scripts`); npm provenance |
| @napi-rs/image 1.15.0 | MIT | darwin, linux gnu+musl, win x64/arm64/ia32, freebsd, android | 14–18 MB | AVIF/TIFF/resize; HEIC via macOS ImageIO / Windows WIC only, clear Linux failure; one maintainer | 
| libheif-js / heic-convert | LGPL-3.0 | wasm32 | — | HEIC **decode → JPEG/PNG only**; no resize |
| jimp 1.6.1 | MIT | pure JS/WASM | 3.3 MB | resize; no HEIC (#771 open since 2019); 189 open issues |

**[audit]** sharp is **not** the only option with a full prebuild matrix (`@napi-rs/image` matches the six
targets), and libvips must be reasoned about as **LGPL-3.0-or-later** (the shipped packages' declaration),
not upstream's LGPL-2.1 text. HEIC/HEVC is patent-encumbered (HEVC Advance/Access Advance, Via LA) and no
package can waive it; the licence-free paths are OS codecs (macOS ImageIO, Windows WIC) or no HEIC at all.
Note the LGPL consequence for packaging: the prebuilds are a separate dynamically linked `libvips`, which
is fine, but statically bundling it into one artifact would put the whole bundle under LGPL.

**Clipboard.** `clipboardy 5.3.2` (MIT, 0.88 MB, no native code, zero open issues, read + write, image
read macOS-only, bundles two third-party binaries, no clipboard on headless Linux); `@napi-rs/clipboard
1.1.4` (MIT on npm, **no license file in the repo** — metadata inconsistency — 0.79 MB prebuild, single
maintainer). OSC 52 is write-only in practice: read is off by default in Alacritty (`OnlyCopy`),
unimplemented in Windows Terminal, and permission-prompted in kitty — do not build a read path on it.

**Packaging.** Node SEA is `1.1 - Active development` on 22/24/26, does not cover musl (Alpine) or
darwin-x64 in CI, and `node --build-sea` only exists from v25.5 (absent on LTS 24). Bun `--compile`
cross-compiles (incl. musl) but ships a 60–80 MB runtime and cannot embed `.node` addons (unverified).
**[audit]** npm-installed binaries are not quarantined in the ordinary case — quarantine is opt-in for the
creating app — so notarization is not needed for npm distribution, but this is not an invariant (pnpm
propagates the xattr from its store into `node_modules`), and arm64 binaries still need at least an
ad-hoc signature. A standalone binary distributed as a file *does* require Developer ID + notarization.

## 3. Scope

### In
- `W1` spelling portability (backend split; portable engine for non-darwin).
- `W2` pre-flight token estimation (spike → decision → implementation).
- `W3` image preprocessing via prebuilt codecs (**the compile-dependent workstream**).
- `W4` clipboard read via pure JS.
- Policy, docs, tests, CI and release consequences of the above.

### Out
- The rendering path (`src/ui/md-it.js`, `markdown.js`, `wrap.js`, `src/editor/**`). Its contracts
  (citation marks, table layout, ANSI-safe clipping, grapheme widths, live/replay/rebuild parity) are the
  most expensive thing in the repo to re-pin, and the bottleneck is network I/O, not parsing. A compiled
  markdown parser is explicitly rejected; no benchmark supports revisiting this.
- Build-on-install, `postinstall` compilation, and any dependency that compiles on the user's machine.
- Standalone single-file binaries (SEA/Bun) as a primary distribution; see `W5`.
- Local image generation, speech, embeddings, syntax highlighting and vector search — not proposed here.

## 4. Workstreams

### W1 — spelling portability (no compile required)

Why: `/spelling` is a no-op off macOS today (`src/spelling/index.js:10`), and the runtime-build machinery
is the largest non-feature complexity in the tree. The portable engine is pure JS, so this is a
dependency decision, not a compilation one.

- **W1a — backend split (no behavior change).** Move the shared constants (`SPELLING_TIMEOUT_MS`,
  `SPELLING_MAX_OUTPUT_BYTES`, `SPELLING_ABORTED`) out of `osascript.js` into the spelling module's own
  home; separate the helper's build machinery (probe/hash/compile/sweep/`whenReady`, ~180-200 LOC) from
  its runtime protocol; turn `index.js:10-11` into a platform→backend registry. This is the prerequisite
  for any engine work and is independently testable.
- **W1b — portable engine.** `nspell` + `dictionary-en` behind the existing `run()` contract for
  `check`/`guesses`/`correction`; `check` ranges become a CLI-side tokenizer over the line (nspell has no
  tokenizer), so range parity is re-pinned in tests. **`completions` has no portable backend** — either it
  stays macOS-only (per-feature degradation, documented) or a `.dic` prefix scan is implemented for en
  only; that choice is D2.
- **W1c — prebuilt macOS helper: deferred.** With no publish pipeline, "shipping" a prebuilt binary means
  committing a Mach-O into git (first binary in the repo) or attaching it to releases; the existing lazily
  compiled helper plus osascript fallback already handles absence gracefully. Revisit only if npm
  publishing happens (D4).
- **Fidelity spike before any code:** run nspell against the existing macOS parity corpus (`teh`, `wrold`,
  `recon`, quoted words, URLs/flags, RTL/Cyrillic, emoji) and record divergences.

Tests: the 11 build-machinery tests are deleted with W1c's machinery only when it is actually removed;
W1a re-points them. W1b adds a portable-backend suite plus a cross-backend corpus test, and the
`test/spelling-helper-parity.test.js` real-compile exception stays until W1c.

### W2 — pre-flight token estimation (no compile required)

Why: the app cannot tell whether a prompt will fit before sending it; today it eats the provider error.
This is worth doing only if the estimate is honest and never displaces provider truth.

- **W2a — measurement spike (blocking for W2b).** For 4–6 models across both providers, compare
  `js-tiktoken` (o200k/cl100k) and `@huggingface/tokenizers` + a cached `tokenizer.json` against the
  provider's returned `usage.prompt_tokens` on the same payload. Record the error distribution per family
  and the first-run cache/download cost. If no configuration is within a defensible margin, stop and ship
  nothing (D6).
- **W2b — implementation (only after spike + D5/D6/D7).** One shared estimator module called from
  `turn-runner.js:196-204` and the one-shot twin; the private `estimatePromptTokens` copy is absorbed or
  explicitly kept (D3 of the scout list: one fact, one home). Estimates are labelled as estimates (`~`),
  never overwrite provider numbers, count text + reasoning + the injected post-history instruction, use
  the existing image convention rather than base64 bytes, and show nothing when the model family is
  unknown. UX surfaces and wording are approved before code.

### W3 — image preprocessing via prebuilt codecs (compile-dependent)

Why: attachments are forwarded byte-for-byte; oversized images are rejected, HEIC/AVIF/TIFF (i.e. phone
photos) are rejected, and EXIF (including orientation and GPS) is uploaded as-is. This is the one
workstream that genuinely needs compiled code.

- Dependency: `sharp` via `optionalDependencies` (D8; `@napi-rs/image` is the alternative if HEIC-on-macOS
  via ImageIO is preferred over maintenance mass).
- Seam: `loadAttachment` (`attachments.js:102-143`), preserving the object contract; new constants are
  distinct from generation's `MAX_IMAGE_DIMENSION = 1280` (`constants.js:103`).
- Policy decisions D9: accepted formats (widening `IMAGE_MIMES`, `MIME_EXT` and `REF_NAME_RE` together),
  long-edge/megapixel cap, quality for re-encodes, EXIF orientation baking + metadata stripping,
  whether an original is preserved (the store is content-addressed and never overwrites, so a transform
  changes the hash — an in-place re-store is impossible by construction), and unification of the
  encoded-vs-raw size-limit semantics with the user-facing "(image limit is 20 MB)" text.
- Failure policy: **never regress an attach that works today.** With sharp missing/unloadable, existing
  formats pass through exactly as now; only the new formats fail, with an explicit message. HEIC on
  darwin attempts the OS codec; elsewhere it fails loudly rather than bundling an HEVC codec.
- Tests: codec access is injected (the `spawnFn` precedent), so the suite runs on all three OSes with the
  prebuild absent; add missing-module, load-failure and declined-transform cases.

### W4 — clipboard read (no compile required)

Why: `/copy` writes only, and Linux without `wl-copy`/`xclip`/`xsel` has no clipboard at all.
`clipboardy` (MIT, pure JS) provides read + write with bundled fallbacks; a native addon is unnecessary.
Scope: a `/paste` path for text (and file paths), OSC 52 write as the SSH/no-tool fallback, **no** OSC 52
read. New command + behavior = UX approval, and it lands in the text REPL only (§Text vs Image separation).

### W5 — packaging and startup: measured, rejected

- Node's compile cache: unused, and startup measured inside process noise (72.4 ms baseline vs 70.5 ms for
  `--version`) — do not pursue.
- SEA/Bun: rejected as primary distribution (SEA 1.1, no musl/darwin-x64 CI, `--build-sea` absent on LTS
  24; Bun 60–80 MB and `.node` embedding unverified; LGPL libvips must not be statically bundled;
  standalone binaries require Developer ID + notarization). Conditions that would reopen it: an actual npm
  publish pipeline, and a measured user demand for a single binary.

## 5. Owner decisions (open)

Recommendations are the plan's; each needs an explicit answer before its stage starts.

- **D1 — delivery model.** Prebuilt `optionalDependencies` for native code, committed WASM/pure JS for
  computation, never build-on-install. *Recommend: adopt as written.*
- **D2 — spelling off macOS.** nspell + `dictionary-en` for `check`/`guesses`/`correction`, with
  `completions` staying macOS-only until it is separately approved. *Recommend: adopt; report the
  per-feature degradation in `/spelling` output and docs rather than shipping a divergent completion.*
- **D3 — spelling languages.** Ship en only (MIT+BSD) rather than bundling GPL/MPL dictionaries.
  *Recommend: en only; the user's custom words remain a macOS-system-checker property.*
- **D4 — macOS prebuilt helper.** Defer (no publish pipeline; runtime build + fallback already works).
  *Recommend: defer; revisit with a real release channel.*
- **D5 — token strategy.** Estimate-only, explicitly labelled, provider numbers authoritative; no local
  overflow refusal. *Recommend: adopt.*
- **D6 — tokenizer dependency.** Decide after the W2a spike; the default if the spike is inconclusive is
  "OpenAI encodings exact, no local count elsewhere". Reject the 66.7 MB native `tokenizers` package.
  *Recommend: spike first; scope the dependency to `js-tiktoken/lite` + one rank file.*
- **D7 — pre-flight UX.** Warn-only (the `attachments.js:136` precedent), no new refusal path (contrast
  `budgetGuard`, which is about money, not context). Which of the five surfaces show it, and the wording,
  are a separate UX approval. *Recommend: warn-only in the turn seam; nothing on the banner.*
- **D8 — image engine.** sharp, with HEIC via OS codec on darwin and a loud failure elsewhere.
  *Recommend: sharp (maintenance, provenance, no install script); accept the LGPL dynamic-link terms and
  do not single-file bundle.*
- **D9 — image policy.** Accept `avif`/`tiff` in addition to the current six; cap the long edge (proposal:
  2048 px); bake EXIF orientation then strip metadata; JPEG/WebP quality for re-encodes only; store only
  the transformed blob; unify the encoded-vs-raw limit and fix the "(image limit is 20 MB)" wording.
  *Recommend: adopt, with the cap and quality confirmed by the owner as a UX decision.*
- **D10 — clipboard scope.** Text (+ file paths) read via `clipboardy`, OSC 52 write fallback, no OSC 52
  read, no image clipboard in v1. *Recommend: adopt.*
- **D11 — packaging.** Do not pursue SEA/Bun now. *Recommend: adopt; record the reopening conditions.*
- **D12 — dependency-policy wording.** The `AGENTS.md` §Compiled artifacts section on this branch is the
  binding rule; `README.md:38` and `docs/platforms.md:5,16` are updated in the same commit as the first
  dependency that invalidates them (never ahead of it). *Recommend: adopt.*

## 6. Stages

### Stage 0 — baseline (this branch)
- [x] Branch `docs/compilation-plan` from `main` at `5e26bb8`, clean tree.
- [x] Record the gate: `npm test` 2250/2250, `npm run lint` clean.
- [x] Write this plan and the `AGENTS.md` policy section; commit as docs-only. **No merge, no push.**

### Stage 1 — owner answers D1–D12
- [ ] Record answers in this file (same shape as `SURFACE-CLEANUP.md`'s "Owner decisions (resolved)").
- [ ] Only then open the first implementation branch.

### Stage 2 — W1a backend split (no UX change)
- [ ] Relocate shared constants; split build machinery from the runtime protocol; platform→backend
      registry in `src/spelling/index.js`.
- [ ] Re-point the 17 build-machinery tests; add a registry/gate test.
- [ ] Gate: `npm test`, `npm run lint`, `npx knip`, docs-consistency clean.

### Stage 3 — W1b portable engine (UX gate: new platform behavior)
- [ ] Fidelity spike vs the macOS corpus; record divergences in `MEMORY.md`.
- [ ] Implement the portable backend behind the existing contract; per-feature degradation for
      `completions`.
- [ ] Update `MEMORY.md` (§macOS spelling semantics), `README.md:29`, `docs/platforms.md`,
      `docs/commands.md`, `docs/development.md` module tree, and the `/spelling` help text.

### Stage 4 — W2 tokens (UX gate)
- [ ] W2a spike, recorded with numbers in this file; stop if inconclusive.
- [ ] W2b estimator + one seam, or an explicit "no estimate" outcome; tests in `tracker`, `turn-runner`,
      `one-shot`, and the resume path.

### Stage 5 — W3 images (UX gate: formats, limits, messages)
- [ ] Dependency + lockfile + `knip.json`; docs claims updated in the same commit as the dependency.
- [ ] Transform step at the seam with injected codec; post-transform size re-check; store/hash decisions
      implemented and pinned; existing-format passthrough preserved when the codec is absent.
- [ ] Docs: `docs/attachments.md`, `docs/platforms.md`, `README.md` limits/wording.

### Stage 6 — W4 clipboard read (UX gate)
- [ ] `/paste` in the text REPL; OSC 52 write fallback; docs `docs/commands.md`, `README.md:31`.

### Stage 7 — release
- [ ] Version bump (MINOR for new capabilities; note any behavior change as breaking if it alters accepted
      input or limits), `npm install --package-lock-only`, changelog-style tag commit per `AGENTS.md`.
- [ ] Fold outcomes into `MEMORY.md`; mark this plan completed or delete it per the `SURFACE-CLEANUP.md`
      precedent; CI green on all three platforms; merge + tag + push.

## 7. Verification matrix

| Stage | Must behave as stated |
|---|---|
| 2 | `/spelling` behavior on macOS is byte-identical (same tests, same corpus); registry selects the same backend; no new dependency |
| 3 | `/spelling` works on Linux/Windows CI without a toolchain; `completions` degrades as documented; macOS corpus parity recorded; suite still key-free, network-free, `HOME`-sandboxed |
| 4 | Estimates labelled as estimates; provider numbers unchanged; one-shot and chat show the same value; unknown family shows nothing |
| 5 | A 24 MP JPEG attaches within limits after downscale; HEIC fails with an explicit message (or works via OS codec on darwin); EXIF orientation survives; existing formats unchanged when the codec is missing; session refs hydrate |
| 6 | `/paste` in text REPL; OSC 52 fallback over SSH; no image clipboard; Linux clipboard-tool absence no longer breaks copy |
| 7 | Full gate + `npx knip` + docs-consistency + CI on macOS/Ubuntu/Windows × 22/24 |

## 8. Risks and rollback

- **Docs promise vs reality.** `README.md:38` and `docs/platforms.md:5,16` say "pure Node.js ESM / no
  native dependencies". Any stage adding a native dependency must update them in the same commit; the
  claims are not test-pinned, so only review catches drift.
- **CI coverage gaps.** The matrix is macOS-arm64 + Linux-x64 + Windows-x64; darwin-x64, linux-arm64 and
  musl are untested, so prebuild breakage on those targets ships silently. Extend the matrix in the same
  stage that introduces the first prebuild.
- **`npm audit` surface.** `--omit=dev --audit-level=high` audits optional packages; one high advisory in
  a platform package reds all three legs. Decide the policy (upgrade, override, or document) before
  adding sharp.
- **Test hermeticity.** No network block exists in the runner; a dependency that downloads at first use
  must be an explicit, injected seam and must not run in tests.
- **Image contract regressions.** Transformed bytes change content hashes, dedupe, export materialization
  and replay labels; the encoded-vs-raw limit split is already inconsistent and must not be duplicated
  into the new path.
- **LGPL/patents.** Dynamic linking keeps libvips' LGPL satisfied; single-file bundling would relicense
  the bundle. HEVC/HEIC and (contested) AV1 pools are a legal call, not an engineering one.
- **Baseline drift.** Test counts and doc counts (spelling block, module tree, command counts) are pinned
  by `test/docs-consistency.test.js`; update them in the same stage.
- Rollback: each stage is one commit on its own branch; `git revert` or dropping the branch restores the
  previous behavior. No stage requires a preference migration, and no compiled artifact is ever committed
  unless D4 is explicitly revisited.

## 9. Explicitly not doing

- Compiling anything on the user's machine at install time (policy §1).
- A compiled markdown/ANSI renderer or editor (contract cost, no measured benefit).
- Bundling an HEVC/HEIC codec (`sharp` prebuilds have none; patent-encumbered).
- The 66.7 MB native `tokenizers` package, `nodehun` (no prebuilds), `hunspell-asm` (2020), and every
  package whose `engines` excludes `>=22.15.0`.
- GPL/MPL dictionaries in the shipped package.
- OSC 52 clipboard read.
- SEA/Bun single-file distribution as a primary artifact.

## 10. Done criteria

- D1–D12 answered and recorded in this file.
- Each landed stage has a green gate (`npm test`, `npm run lint`, `npx knip`, docs-consistency) and its
  own commit; user-visible stages passed their UX approval.
- `README.md`, `docs/`, `MEMORY.md` and `AGENTS.md` describe only behavior that exists; the "no native
  dependencies" claim is gone or scoped exactly as the shipped code requires.
- The suite remains hermetic on all three CI OSes with prebuilt artifacts absent.
- When the last stage lands, this plan is folded into `MEMORY.md` and marked completed or deleted.

## Provenance

Synthesized from seven delegated lanes run against `5e26bb8`: four repo scouts (spelling, tokens, images,
infra), two external research briefs (spelling+tokenizers; codecs+packaging+clipboard), and one
`evidence-auditor` pass over the six load-bearing external claims. All repo citations were taken from the
current tree; the external tables carry the audit's corrections, and unsupported claims were dropped
rather than softened. The lanes' raw reports are retention-managed session artifacts, deliberately not
copied into the repo.
