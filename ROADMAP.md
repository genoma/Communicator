# Roadmap — standing candidate arcs

Candidate work that is **not** committed to a release. Each entry records why the arc is worth
considering, what would reopen it if deferred, and where the evidence lives. Nothing here is a
promise or an approval: a candidate becomes work only after the owner approves a scope, and it gets
its own plan document then (the `COMPILATION-PLAN.md` / `SURFACE-CLEANUP.md` pattern). When an arc
lands, fold its facts into `MEMORY.md` and replace its entry with a completed pointer.

`KNOWN-ISSUES.md` stays defects-only; this file is for candidates, not bugs.

Last reviewed: 2026-09-26.

## 1. Context-overflow behavior — investigated, recommendation awaiting owner approval

**Gap:** `contextLength` is display-only (status line and the `CTX:` row). There is no pre-flight
check, no history trimming and no overflow branch: a request that exceeds the window surfaces as the
generic provider error (`src/errors.js`, 4xx path), and `peakContext` shows the damage only after
the fact. S3 (`COMPILATION-PLAN.md` §W2) measured local token counting for a pre-flight warning and
rejected it (worst-family error 15.3%).

**Investigation (2026-09-26):** recon + adversarial verification + council (2 oracles + 1 reviewer,
two passes; artifacts under the session's `subagent-artifacts/recon` and `audit`). Converged
recommendation — a reactive, dependency-free package:

1. one shared overflow classifier for both wire shapes — pre-flight 400 (typed codes first:
   OpenRouter `context_length_exceeded`, Venice `TOO_MANY_TOKENS`) and mid-generation HTTP 200 + SSE
   error / `finish_reason: "error"` — replacing the generic message with an honest, actionable one
   naming the recovery (`/edit`, `/delete`, `/new`, `/model`) and keeping the user message;
2. `finish_reason` truth: persist an optional `finishReason` on assistant messages, surface
   truncation (`length` with content), classify empty completions per reason (`length` and
   `content_filter` non-retryable, `error` reworded without overflow attribution), salvage streamed
   reasoning on reasoning-only turns, and give one-shot non-zero-exit parity on an empty answer;
3. record provider-reported usage when a stream errors or an Esc-stopped turn was billed.

Rejected by the council: pre-send proximity notice, `/retry` guard, local tokenizer,
auto-compaction, client trimming, and opting into server-side compression. Documented residual:
OpenRouter ≤8k-context routes compress by default (disableable per request, invisible in responses;
account-level "Prevent overrides" can force it).

**Pending owner decisions:** approve the UX (overflow wording, truncation notice, empty-answer
behavior), whether the usage-capture item ships in the same slice, and whether to add the explicit
compression opt-out (it converts silent server-side truncation into a loud failure on ≤8k routes).

**Evidence:** council memo of 2026-09-26; `COMPILATION-PLAN.md` §W2/S3; `src/errors.js` (4xx path),
`src/sse-parser.js` (stream error), `src/turn-runner.js` (empty-output verdict), `src/status-line.js:59`,
`src/tracker.js:46`.

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
