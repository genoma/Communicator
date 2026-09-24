# Compilation plan — allowing compiled artifacts

**Status: completed in `5.3.0`.** All four stages landed on `main`: S1 (image preprocessing) in `5.1.0`, S2
(avif/tiff + the macOS HEIC bridge) in `5.2.0`, S3 closed as a measured spike with no code, S4 (portable
spelling on Linux/Windows) in `5.3.0`. The binding policy lives in `AGENTS.md` §Compiled artifacts; the
per-stage implementation facts live in `MEMORY.md`. Deferred by decision: the prebuilt macOS spelling helper
(no publish channel), clipboard read, and single-file binaries — see §2 and §6 for the decision text and the
conditions that would reopen each.

Baseline (re-run on this branch): `npm test` **2250/2250, 0 fail, 0 skipped** (119 suites, Node 26.9.0,
macOS 27.0/M5), `npm run lint` and `npx knip` clean. CI runs the same gate on macOS/Ubuntu/Windows ×
Node 22/24.

**Working rule (owner's, applies to every stage below):** a stage must either delete code, fix a
user-visible failure or lie, or make a platform work. If it does none of those, it does not ship. One seam
plus an injectable dependency beats new machinery. No new config, no new flags, no speculative generality.

## 1. Policy

The binding summary lives in `AGENTS.md` §Compiled artifacts. In one paragraph: compiled code is allowed,
but the user's machine never compiles at install time; native code arrives as prebuilt per-platform
packages (`optionalDependencies`, the esbuild/sharp/biome pattern) and computation as committed WASM or
pure JS; every artifact loads behind `try`/`catch` at feature scope and the feature degrades like the
existing platform gates (clipboard probe, spelling darwin gate); tests must pass with the artifact absent
via an injected seam, with real-artifact tests skipping; a dependency still needs a reason, and the
"five runtime dependencies / no native dependencies" claims in `README.md` and `docs/platforms.md` change
in the commit that makes them false — never ahead of it.

The finding that shapes everything below: **compilation buys exactly one capability in this application —
local image decoding.** Cross-platform spelling, token estimation and clipboard access are pure JS/WASM
and were gated by the dependency policy, not by compilation. Two items from the first draft of this plan
are therefore cut (`D10`, and the `W1a` refactor) and one is reduced to a timeboxed spike (`D6`).

## 2. Owner decisions (resolved 2026-09-24)

| # | Decision | Answer |
|---|---|---|
| D1 | Delivery model | **Adopt**: prebuilt `optionalDependencies` for native code, committed WASM/pure JS for computation, never build-on-install. |
| D2 | Spelling off macOS | **Yes**: nspell + English dictionary for `check`/`guesses`/`correction`. `completions` stays **macOS-only** — the portable backend answers an empty list rather than shipping a divergent prefix-scan word list. |
| D3 | Spelling languages | **English only** (MIT AND BSD). No GPL/MPL dictionaries in the package. |
| D4 | Prebuilt macOS spelling helper | **Defer.** There is no publish channel to carry a binary (commit it to git or nothing); the lazily compiled helper plus osascript fallback stays exactly as-is. Revisit with a real release channel. |
| D5 | Token strategy | **Yes**: estimates only, labelled as estimates, never authoritative; provider-reported numbers stay the truth. |
| D6 | Tokenizer | **Spike first, timeboxed; default outcome is "ship nothing."** If the spike passes: exact counts for OpenAI-family via `js-tiktoken/lite` + one rank file (~2.4 MB), nothing (or a clearly labelled estimate) elsewhere. The 66.7 MB native package and per-family `tokenizer.json` downloads (2–17 MB each) are rejected for now. |
| D7 | Pre-flight UX | **Warn-only.** No refusal path. Surfaces and wording are a separate UX approval. |
| D8 | Image engine | **Yes: sharp.** Prebuilt per platform, no install script, metadata stripped by default. |
| D9 | Image policy | **Yes**: accept `avif`/`tiff` in addition to the current six; long-edge cap **2048 px**; bake EXIF orientation then strip metadata; re-encode quality only when a transform is needed; store the transformed blob only; unify the encoded-vs-raw size semantics and fix the misleading `(image limit is 20 MB)` text. **HEIC**: decode through the macOS OS codec only (sharp's prebuilds ship no HEVC), loud failure elsewhere — never bundle a codec. |
| D10 | Clipboard read | **Cut.** The terminal already pastes into the prompt and `/copy` works; a new dependency plus a new command for marginal gain fails the working rule. Revisit only on a concrete user report. |
| D11 | Single-file binary (SEA/Bun) | **No.** Reopen only with a published npm channel and measured demand. |
| D12 | Docs claims | **Same-commit rule**: `README.md`/`docs/platforms.md` are updated in the commit that invalidates them. |

**Plan changes from the first draft (owner-approved cuts):** the `W1a` spelling refactor (backend split,
constants relocation, platform registry) is **dropped** — the non-macOS backend slots behind the existing
one-line gate (`src/spelling/index.js:10`) with no refactor; and `W4` clipboard read is cut (D10).

## 3. Workstreams, in order

### W1 — images: real files, honest limits (compile-dependent, first)

Why first: the only workstream that fixes something users hit daily — phone photos are rejected, a 12 MP
photo is uploaded at full size (slow, expensive), EXIF location and the orientation flag go along for the
ride, and an oversized image is rejected by a message that names the wrong number. It is also the
precedent that makes the new policy real.

- **Dependency**: `sharp` as a regular dependency; its per-platform binaries come from its own
  `optionalDependencies`, so install never fails, and a load failure degrades to today's passthrough.
- **Seam**: `loadAttachment` (`src/attachments.js:102-143`), between `readFile` (`:128`) and the return
  branches (`:135`, `:142`), preserving `{kind, filename, mime, size, data}`. Injected like the existing
  deps (`test` fakes it; the default lazily imports sharp). Provider request builders are untouched —
  both providers forward the parts array verbatim (`src/providers/openrouter.js:370-373`,
  `src/providers/venice.js:300`).
- **Behavior**: images decode → rotate per EXIF, strip metadata, downscale when the long edge exceeds
  2048 px, re-encode (quality for lossy formats only); `mime`/`size`/`data` are updated and the size
  limit is re-checked on the **final** payload. Decode failure falls back to passthrough for formats that
  work today and errors honestly for the new ones.
- **Format expansion** (`avif`, `tiff`): extend `IMAGE_MIMES`, `MIME_EXT` and the store's `REF_NAME_RE`
  together (`src/attachments.js:6-14,24-35`, `src/attachment-store.js:11-16,124-127`).
- **HEIC (second step of this workstream)**: macOS OS-codec bridge (the app is macOS-first and `sips` is
  built in), loud failure elsewhere. Tested on macOS CI with a fixture generated at test time (`sips`
  from a PNG), skipped where unavailable. No codec is ever bundled.
- **Tests**: fake seam for the suite; one real-codec test that skips if sharp is absent; oversized →
  downscaled; EXIF orientation fixture generated with sharp at test time; missing/declined transform
  leaves today's formats byte-identical.
- **Docs**: `docs/attachments.md`, `docs/platforms.md`, `README.md` limits — same commit as the dependency.
- **UX gate**: accepted formats, the pixel cap, the re-encode quality and the error wording were approved
  with D9; the printed size for a transformed image was approved on 2026-09-24 (the sent payload).

### W2 — pre-flight tokens: measure before claiming (spike only)

Why: the app cannot tell whether a prompt fits before sending it. Why it stays a spike: nobody has
measured how wrong the cheap route is for non-OpenAI families, and a confidently wrong token counter is
worse than none.

- **Spike (timeboxed)**: 5–6 real prompts/models across both providers; compare `js-tiktoken`
  (cl100k/o200k) against the provider's returned `usage.prompt_tokens` for the same payload; record the
  error distribution. OpenRouter's `architecture.tokenizer` is a family tag, not an encoding — useful for
  choosing a vocabulary, not sufficient on its own.
- **Ship criteria**: only if exact within a few percent for the families we claim. Otherwise stop and
  write the "no local tokenizer" outcome into `MEMORY.md`.
- **If it ships**: one shared estimator called from `src/turn-runner.js:196-204` and the one-shot twin
  (`src/commands/one-shot.js:145-215,263,272`); the private `estimatePromptTokens`
  (`src/providers/openrouter.js:25-40`) is absorbed, not duplicated; estimate-only labelling; nothing
  rendered for unknown families.
- **UX gate**: every visible surface and its wording.

### W3 — spelling on every platform (no compile required)

Why: `/spelling` is a no-op off macOS (`src/spelling/index.js:10`) while the engine that fixes it is
0.6 MB of pure JS. Deliberately the smallest possible change: **the macOS stack is untouched.**

- **Add** `src/spelling/nspell.js`: a backend with the same `run(request, { signal })` contract, backed by
  `nspell` + an English dictionary loaded lazily. `check` returns word-aligned ranges from a CLI-side
  tokenizer (nspell has no tokenizer); `guesses`/`correction` map to suggest; `completions` answers
  `{ words: [] }`, which the provider already caches as a silent negative — no provider change, no editor
  change.
- **Change** `src/spelling/index.js:10-11` to select the backend by platform. No refactor, no registry, no
  constant relocation, no change to `helper.m`, `osascript.js` or the build machinery.
- **Tests**: a backend suite (ops, ranges, quoting, empty/unloadable dictionary, abort-ignored) plus the
  existing gate tests; the darwin gate tests are rewritten for the new selection and the darwin side stays
  byte-identical.
- **Docs**: `README.md:29`, `docs/platforms.md`, `docs/commands.md`, the `/spelling` block and the
  spelling section of `MEMORY.md`.
- **UX gate**: the `/spelling` help text and the one-line note that completions are macOS-only.

### W4 — deferrals (no work now)

Prebuilt macOS helper (D4), clipboard read (D10), single-file binary (D11), and every item in §6.

## 4. Verified seams (do not re-derive)

- **Spelling**: backend contract is `run(request, {signal}) → Promise<answer|null>` (`src/spelling/provider.js:169`)
  plus optional `dispose?.()` (`:412`). Any rejection counts toward the 3-failure session latch
  (`:172-183`), which the provider's `disposed`/`disabled` guard skips on abort. Requests:
  `{op:'check',text}` / `{op:'completions'|'guesses'|'correction',text,location,length}`. Replies:
  `{ranges:[[start,length],…]}` / `{words:[…]}` / `{correction:string|null}` / `{error}` (rejects).
  macOS-only semantics that must not be claimed elsewhere: the user's active dictionary set (nil language
  on purpose) and learned words.
- **Images**: path is `/attach` → `loadAttachments` → `classifyPath`/`loadAttachment` → `buildContent` →
  `toPart` → provider. Limits: images compare **base64-encoded** length against 20 MiB
  (`src/attachments.js:114-117`; raw ceiling ≈15.0 MiB) while the download path applies the same constant
  to raw bytes (`src/attachment-store.js:170`) — the inconsistency D9 unifies. Image formats at this
  snapshot: `png jpg jpeg gif webp bmp`; HEIC/AVIF/TIFF/SVG hard-fail at `:93-104` (S1 unified the limit;
  S2 made `avif`/`tif`/`tiff`/`heic`/`heif` must-convert formats — see the stage entries in §5). Store is
  content-addressed
  (`sha256.<ext>`, never overwritten) with mime rebuilt from the extension on hydrate (`:124-127`).
  Capability gating happens only at attach time; `hydrateAttachments` has no gate (pre-existing gap, not
  in scope).
- **Tokens**: all provider-reported except `estimatePromptTokens` (`chars/4`, images 340) whose only
  consumer is the Anthropic cache TTL choice (`src/providers/openrouter.js:25-40,379-383`); no pre-flight
  check, no history trimming, no context-overflow branch (`src/errors.js:130` generic); `maxCompletionTokens`
  fetched and dropped. `contextLength` is display/persistence only (`src/status-line.js:59`,
  `src/tracker.js:135,170`, `src/chat.js:239-240`).
- **Infra**: `process.platform` branches are the clipboard probe (`src/clipboard.js:3-11`), the spelling
  gate, the helper hash, the macOS toolchain paths, the `/spelling` visibility gate, and — added by S2 —
  the attachment HEIC gate (`src/attachments.js:111`) and the `sips` bridge (`src/heic-decode.js:14`).
  Test hermeticity (cleared keys/color, throwaway `HOME`, one process per file) lives in
  `scripts/run-tests.js`; there is no network block, so a new artifact must be injectable. Startup is
  inside process noise (70.5 ms vs 72.4 ms bare) — not a compile target.

## 5. Stages

Each stage is its own branch off `main`, one commit per logical step, gate before moving on.

- **S0 — done (this branch).** Policy + plan, docs-only.
- **S1 — done (`5.1.0`).** `src/image-transform.js` (lazy optional sharp, EXIF bake, 2048 px long edge,
  50 MP decode cap, metadata stripped, byte-for-byte passthrough on every failure incl. gif and animated
  WebP/PNG), the `loadAttachment`/`loadAttachments` seam with an injected transform, raw-bytes limits for
  every kind plus a post-read re-check, docs and MEMORY in the same commit. Gate: `npm test` 2266/2266,
  lint, knip and `npm audit --omit=dev` clean, suite green with sharp physically absent. The
  encoded-payload bound (~4/3 of the raw limit) is documented, not enforced.
- **S2 — done (`5.2.0`).** `avif`/`tif`/`tiff`/`heic`/`heif` accepted as must-convert formats: they re-encode to
  `jpeg` (or `png` when the decoded image has alpha) and can never fall back to raw provider-unsupported
  bytes; HEIC/HEIF decode through the macOS `sips` bridge (lazy, no bundled codec, no spawn off darwin)
  and are rejected elsewhere with an explicit message. `MIME_EXT` extended so produced artifacts
  round-trip. Six review lanes: no blockers; unread stderr pipe dropped, docs and this plan updated in the
  same change.
- **S3 — done (spike only, nothing shipped).** Two lanes measured `js-tiktoken` (cl100k/o200k) against 62
  provider responses across six OpenRouter families and two Venice models, with a per-model chat-template
  overhead probe, repeat runs, and an independent methodology audit (verdict: sound with notes; the
  supervisor re-derived the local counts exactly). Worst payload-relative error after correcting overhead:
  GPT 0.0% (o200k), Llama 3.x 2.4%, DeepSeek 4.5%, Qwen/Venice-e2ee 9.7%, Mistral 12.2%, Gemini 15.3%,
  Venice mercury 14.5% with shape-dependent accounting. Decision: **no local tokenizer ships** — the only
  defensible slice (GPT-family o200k) needs a hand-maintained model→encoding map, and the CTX row already
  shows provider-exact counts after each turn. Reopen only with a hard pre-flight budgeting need and new
  measurements; the spike's raw requests/responses live outside the repo. Side facts: the same tokenizer
  answers identically across routes (Venice `e2ee-qwen-2-5-7b-p` with the system prompt off == OpenRouter
  `qwen-2.5-7b-instruct` on Phala: 30/490/447/452/267), and Venice's default system prompt costs ~1.7k
  tokens per request (the app disables it, see MEMORY.md §Known quirks).
- **S4 — done (`5.3.0`).** `src/spelling/nspell.js` (pure-JS nspell over `dictionary-en`, code-unit tokenizer,
  lazy memoized dictionary, same `run()` contract) selected for every non-darwin platform; the macOS stack
  is untouched. `completions` answers the empty list off darwin (documented degradation). Because nspell
  ranks a one-character replacement above an adjacent transposition (`teh` → `ten`), the portable backend
  autocorrects only a verified adjacent swap that the dictionary and the engine both accept, and leads the
  replacement list with it; other typos stay user-picked. Six review lanes found the smart-quote (`’`) token
  bug and nine bookkeeping notes, all applied.

## 6. Explicitly not doing

- Installing or compiling anything on the user's machine (policy).
- A compiled markdown/ANSI renderer or editor — its contracts (citation marks, table layout, ANSI-safe
  clipping, grapheme widths, live/replay/rebuild parity) are the most expensive thing in the repo to
  re-pin and the bottleneck is network I/O. No measured benefit.
- Bundling a HEVC/HEIC codec; GPL/MPL dictionaries; the 66.7 MB native tokenizer; `nodehun` (no
  prebuilds); packages whose `engines` excludes `>=22.15.0`.
- OSC 52 clipboard read; clipboard read at all (D10).
- Single-file SEA/Bun distribution; Node's compile cache.
- The `W1a` spelling refactor (dropped) and any new config/flag for anything above.

## 7. Risks and rollback

- **Docs drift**: the "pure ESM / no native dependencies" claims are prose, not test-pinned; only review
  catches a missed same-commit update.
- **CI gaps**: the matrix is macOS-arm64 + Linux-x64 + Windows-x64; darwin-x64, linux-arm64 and musl are
  untested, so a prebuild break there ships silently. Extend the matrix in the stage that adds the dep.
- **Audit surface**: `npm audit --omit=dev --audit-level=high` audits platform packages; one high advisory
  reds all three legs. Decide (upgrade/override/document) before adding sharp.
- **Attachment contract**: transformed bytes change content hashes, dedupe, export materialization and
  replay labels; the encoded-vs-raw split must be unified once, not copied.
- **LGPL**: sharp dynamically links libvips (fine); never statically bundle it into one artifact.
- Rollback: every stage is one branch; revert or drop it. No preference migration, no committed binaries.

## 8. Done criteria

- S1–S4 landed or explicitly closed (including "spike says no").
- `README.md`, `docs/`, `MEMORY.md` and `AGENTS.md` describe only behavior that exists.
- The suite stays hermetic on all three CI OSes with the native artifact absent.
- This plan is folded into `MEMORY.md` and marked completed or deleted.

## Provenance

Written from seven delegated lanes run against `5e26bb8`: four repo scouts (spelling, tokens, images,
infra), two external research briefs (spelling+tokenizers; codecs+packaging+clipboard) and one
`evidence-auditor` pass over the six load-bearing external claims. Repo citations come from the current
tree; the external facts carry the audit's corrections (sharp is not the only full prebuild matrix;
libvips packages declare LGPL-3.0-or-later; measured `tokenizer.json` sizes are 2–17 MB, not 9–33 MB;
`architecture.tokenizer` is a family tag, not an encoding; npm-installed binaries are not quarantined in
the ordinary case but that is not an invariant). Raw lane reports are retention-managed session artifacts,
deliberately not copied into the repo.
