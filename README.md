# Communicator

A terminal-first AI chat client for **OpenRouter** and **Venice.ai** — stream responses with visible reasoning, pick models and providers interactively, track live usage and cost with per-session budget caps, search the web with clickable sources, and resume or export any conversation as markdown.

## Features

- **Multi-provider** — OpenRouter and Venice.ai backends, switchable via `--provider`. Adding new providers is straightforward via the provider abstraction layer
- **Interactive model picker** — searchable and filterable by name or model ID, with context-length display
- **Provider selection** — compare pricing, uptime %, and routing tags before starting a chat. Single-provider models skip this step automatically. Navigate back to the model picker at any time. Venice models are directly available (no multi-provider routing)
- **Reasoning effort control** — per-model effort level persisted across sessions. Only shown for models that support reasoning. OpenRouter uses its native reasoning format; Venice uses standard OpenAI `reasoning_effort`
- **Temperature control** — `--temperature <0-2>` flag, `/temp` command, per-model default persisted in preferences
- **Web search** — three modes per model (`off`, `auto` = model decides when to search, `always` = force a search every request) via `--web-search`/`/web-search`. OpenRouter lets you set the result count (`--web-results <n>`, `/web-results <n>`); Venice has no result-count knob
- **File & image attachments** — attach images, PDFs, office files, and text/code files to messages with `/attach <path>...` (interactive) or `--attach <path>` (one-shot). Images require a vision-capable model; PDFs and text files work anywhere; office files (xlsx/docx/pptx) are extracted server-side on Venice only
- **One-shot mode** — pass a prompt argument or pipe input via stdin for a single non-interactive answer. TTY-aware output: styled with usage footer on a terminal, plain answer text only when piped
- **Per-session budget caps** — `--budget <usd>` or `/budget <usd>` limits accumulated session cost; warns at 80% used and refuses turns at 100%
- **Zero data retention** — `--zdr` (OpenRouter only) forces every request through zero-data-retention routing: no caching, no logging, no training. Under `--zdr` the model and provider pickers show only ZDR-capable entries, endpoints are tagged `[zero retention]` in the provider picker and `zdr yes` in `--list-endpoints`, and every provider row links to its privacy policy; `--list-models` marks models with a ZDR-capable endpoint as `[zdr]`
- **Terminal markdown rendering** — responses are styled in the terminal (headers, bold/italic, code blocks, lists, quotes, links) with a `/markdown` toggle
- **Streaming responses** — tokens appear as they arrive, with reasoning tokens shown in gray under a `❯ Thinking` banner and a `❯ Answer` separator before the final response
- **Smooth streaming** — in interactive sessions, incoming text is paced (default on) so answers render at a steady character rate instead of popping in bursts after a long wait; disable with `--no-smooth-streaming` or `/smooth off`. A dim waiting indicator (`Waiting for response...`, or `Searching the web...` when a search is guaranteed) shows while the model is still working
- **Usage & cost tracking** — after each turn: prompt / completion / total token counts, a context-window usage indicator (CTX), cache hit detection (OpenRouter), and a dollar-cost breakdown (per turn + cumulative session total). Check anytime with `/cost`
- **Slash commands** — `/new` starts a fresh session, `/model` switches models mid-chat, `/reasoning` re-picks the reasoning effort, `/temp` sets temperature, `/budget` sets/shows the budget, `/web-search` sets the web search mode, `/web-results` sets the result count, `/attach` queues files, `/attachments` lists/clears the queue, `/retry` re-runs the last turn, `/copy` copies the last response, `/markdown` toggles rendering, `/smooth` sets smooth streaming, `/cost` shows the running total, `/quit` exits
- **Session auto-save** — every chat is saved as a JSON file in `~/.communicator/sessions/`, with an auto-generated title from the first user message. Sessions are saved when you quit, switch models, start a new session, or interrupt with `Ctrl+C`, so the last exchange is never lost
- **Session resume** — restore any past conversation with `--resume`, keeping the same model, provider, reasoning effort, temperature, and budget. Automatically detects and uses the correct API backend. Supports prefix matching and an interactive picker
- **Session deletion** — remove saved sessions with `--delete` (with confirmation)
- **Markdown export** — export any saved session as a clean markdown file with `--export`, with separate thinking sections and cost summary
- **Session persistence** — last model, provider, and per-model reasoning effort and temperature are saved to `~/.communicator.json` and restored on next launch
- **CLI flags to skip pickers** — `-m` skips *all* pickers (model, reasoning, endpoint) for fully non-interactive use; `--reasoning-effort` (or `--reasoning-effort none`) skips only the reasoning picker
- **Lightweight** — four runtime dependencies, pure Node.js ESM

## Documentation

Guides in the [`docs/`](docs/) folder cover specific workflows in depth:

- 📘 **[`docs/commands.md`](docs/commands.md)** — Full usage examples: one-shot mode, session management, reasoning, web search, and standalone config commands
- 📕 **[`docs/sessions.md`](docs/sessions.md)** — Session persistence: listing, resuming, deleting, exporting, and the on-disk session file format

## Requirements

- **Node.js** >= 22.3

### API Keys

At least one of:

