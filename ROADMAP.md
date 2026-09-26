# Roadmap — standing candidate arcs

Candidate work that is **not** committed to a release. Each entry records why the arc is worth
considering, what would reopen it if deferred, and where the evidence lives. Nothing here is a
promise or an approval: a candidate becomes work only after the owner approves a scope, and it gets
its own plan document then (the `COMPILATION-PLAN.md` / `SURFACE-CLEANUP.md` pattern). When an arc
lands, fold its facts into `MEMORY.md` and replace its entry with a completed pointer.

`KNOWN-ISSUES.md` stays defects-only; this file is for candidates, not bugs.

Last reviewed: 2026-09-26.

## 1. Context-overflow behavior — landed in `5.5.0`

**Fixed:** `contextLength` was display-only and an over-window request surfaced as the generic
provider error. The shipped reactive package: one classifier for both wire shapes (pre-flight 400
with typed codes or provider wording; mid-generation HTTP 200 + SSE error), honest
pre-flight/mid-generation messages naming the recovery (`/edit`, `/delete`, `/new`, larger-window
`/model`), `finishReason` persisted on assistant messages with truncation and early-end notices on
live/replay/export/one-shot parity paths, per-reason empty-answer classification with one-shot exit
1 (`length` / `content_filter` / `error` non-retryable, `stop` / null unchanged), and
provider-reported usage captured on post-stream Esc-stopped turns.

**Still open from the arc:** reasoning-only `length` salvage (`KNOWN-ISSUES.md`); the OpenRouter
≤8k silent-compression residual (`OPENROUTER.md`); the pre-send notice and the `/retry` guard were
rejected unanimously, and a local tokenizer stays rejected by S3 (`COMPILATION-PLAN.md` §W2).

**Evidence:** the shipped behavior is in `MEMORY.md` §Error handling contract and the display
contract, with the public copy in `docs/chat.md` and `docs/sessions.md`.

## 2. Prebuilt macOS spelling helper — deferred by decision

A prebuilt helper would remove the one-time lazy compile (`src/spelling/helper-backend.js`) and the
Command-Line-Tools requirement for the native path, shipped as a per-platform
`@vioni/communicator-*` optional dependency. The npm publish channel now exists, so the original
blocker ("no publish channel") is gone — but the osascript fallback already covers machines without
CLT, and the compile machinery must stay for the artifact-absent case, so the change adds a build
pipeline without deleting code or fixing a visible failure (working rule).

**Reopen when:** users actually hit the compile path as a problem (slow first check, CLT-less
native-path need), or a Windows/Linux equivalent wants the same channel.

**Evidence:** `COMPILATION-PLAN.md` D4/§6; `MEMORY.md` (spelling helper backend).

## 3. Single-file SEA/Bun distribution — deferred by decision

**Reopen when:** measured demand exists and the recorded blockers clear (no `--build-sea` on LTS 24,
musl/darwin-x64 gaps, LGPL codec relicensing). Startup is already inside process noise (70.5 ms vs
72.4 ms bare), so the case is distribution convenience, not speed.

**Evidence:** `COMPILATION-PLAN.md` D11/§6; `AGENTS.md` §Compiled artifacts.

## 4. Local tokenizer / exact counting — closed by spike (S3)

Rejected on measurement: only the GPT-family slice is exact (o200k 0.0% vs provider counts);
Llama 3.x 2.4%, DeepSeek 4.5%, Qwen 9.7%, Mistral 12.2%, Gemini 15.3%. Provider-reported usage
stays the truth and the `CTX:` row already shows it after every turn.

**Reopen when:** a hard pre-flight budgeting need appears (not a warning) and new measurements
justify it; do not re-add a local counter before that.

**Evidence:** `COMPILATION-PLAN.md` §W2/S3; `MEMORY.md` (tokenizer bullet).