| Provider   | Env variable          | Get a key at                          |
|------------|-----------------------|---------------------------------------|
| OpenRouter | `OPENROUTER_API_KEY`  | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Venice.ai  | `VENICE_API_KEY`      | [venice.ai/settings/api](https://venice.ai/settings/api) |

You can set up both to switch between them at runtime.

## Install

```bash
git clone https://github.com/YOUR_USERNAME/communicator.git ~/Communicator
cd ~/Communicator
npm install
npm link
```

`npm link` creates a system-wide symlink so `communicator` is available from any terminal. The exact path depends on your Node.js installation:

| Setup                                   | Symlink path                              |
|-----------------------------------------|-------------------------------------------|
| Apple Silicon + Homebrew Node           | `/opt/homebrew/bin/communicator`          |
| Intel / system Node / non-Homebrew      | `/usr/local/bin/communicator`             |

Verify it worked:

```bash
communicator --help
```

## Setup

```bash
# OpenRouter
export OPENROUTER_API_KEY="sk-or-v1-your-key-here"

# Venice.ai
export VENICE_API_KEY="vkey-your-key-here"
```

Add those lines to `~/.zshrc`, `~/.bashrc`, or your shell's equivalent to make them permanent.

## Commands

| Short | Flag                  | Args     | Description                                                                          |
|-------|-----------------------|----------|--------------------------------------------------------------------------------------|
| `-m`  | `--model`             | `<id>`   | Skip all pickers and use this model ID directly (non-interactive)                    |
| `-p`  | `--provider`          | `<name>` | Select the API backend: `openrouter` (default) or `venice`                           |
|       | `--reasoning-effort`  | `<level>`| Force reasoning effort: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`. `none` disables reasoning. With `--model` alone, saves the per-model default |
|       | `--temperature`       | `<0-2>`  | Temperature override for the session (default: per-model preference, then 0.7). With `--model` alone, saves the per-model default |
|       | `--budget`            | `<usd>`  | Per-session budget cap in USD. Warns at 80% used, refuses turns at 100%. Bare use saves the default |
|       | `--web-search`        | `[mode]` | Web search mode: `auto`, `always`, `on`, `off` (`on` = `auto`; bare flag = `auto`). Per-model default is persisted in preferences |
|       | `--web-results`       | `<n>`    | Number of web search results (OpenRouter only, default 10). Implies `auto` mode. Bare use saves the default |
|       | `--zdr`               | —        | Force zero-data-retention routing (OpenRouter only). Filters model/provider selection to ZDR-capable endpoints; errors at selection if a model has none |
|       | `--attach`            | `<path>` | Attach a file to the one-shot message (repeatable: images, pdf, xlsx/docx/pptx, txt, md, code, ...). Requires a prompt argument or piped stdin |
|       | `--no-smooth-streaming` | —      | Disable smooth streaming (default: on in interactive sessions). Bare use saves the default |
|       | `--smooth-speed`      | `<level\|cps>` | Smooth streaming speed: `slow`, `normal`, `fast`, or chars per second (default: `normal` ≈ 2000). Bare use saves the default |
| `-V`  | `--version`           | —        | Print the version and exit                                                           |
|       | `--list-models`       | —        | List all available models (name, ID, context length) and exit                        |
|       | `--list-endpoints`    | `[model]`| List providers for a model (pricing, uptime, ZDR support, privacy policy link). No arg = picker, partial ID = fuzzy match |
|       | `--list-sessions`     | —        | List saved sessions (timestamp, model, message count, title) and exit                |
| `-r`  | `--resume`            | `[id]`   | Resume a saved session. No arg = picker, partial ID = prefix match                   |
| `-x`  | `--export`            | `[id]`   | Export a session to markdown. Same ID matching as `--resume`                         |
|       | `--delete`            | `[id]`   | Delete a saved session (asks for confirmation). Same ID matching as `--resume`       |
|       | `--output-dir`        | `<path>` | Set export directory for markdown files (saved in preferences). Bare use saves it as the default (requires a TTY and no prompt) |
|       | `--config`            | `[path]` | Custom path for the preferences JSON file (default: `~/.communicator.json`). Bare flag prints the current config |
|       | `--system-prompt`     | `<path>` | Custom path for the system prompt file (default: `~/.communicator-system-prompt.md`) |

Pass `--reasoning-effort none` to disable reasoning entirely.

Full usage examples (one-shot mode, session management, reasoning, web search,
standalone config commands) live in [`docs/commands.md`](docs/commands.md) (see [Documentation](#documentation)).

## Usage

### Providers

Communicator supports two API backends:

- **OpenRouter** — Multi-provider gateway with endpoint-level routing. When you select a model, you'll pick which provider (e.g., OpenAI, Azure, Anthropic) actually serves the request. Supports cache-hit detection and per-endpoint pricing comparisons. Use `--provider openrouter` (this is the default).

- **Venice.ai** — Direct model access without multi-provider routing. Models are available directly; there's no endpoint picker step. Venice's `/models` endpoint is public, so you can list models without an API key. Use `--provider venice`.

The provider is saved in each session, so resuming a Venice session automatically uses the Venice backend — no need to pass `-p venice` again.

### Interactive flow

1. **Model selection** — searchable picker with fuzzy filtering by name or ID. Your last-used model appears first. Venice models show names as listed on the Venice dashboard (e.g., `Qwen 3.7 Max`); OpenRouter models include the org prefix (e.g., `Google: Gemini 3.6 Flash`).
2. **Reasoning effort** — shown only when the selected model supports reasoning effort control. A `Disabled` ("none") option is offered whenever the model allows turning reasoning off; models that reason automatically (no effort control) skip this step entirely. The chosen level is saved per model and restored as default next time. Venice uses the standard OpenAI `reasoning_effort` parameter; OpenRouter uses its native reasoning format.
3. **Provider selection** (OpenRouter only) — displays pricing, 30-minute uptime %, and routing tags. Navigate ← back to the model picker to change your selection. Models with a single provider skip this step entirely. Venice models go straight to chat.

Passing `-m <id>` skips **all** pickers: the reasoning effort is restored from your saved per-model preference (or the model default), and the OpenRouter endpoint is auto-selected (cheapest provider with pricing, otherwise the first one). Venice always goes straight to chat. `--reasoning-effort` still overrides the effort when given; `--reasoning-effort none` disables reasoning. Models that are disabled by default (`default_enabled: false`) restore as disabled.

### One-shot mode

Pass a prompt as a positional argument, or pipe input via stdin, to get a single answer without entering the chat loop:

```bash
communicator -m "openai/gpt-4o" "What is the capital of France?"
echo "Summarize the README" | communicator -m "openai/gpt-4o"
cat notes.md | communicator -m "openai/gpt-4o" --system-prompt ~/reviewer.md
```

- Without `-m`, the model pickers run first (they need a TTY), then the one-shot answer is sent.
- Piped stdin is read up to a 10MB sanity limit. Piping input without `-m` is an error — pickers can't run without a TTY.
- Output is TTY-aware: on a terminal you get the streaming response with reasoning labels and the usage/cost footer; when stdout is piped you get **only** the plain answer text (no banners, no usage) — ideal for scripting: `communicator -m ... "hi" | jq`.
- The answer is saved as a regular session (title, temperature, budget, usage) and the model/temperature preferences are persisted, exactly like an interactive chat.
- Exit codes: `0` success, `1` API/validation error (message on stderr), `130` interrupted with `Ctrl+C`.
- A prompt *argument* cannot be combined with `--resume`, `--export`, `--delete`, or `--list-*` flags (error + exit 1), and `--resume`/`--export`/`--delete` cannot be combined with `--list-*` flags either. Piped stdin has no such conflict: `--list-models`, `--list-sessions`, and `--list-endpoints <model>` work with piped stdin. The interactive pickers (`--resume`/`--export`/`--delete` in any form — even with a full session ID, and bare `--list-endpoints`) need a TTY.

### Chat session

Once connected, responses stream token by token. Reasoning tokens appear in gray with a `❯ Thinking` label. After the final answer, a usage summary is printed automatically:

```
❯ You
What is the capital of France?

❯ Thinking
The user is asking about the capital of France...

❯ Answer

The capital of France is Paris.

───────────────────────────────────────
  Tokens  ↑ 12 prompt  ↓ 28 completion  = 40 total
  Cost    $0.000034 this turn  |  $0.000124 session
───────────────────────────────────────
```

The last footer row holds the **CTX indicator**: the session's peak context usage — the most context a single turn has occupied (`prompt + completion` divided by the endpoint's advertised context length). It never decreases as the conversation grows, even when web search results transiently inflate a turn's prompt. The row appears only when the context window is known and at least 5% occupied (`CTX    ██████░░░░ 60%`; with a 1M-token model like DeepSeek V4 Flash, ordinary chats rarely show it); the bar turns yellow at 80% and red at 95%. When the budget warning fires (see below), the budget bar joins the same row instead of adding a line.

The `Cache ⚡` line appears only when OpenRouter serves a cached response; on a cache miss it is omitted entirely.

Cache hits are detected and shown when OpenRouter serves a cached response. The session cost accumulates across turns within the same chat. Venice pricing is normalized from per-1M-token rates to per-token for consistent cost display.

### Markdown rendering

By default, assistant responses are rendered as markdown in the terminal: `#` headers bold, `**bold**` / `*italic*` styled inline, `~~strikethrough~~` struck through, `` `code` `` in cyan, fenced code blocks dimmed, lists and blockquotes styled, aligned tables with a bold header row and dim separator, horizontal rules as a thin separator, and `[text](url)` links shown in italics (URL hidden, clickable in supporting terminals); bare URLs and `<url>` autolinks are clickable too. Reasoning text is never restyled.

Streaming is live: the current in-flight line is written as tokens arrive and redrawn in place as it grows, so even single-paragraph answers stream continuously; when a line completes, it is restyled with its final markup. Tables are held until they close and then rendered fully aligned, so columns never shift mid-row. Toggle with `/markdown` (default on); history replay on `--resume` uses the same styling.

### Smooth streaming & waiting indicator

In interactive (TTY) sessions, streaming is paced by default: tokens are buffered and rendered at a steady character rate (~40 chars per 20 ms tick) instead of being written the instant each SSE event arrives. This smooths out bursts — most notably the first content chunk after a web-search delay — while slow streams still render as fast as they arrive (pacing is a cap, not an artificial delay). When the stream ends, any remaining buffered text keeps rendering at the same paced rate rather than popping in all at once. Piped output is never paced. Disable it with `--no-smooth-streaming` at launch or `/smooth off` mid-chat (`/smooth` shows the current state, `/smooth on` re-enables; the choice is persisted in preferences).

The pace is a global speed setting, persisted in preferences under `smoothSpeed` (shared by every session, like `smoothStreaming`). Set it at launch with `--smooth-speed <level|cps>` (`slow` ≈ 500 chars/s, `normal` ≈ 2000 chars/s, `fast` ≈ 8000 chars/s, or any positive chars-per-second value) or mid-chat with `/smooth slow|normal|fast|<cps>`, which also enables smooth streaming. Speed changes apply live: the very next tick of an in-flight stream uses the new pace. The speed is inert when smooth streaming is off or output is piped.

While the model is working, a dim indicator appears on the response line roughly 200 ms after you send the message — `Waiting for response` with a braille spinner (or `Searching the web` when web search is forced with `always`, since that mode is guaranteed to search). The indicator is erased the moment the first token arrives, and it never shows for instant replies.

### Budget caps

`--budget <usd>` (or `/budget <usd>` mid-chat) sets a per-session spending cap based on accumulated tracked cost. When 80% is crossed, the last footer row shows the budget bar (`Budget  83% used ($0.0005 of $0.0006), $0.0001 remaining`), joined with the CTX bar on the same row when both are visible. At 100% the next turn is refused with `Budget exhausted ($X of $Y). /new to start fresh or /quit.`. `/budget` with no value prints used/remaining. Budgets are stored in the session file and restored on `--resume`; `/new` clears the budget for the fresh session.

### Zero data retention (ZDR)

OpenRouter lets you force **zero data retention** per request: no caching, no logging, no training on your prompts or responses. Pass `--zdr` (OpenRouter only — silently ignored on Venice) and every request in the session carries `provider.zdr: true`. Selection is **filtered to ZDR-capable entries**: the model picker shows only models that have a zero-retention endpoint, the provider picker shows only `[zero retention]` endpoints, and a non-interactive `-m <model>` fails at selection — before any request — if the model has no ZDR endpoints. The runtime error is kept as a safety net for paths that bypass selection (`--resume`, mid-chat model switches, index drift). Without `--zdr` nothing changes — normal (non-ZDR) routing applies.

Privacy metadata comes from OpenRouter's own public endpoints and is fetched live (cached briefly, non-fatal on failure):

- **`[zero retention]` tag** — the provider picker marks endpoints listed in OpenRouter's ZDR index; `--list-endpoints` shows a `zdr yes/no` column; `--list-models` marks models that have at least one ZDR-capable endpoint as `[zdr]`
- **Privacy policy links** — each provider row in `--list-endpoints` prints its `privacy policy` URL, and the picker's description line shows a clickable `privacy policy` OSC 8 hyperlink (plain text in terminals without hyperlink support)

Caveats: `--zdr` is a per-invocation flag, not persisted. ZDR-capable providers may not support web search — combining `--zdr` with `--web-search` is allowed, but the request can be rejected by the API depending on the provider. If OpenRouter's ZDR index can't be fetched, `--zdr` prints a warning and skips filtering, relying on the runtime error instead. `--resume` keeps the session's model/effort/temperature but ZDR must be re-passed with `--zdr` on the resuming invocation.

### Web search

Web search has three modes, persisted per model in `~/.communicator.json` under `webSearch` (default `off`): `auto` lets the model decide when to search (recommended — searches only when useful), `always` forces a search on every request, and `off` disables it. Set the mode with `--web-search <mode>` at launch or `/web-search <mode>` mid-chat (legacy `on` maps to `auto` in both the CLI and slash commands; bare `--web-search` means `auto`; bare `/web-search` shows the current mode). The chat banner shows the mode with a `[web: <mode>]` badge (`[web: auto]` / `[web: always]`), plus a result count when set.

- **OpenRouter** — `auto` mode uses the `openrouter:web_search` server tool (beta): the model decides whether to search, with 0–N searches per request and results surfacing as `url_citation` citations; the result count caps the *total* number of sources per answer (OpenRouter limits each search call individually, so a total cap is set explicitly). `always` mode uses the legacy `web` plugin, which works on *any* model (native engines for major providers, Exa fallback) and forces one search per request; the plugin is deprecated by OpenRouter but still functional — if it is removed, `always` requests will fail until this client is updated (no automatic fallback is implemented). The result count defaults to 10 — the pricing sweet spot: the base $0.005/request covers up to 10 results, and each result beyond 10 costs $0.001 extra. Override it per session with `--web-results <n>` or `/web-results <n>` (the banner then shows `[web: auto: N]` / `[web: always: N]`). `--web-results` implies `auto` mode for that invocation unless an explicit `--web-search <mode>` is given (e.g. `--web-search always --web-results 5` stays `always`); `/web-results` only sets the count, it does not change the mode. Validation accepts any positive integer — larger counts work but cost more (see pricing above).
- **Venice** — maps to `venice_parameters.enable_web_search`: `auto` → `"auto"`, `always` → `"on"`, `off` → `"off"`; there is no result-count knob, so `--web-results`/`/web-results` have no effect there. Venice gates on the model's `supportsWebSearch` capability: enabling `auto`/`always` for a model that doesn't support web search refuses with a message (interactive) or exits with an error (CLI flags). Venice web search is billed per usage.
- **Sources** — when web search is enabled, a numbered `Sources` section is printed after each answer (italic clickable OSC 8 hyperlinks in supporting terminals, plain text otherwise). Inline citations are also clickable and italic: OpenRouter models emit markdown links `[domain](url)`, Venice models emit `^n^` markers that map to the sources list. Sources are saved with each assistant message, so `--resume` replays the list and inline citations as clickable links, and `--export` includes them as a markdown `Sources` list with `^n^` markers converted to `[n](url)` links.
- Web search state is stored in the session file (`webSearch` mode / `webResults`) and restored on `--resume`. Existing `webSearch: true` prefs and sessions are read as `auto` (the smart mode), so previously-forced searches become model-decided unless you pick `always`.

### File & image attachments

Attach local files to a message so the model can see or read them. Queued files are sent with the next message, and the original message text goes along unchanged. Attachments persist in the session file (as OpenAI-style content parts), so `--resume` replays them and re-sending works.

Supported formats:

| Kind     | Extensions                                              | How it is sent                                        |
|----------|---------------------------------------------------------|-------------------------------------------------------|
| Image    | `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`              | base64 `image_url` part — requires a vision model      |
| PDF      | `pdf`                                                   | base64 `file` part (server-side parsing on any model)  |
| Office   | `xlsx`, `xls`, `docx`, `pptx`                           | base64 `file` part — **Venice only** (server-side extraction) |
| Text     | `txt`, `md`, `markdown`, `csv`, `json`, `yaml`, `yml`, `toml`, `xml`, `log`, `py`, `js`, `mjs`, `cjs`, `ts`, `tsx`, `jsx`, `css`, `html`, `sh`, `sql`, `go`, `rs`, `java`, `c`, `cpp`, `h`, `hpp`, `ini` | inlined as a `text` part (no base64 bloat) |

Anything else is rejected with `Unsupported file type: <ext>`.

- **Interactive** — `/attach <path>...` queues one or more files (relative paths resolve from the current directory); each file prints `attached: <name> (<kind>, <size>)` or an error line, and one failing file does not abort the rest. Paths with spaces can be backslash-escaped (`/attach Screenshot\ 2026-07-23.png`). `/attach` with no arguments lists the queue, `/attachments` lists it too, and `/attachments clear` empties it. Queued files are sent with the very next message you type and the queue resets. `/new` also clears the queue. Words without a file extension or path separator are treated as prose and ignored with a hint. Type your message on the next line, not after the paths — a multi-line submission uses the first line as the command and sends the remaining lines as your message.
- **One-shot** — `--attach <path>` is repeatable and requires a prompt argument or piped stdin (`communicator --attach report.pdf "Summarize"`). It cannot be combined with `--resume`, `--export`, `--delete`, `--list-*`, or bare `--config`.
- **Vision gating** — image attachments are blocked at attach time when the selected model is known to lack vision (`The selected model does not support image input.`). Unknown capability allows the attachment — API errors surface naturally. On models known to lack vision, `/attach` and `/attachments` are hidden from the interactive hint, autocomplete, and the unknown-command list, though typing them manually still works (text/PDF attach stays available) and `/model` to a vision model re-shows them. PDFs and text files work on any model. Office files are rejected on OpenRouter with a clear message (`xlsx/docx/pptx are only supported on Venice...`) and accepted on Venice, which extracts them server-side.
- **Switching models** — `/model` re-checks the queue against the new model and drops entries it can't accept, with a warning line per dropped file.
- **Limits** — images over 20 MB and pdf/office files over 25 MB (the Venice cap) are rejected based on the base64-encoded size; text files over 25 MB are rejected too. Inline text over 256 KB is still accepted but warns about context usage.
- **Display & export** — resumed sessions render `attached: <filename>` lines under the message; images show as `image.<ext>` because only the image URL is persisted (pdf/office/text keep their real filenames); markdown export adds `> **Attachment:** \`<filename>\`` lines; `/copy` copies only the message text, never file contents or base64.

### Slash commands

| Input          | Action                                                                              |
|----------------|-------------------------------------------------------------------------------------|
| `/quit`        | Save the session and exit the chat                                                  |
| `/new`         | Save the current session and start a fresh one (same model and reasoning effort)    |
| `/model`       | Save, then switch models mid-chat — re-picks reasoning effort and endpoint          |
| `/reasoning`   | Re-run the reasoning effort picker for the current model                            |
| `/temp`        | Set the session temperature (`/temp 0.4`), or show the current value with no args    |
| `/budget`      | Show used/remaining budget, or set one with `/budget <usd>`                          |
| `/web-search`  | Set the web search mode (`/web-search auto|always|off`; `on` = `auto`), show the current mode with no args |
| `/web-results` | Set the web search result count (`/web-results <n>`, OpenRouter only), show it with no args |
| `/attach`      | Queue files for the next message (`/attach <path>...`). No args = same as `/attachments` |
| `/attachments` | List the queued attachments, or clear them with `/attachments clear` |
| `/retry`       | Re-run the last user turn (regenerates the last answer)                             |
| `/copy`        | Copy the last assistant response to the clipboard                                   |
| `/markdown`    | Toggle terminal markdown rendering (default on)                                     |
| `/smooth`      | Show smooth streaming state and speed, or set them with `/smooth on|off|<level>|<cps>` (a speed value implies on) |
| `/cost`        | Print the running session cost/token totals and current reasoning effort            |
| `Cmd+C` / `Ctrl+C` | During streaming: abort, save the partial response, and exit. At the prompt: cancel and exit |

Unknown slash commands (anything starting with `/`) print a hint listing the available commands instead of being sent to the model.

While typing at the prompt, a live list of matching commands appears below the input as soon as the line starts with `/` (single line, cursor at line end, not yet an exact match). **Tab** fills the first match, **Shift+Tab** fills the last one, and **Enter always submits**. The list hides once the line is an exact match — keep typing to refine, or backspace the `/` to dismiss it. Parameterized commands like `/temp 0.7` are typed manually after completion.

## System Prompt

The system prompt sets the AI's persona and behavior. Customize it by creating a file at `~/.communicator-system-prompt.md` with your system prompt content.

```bash
echo "You are a sarcastic engineer. Always respond with a clever remark." > ~/.communicator-system-prompt.md
```

Override the default path with `--system-prompt`:

```bash
communicator --system-prompt /path/to/custom-prompt.md
```

- If the file is missing or empty, the default `"You are a helpful assistant."` prompt is used silently.
- The file is read once at startup. Changes require restarting the chat.
- Venice always sets `include_venice_system_prompt: false` since the app provides its own system prompt.

## Session Persistence & Resume

Every chat session is automatically saved to `~/.communicator/sessions/<timestamp>.json`, with a `title` auto-generated from the first user message (whitespace collapsed, truncated to 50 chars). Sessions are saved when you quit (`/quit` or `Ctrl+C`), when you switch models or start a new session, and on interrupt during streaming (including the partial response). A metadata index at `~/.communicator/sessions/.index.json` powers `--list-sessions` and the resume/export/delete pickers so listing never has to parse full session files. If the index is missing or stale (e.g. sessions from an older version), it is rebuilt automatically from the session files. Binary attachments (images, PDFs, office files) are stored as blob files under `~/.communicator/sessions/attachments/<sessionId>/` and referenced from the session JSON via `ref://attachments/` sentinels, keeping session files small; they are rehydrated back into API data URLs on resume/export. Text-file attachments stay inline in the JSON.

```bash
communicator --list-sessions   # list saved sessions
communicator --resume          # resume (picker, prefix match, or full ID)
communicator --export          # export a session to markdown
communicator --delete          # delete a session (with confirmation)
```

Detailed examples for listing, resuming, deleting, and exporting sessions,
plus the on-disk session file format, live in
[`docs/sessions.md`](docs/sessions.md) (see [Documentation](#documentation)).

## Preferences

Stored in `~/.communicator.json` (customizable with `--config`):

```json
{
  "lastModel": "openai/gpt-4o",
  "lastProvider": "OpenAI",
  "reasoningEffort": {
    "openai/o1-pro": "high"
  },
  "temperature": {
    "openai/gpt-4o": 0.2
  },
  "webSearch": {
    "openai/gpt-4o": "auto"
  },
  "smoothStreaming": true,
  "smoothSpeed": "normal",
  "budget": 2,
  "webResults": 10,
  "outputDir": "/home/user/Documents/CommunicatorExports"
}
```

The last model and provider become defaults in the interactive pickers. Reasoning effort, temperature, and web search mode are saved per model ID and restored automatically. `smoothStreaming` and `smoothSpeed` are global defaults, and `budget`/`webResults` are the session defaults applied when no flag is given. Legacy `webSearch: true` values are read as `auto`. Preferences are currently scoped across both API backends — your last OpenRouter model will show as the favorite even when using Venice (this will be improved in a future release).

## How it works

```
cli (index.js)            — commander argument parsing, delegates to runCli
├── cli-main.js           — runCli: error handling (ApiError/CliError/ExitPromptError), dispatch to commands and config setters
├── cli-utils.js          — resolveFlagOrExit (throws CliError on invalid flag values), collectFlag (repeatable --attach)
├── cli-validation.js     — pure flag-combination validation (validateCliFlags) + flag-group predicates
├── commands/
│   ├── list-models.js    — --list-models handler
│   ├── list-endpoints.js — --list-endpoints handler
│   ├── list-sessions.js  — --list-sessions handler
│   ├── export-cmd.js     — --export handler
│   ├── delete-cmd.js     — --delete handler (confirm + remove session)
│   ├── config-set.js     — standalone config setters (--model, --temperature, ... persist defaults)
│   ├── config-view.js    — bare --config: print the current preferences
│   ├── one-shot.js       — one-shot mode: prompt argument / stdin piping
│   ├── resume.js         — --resume handler (load session, return params)
│   ├── chat-start.js     — session context setup, chat start, end-of-chat persist
│   └── chat/
│       └── index.js      — slash command registry (15 chatCommands) + budgetGuard
├── providers/
│   ├── index.js          — factory: getProvider(name) → provider module; common chatCompletion contract
│   ├── openrouter.js     — OpenRouter API client: models, endpoints, chat completions
│   └── venice.js         — Venice.ai API client: models, synthetic endpoints, chat
├── model-selection.js    — interactive and non-interactive (-m) selection flows
├── session-setup.js      — shared one-shot/chat-start helpers: resolveSessionFlags, attachGateOptions, persistSession
├── http.js               — fetchWithTimeout (30s) + fetchWithRetry (backoff, retries timeouts)
├── errors.js             — ApiError (status/provider/retryable), TimeoutError, CliError (exitCode), formatError
├── sse-parser.js         — shared SSE stream parser (idle-timeout stall detection; consumed by both providers)
├── attachments.js        — attachment model: classify/load files (size limits), capability gate, content parts ↔ text helpers (contentText/messageText)
├── config.js             — API key lookup (provider meta), preferences load/save (~/.communicator.json)
├── constants.js          — shared constants (paths, labels, temperature bounds, SSE markers) and formatCost
├── prompts.js            — interactive TUI pickers using @inquirer/prompts (model, provider, reasoning effort)
├── flags.js              — CLI flag resolvers (temperature, web search/results, reasoning, budget)
├── reasoning.js          — reasoning effort default resolution + web search capability check
├── chat-state.js         — ChatState: session state + pure transitions + final-state snapshot
├── turn-runner.js        — per-turn orchestration (stream render, abort, interrupt salvage, usage tracking)
├── signals.js            — process signal registration (SIGINT/beforeExit/uncaughtException) + cleanup
├── sessions.js           — session persistence: save, load, list, title generation, delete, sidecar index, resolve
├── session-picker.js     — interactive session selector for --resume, --export, and --delete
├── export.js             — markdown exporter: format session data, write to file
├── tracker.js            — per-turn + cumulative token/cost accounting with cache detection, budget status helpers
├── clipboard.js          — clipboard copy via pbcopy/clip/wl-copy/xclip/xsel
├── input.js              — chat input via vendored read-multiline (with command suggestions)
├── suggest.js            — pure suggestion helpers (matchCommands, shouldSuggest, nextMatchIndex)
├── vendor/
│   └── read-multiline/   — vendored @toiroakr/read-multiline@0.4.1 + suggest patch (see its README)
├── ui/
│   ├── style.js          — ANSI helpers (dim, bold, sep, thinking, answer)
│   ├── format.js         — price formatting (formatModelPrice, formatPricePerM)
│   ├── io.js             — output helpers (out/err) and debug logging (COMMUNICATOR_DEBUG=1)
│   ├── markdown.js       — streaming terminal markdown renderer (in-place line redraw)
│   ├── md-it.js          — markdown-it engine: ANSI token rendering, line classification, aligned tables
│   ├── hyperlink.js      — OSC 8 hyperlink escape helper
│   ├── loader.js         — waiting indicator (braille spinner) for pending responses
│   └── stream.js         — stream renderer + history replay
└── chat.js               — runChatSession: DI chat loop (readInput/renderer/stdout/exit/save/signals), banner, SIGINT
```

Dependencies: [`commander`](https://www.npmjs.com/package/commander) for CLI argument parsing, [`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts) for the interactive search/select UI, [`markdown-it`](https://www.npmjs.com/package/markdown-it) for terminal markdown rendering, and [`string-width`](https://www.npmjs.com/package/string-width) for emoji-aware column measurement (stream rewind math). Multi-line input uses a vendored copy of [`@toiroakr/read-multiline`](https://www.npmjs.com/package/@toiroakr/read-multiline) 0.4.1 (see `src/vendor/read-multiline/README.md`).

### Architecture

The chat flow is built around four pieces:

- **`ChatState` (`src/chat-state.js`)** — the mutable session state (model, reasoning effort, temperature, budget, web search, messages, …) with pure transitions (`setTemperature`, `applyModelSelection`, `toggleMarkdown`, …). `toFinalState()` produces the exact snapshot written to the session file; `resetForNewSession()` backs `/new`.
- **Command registry (`src/commands/chat/index.js`)** — the 15 slash commands live in a data-driven map of `/name → async (ctx) => outcome`; `CHAT_COMMANDS` is derived from the registry keys so the suggestion list and the loop can never drift. Handlers never call `process.exit` — they return `{ exit }` / `{ reset }` signals that the loop translates into exit codes, which keeps every handler unit-testable (`test/chat-commands.test.js`).
- **`runChatSession(ctx, deps)` (`src/chat.js`)** — the chat loop is dependency-injected: `deps = { readInput, renderer, stdout, exit, saveSession, savePrefs, onSignal, newSessionId }`, each defaulting to the real implementation, so production behavior is unchanged while the whole loop is drivable with fakes (`test/chat-loop.test.js`). Signal handling (idle/streaming SIGINT, `beforeExit`, `uncaughtException`) is registered through `onSignal` (`src/signals.js`); per-turn orchestration — stream rendering, abort, interrupt salvage, usage tracking — lives in `src/turn-runner.js` on a shared `sessionState` object.
- **`src/flags.js`** — CLI flag parsing helpers (`resolveTemperatureFlag`, `resolveWebResultsFlag`, `resolveWebSearchFlag`, `resolveReasoningFlag`, `resolveBudget`) shared by the chat loop, one-shot mode, and chat-start.

`src/reasoning.js` holds the two model-capability helpers: `resolveEffortDefault` (forced flag → auto-reasoning → saved pref → model default, `'none'` normalized to `null`) and `isWebSearchSupported` (provider-wide or per-model capability).

### Provider contract

Adding a new provider requires implementing the following exports:

```js
export const meta = { name, baseURL, apiKeyEnv, hasEndpoints }
export async function fetchModels(apiKey) → [{id, name, provider, contextLength, description, reasoning, pricing, capabilities}]
export async function fetchEndpoints(apiKey, modelId, allModels?) → [{name, providerName, tag, status, uptime30m, pricing, ...}]
export async function chatCompletion({apiKey, model, messages, onToken, provider, reasoningEffort, supportsReasoning, sessionId, temperature, webSearch, webResults, signal}) → {content, reasoning, usage}
export function normalizePricing(rawPricing) → {prompt, completion}
export function handleHttpError(status, body) → throws ApiError
```

- `pricing` is `{ prompt, completion }` USD per token (or `null`) — use `normalizePricing` and the helpers in `src/ui/format.js` for display
- `chatCompletion` receives `signal` (AbortController) for SIGINT cancellation, `sessionId` for server-side prompt caching (OpenRouter currently ignores it; Venice maps it to `prompt_cache_key`), and `temperature` (default `0.7`, must be set in the request body). `webSearch` is a mode string (`'off' | 'auto' | 'always'`); `webResults` is the OpenRouter result count — providers may ignore options they do not support (see the contract doc in `src/providers/index.js`). It also receives `onSources(sources)` and returns `sources: [{ title, url }]` (empty when web search is off or the provider returned no citations)
- HTTP calls should go through `fetchWithRetry` from `src/http.js`; errors must be thrown as `ApiError`, never `process.exit`

See `src/providers/openrouter.js` and `src/providers/venice.js` for reference implementations.

## Platform compatibility

Communicator is written in pure Node.js ESM with no native dependencies, so the same codebase runs on macOS, Linux, and Windows. It is developed and tested on macOS; Linux and Windows are verified by the CI matrix (GitHub Actions runs `npm test` and `npm run lint` on all three OSes).

| Platform | Status | Notes |
|----------|--------|-------|
| macOS    | Primary — developed and tested locally and in CI | Clipboard via built-in `pbcopy` |
| Linux    | Expected to work, CI-verified | Clipboard tools probed at runtime: `wl-copy` (Wayland) → `xclip` → `xsel` (X11) |
| Windows  | Expected to work, CI-verified | Clipboard via built-in `clip`; multi-line input normalizes CRLF |

### Requirements

- **Node.js >= 22.3** on all platforms
- No native dependencies — pure ESM

### Clipboard tools

| OS      | Tools probed (in order)          | Notes |
|---------|----------------------------------|-------|
| macOS   | `pbcopy`                         | Built-in |
| Windows | `clip`                           | Built-in |
| Linux   | `wl-copy` → `xclip` → `xsel`     | First one found wins; install any single one (`wl-clipboard` on Wayland, `xclip`/`xsel` on X11) |

When none is available, `/copy` reports `Copy failed: No clipboard tool found. Install wl-copy, xclip, or xsel.`

### Terminals

The full experience requires a modern terminal emulator:

- **ANSI colors and styling** — all modern terminals
- **OSC 8 clickable links** (web sources, inline citations) — iTerm2, Terminal.app, Warp, WezTerm, kitty, GNOME Terminal, Windows Terminal, and most others
- **Braille spinner, markdown tables, smooth streaming** — degrade gracefully elsewhere

Terminals without ANSI support get plain-text fallbacks: OSC 8 escapes are stripped automatically and streaming text is written as-is. On Windows, use **Windows Terminal** (or another modern emulator) — legacy `conhost`/`cmd` renders plain text without styling, colors, or clickable links.

### Data locations

All persistent data is resolved from `os.homedir()` at runtime, so the paths are identical across OSes:

| Path | Contents |
|------|----------|
| `~/.communicator/sessions/` | Session files + `.index.json` metadata |
| `~/.communicator/sessions/attachments/<sessionId>/` | Binary attachment blobs (images, PDFs, office files), referenced via `ref://attachments/` in session JSON |
| `~/.communicator.json` | Preferences |
| `~/.communicator-system-prompt.md` | Optional custom system prompt |

### Install & environment on Linux/Windows

`npm link` places the `communicator` binary on your PATH. The exact location depends on your Node.js setup:

| OS / setup                                   | Symlink path                               |
|----------------------------------------------|--------------------------------------------|
| macOS Apple Silicon + Homebrew Node          | `/opt/homebrew/bin/communicator`           |
| macOS Intel / system Node                    | `/usr/local/bin/communicator`              |
| Linux + nvm                                  | `~/.nvm/versions/node/<version>/bin/communicator` |
| Windows                                      | `%APPDATA%\npm\communicator` (add `%APPDATA%\npm` to `PATH` if needed) |

Set the API keys per platform:

```bash
# macOS / Linux — add to ~/.zshrc or ~/.bashrc
export OPENROUTER_API_KEY="sk-or-v1-your-key-here"
export VENICE_API_KEY="vkey-your-key-here"
```

```powershell
# Windows PowerShell — current session, or persist with setx
$env:OPENROUTER_API_KEY = "sk-or-v1-your-key-here"
$env:VENICE_API_KEY = "vkey-your-key-here"
setx OPENROUTER_API_KEY "sk-or-v1-your-key-here"
setx VENICE_API_KEY "vkey-your-key-here"
```

The `~/.zshrc` / `~/.bashrc` examples in the Setup section are Unix-specific; on Windows use PowerShell `$PROFILE` instead.

## Uninstall

```bash
npm unlink -g communicator
rm ~/.communicator.json
rm -rf ~/.communicator
```

If you used a custom config path with `--config`, delete that file instead.

## License

[MIT](LICENSE.md)
