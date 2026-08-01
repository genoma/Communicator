# Communicator

Chat from your terminal with streaming responses, interactive model/provider selection, and live cost tracking. Supports OpenRouter and Venice.ai backends.

> ⚠️ **Heads up:** This is a hobby project I built for myself, shared in case it helps someone else. It works, maybe, but:
> - Rough around the edges (minimal error handling)
> - Text only, no vision
> - No promises beyond "it mostly doesn't break"
> - Minimal testing (cross your fingers and use cheap models)
>
> Fork it, break it, fix it, disregard it, I won't take it personally.

## Features

- **Multi-provider** — OpenRouter and Venice.ai backends, switchable via `--provider`. Adding new providers is straightforward via the provider abstraction layer
- **Interactive model picker** — searchable and filterable by name or model ID, with context-length display
- **Provider selection** — compare pricing, uptime %, and routing tags before starting a chat. Single-provider models skip this step automatically. Navigate back to the model picker at any time. Venice models are directly available (no multi-provider routing)
- **Reasoning effort control** — per-model effort level persisted across sessions. Only shown for models that support reasoning. OpenRouter uses its native reasoning format; Venice uses standard OpenAI `reasoning_effort`
- **Temperature control** — `--temperature <0-2>` flag, `/temp` command, per-model default persisted in preferences
- **Web search** — per-model web search toggle for both providers (`--web-search`, `/web-search`). OpenRouter lets you set the result count (`--web-results <n>`, `/web-results <n>`); Venice is on/off only
- **One-shot mode** — pass a prompt argument or pipe input via stdin for a single non-interactive answer. TTY-aware output: styled with usage footer on a terminal, plain answer text only when piped
- **Per-session budget caps** — `--budget <usd>` or `/budget <usd>` limits accumulated session cost; warns at 80% used and refuses turns at 100%
- **Terminal markdown rendering** — responses are styled in the terminal (headers, bold/italic, code blocks, lists, quotes, links) with a `/markdown` toggle
- **Streaming responses** — tokens appear as they arrive, with reasoning tokens shown in gray under a `[Thinking]` banner and a `[Answer]` separator before the final response
- **Usage & cost tracking** — after each turn: prompt / completion / total token counts, cache hit detection (OpenRouter), and a dollar-cost breakdown (per turn + cumulative session total). Check anytime with `/cost`
- **Slash commands** — `/new` starts a fresh session, `/model` switches models mid-chat, `/reasoning` re-picks the reasoning effort, `/temp` sets temperature, `/budget` sets/shows the budget, `/web-search` toggles web search, `/web-results` sets the result count, `/retry` re-runs the last turn, `/copy` copies the last response, `/markdown` toggles rendering, `/cost` shows the running total, `/quit` exits
- **Session auto-save** — every chat is saved as a JSON file in `~/.communicator/sessions/`, with an auto-generated title from the first user message. Sessions are saved when you quit, switch models, start a new session, or interrupt with `Ctrl+C`, so the last exchange is never lost
- **Session resume** — restore any past conversation with `--resume`, keeping the same model, provider, reasoning effort, temperature, and budget. Automatically detects and uses the correct API backend. Supports prefix matching and an interactive picker
- **Session deletion** — remove saved sessions with `--delete` (with confirmation)
- **Markdown export** — export any saved session as a clean markdown file with `--export`, with collapsible reasoning blocks and cost summary
- **Session persistence** — last model, provider, and per-model reasoning effort and temperature are saved to `~/.communicator.json` and restored on next launch
- **CLI flags to skip pickers** — pass `-m`, `--reasoning-effort`, or `--reasoning-effort none` to bypass interactive prompts. `-m` skips *all* pickers (model, reasoning, endpoint) for fully non-interactive use
- **Lightweight** — three runtime dependencies, pure Node.js ESM

## Requirements

- **Node.js** >= 22

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
|       | `--reasoning-effort`  | `<level>`| Force reasoning effort: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`. `none` disables reasoning |
|       | `--temperature`       | `<0-2>`  | Temperature override for the session (default: per-model preference, then 0.7)       |
|       | `--budget`            | `<usd>`  | Per-session budget cap in USD. Warns at 80% used, refuses turns at 100%              |
|       | `--web-search`        | —        | Enable web search for the session. Per-model default is persisted in preferences    |
|       | `--web-results`       | `<n>`    | Number of web search results (OpenRouter only, default 10). Implies `--web-search`  |
| `-V`  | `--version`           | —        | Print the version and exit                                                           |
|       | `--list-models`       | —        | List all available models (name, ID, context length) and exit                        |
|       | `--list-endpoints`    | `<model>`| List providers for a model (pricing, uptime) and exit                                |
|       | `--list-sessions`     | —        | List saved sessions (timestamp, model, message count, title) and exit                |
| `-r`  | `--resume`            | `[id]`   | Resume a saved session. No arg = picker, partial ID = prefix match                   |
| `-x`  | `--export`            | `[id]`   | Export a session to markdown. Same ID matching as `--resume`                         |
|       | `--delete`            | `[id]`   | Delete a saved session (asks for confirmation). Same ID matching as `--resume`       |
|       | `--output-dir`        | `<path>` | Set export directory for markdown files (saved in preferences)                       |
|       | `--config`            | `<path>` | Custom path for the preferences JSON file (default: `~/.communicator.json`)          |
|       | `--system-prompt`     | `<path>` | Custom path for the system prompt file (default: `~/.communicator-system-prompt.md`) |

Pass `--reasoning-effort none` to disable reasoning entirely.

Quick start:

```bash
# OpenRouter (default)
communicator                                            # full interactive flow
communicator -m "openai/gpt-4o"                         # skip all pickers (non-interactive)
communicator --list-models                                       # list OpenRouter models
communicator --list-endpoints "anthropic/claude-sonnet-4-20250514"  # list endpoints for a model

# Venice.ai
communicator -p venice                                  # Venice interactive flow
communicator -p venice -m "qwen-3-7-max"                # skip all pickers (non-interactive)
communicator -p venice --list-models                             # list Venice models (no API key needed)
communicator -p venice --list-endpoints "qwen-3-7-max"           # show Venice endpoint info

# One-shot mode (non-interactive, no chat loop)
communicator -m "openai/gpt-4o" "What is the capital of France?"     # positional prompt
echo "Summarize this: ..." | communicator -m "openai/gpt-4o"          # piped stdin
communicator -m "openai/gpt-4o" --temperature 0.2 "Write a haiku"     # with temperature
cat notes.md | communicator -m "openai/gpt-4o" --budget 0.5 "Fix typos:" # with budget cap

# Session management
communicator --list-sessions                                   # list saved sessions
communicator --resume                                   # resume a saved session
communicator --export                                   # export a session to cwd
communicator --export --output-dir ~/Documents          # export to custom directory
communicator --delete                                   # delete a session (with confirmation)
communicator --delete 2026-07-30T19-11-45               # delete a specific session

# Reasoning
communicator -m "deepseek/deepseek-v4-flash" --reasoning-effort high  # force high reasoning effort
communicator --reasoning-effort none                                             # disable reasoning
communicator -p venice -m "deepseek-v4-flash" --reasoning-effort high    # Venice with reasoning

# Web search
communicator --web-search                                              # enable web search (per-model pref saved)
communicator -m "openai/gpt-4o" --web-results 5 "Latest AI news"       # 5 results, implies web search
communicator -p venice --web-search                                    # Venice: on/off only (no result count)
```

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
- A prompt argument or piped stdin cannot be combined with `--resume`, `--export`, `--delete`, or `--list-*` flags (error + exit 1).

### Chat session

Once connected, responses stream token by token. Reasoning tokens appear in gray with a `[Thinking]` label. After the final answer, a usage summary is printed automatically:

```
❯ You
What is the capital of France?

[Thinking]
The user is asking about the capital of France...

[Answer]

The capital of France is Paris.

───────────────────────────────────────
  Tokens  ↑ 12 prompt  ↓ 28 completion  = 40 total
  Cache   0 cached tokens
  Cost    $0.000034 this turn  |  $0.000124 session
───────────────────────────────────────
```

Cache hits are detected and shown when OpenRouter serves a cached response. The session cost accumulates across turns within the same chat. Venice pricing is normalized from per-1M-token rates to per-token for consistent cost display.

### Markdown rendering

By default, assistant responses are rendered as markdown in the terminal: `#` headers bold, `**bold**` / `*italic*` styled inline, `` `code` `` in cyan, fenced code blocks dimmed, lists and blockquotes styled, horizontal rules as a thin separator, and `[text](url)` links shown in cyan (URL hidden). Reasoning text is never restyled.

Streaming is line-buffered: completed lines are styled as they arrive, and the current in-flight line is styled once it completes (at the next newline or the end of the response) — so the last line of a response can render a moment later than it streams. Toggle with `/markdown` (default on); history replay on `--resume` uses the same styling.

### Budget caps

`--budget <usd>` (or `/budget <usd>` mid-chat) sets a per-session spending cap based on accumulated tracked cost. When 80% is crossed, the usage footer shows a budget line (`Budget  83% used ($0.0005 of $0.0006), $0.0001 remaining`). At 100% the next turn is refused with `Budget exhausted ($X of $Y). /new to start fresh or /quit.`. `/budget` with no value prints used/remaining. Budgets are stored in the session file and restored on `--resume`; `/new` clears the budget for the fresh session.

### Web search

Web search is a per-model toggle, persisted in `~/.communicator.json` under `webSearch` (default off). Enable it with `--web-search` at launch or `/web-search on` mid-chat (`/web-search off` disables it; bare `/web-search` shows the current state). The chat banner shows `[web]` when enabled.

- **OpenRouter** — the `web` plugin works on *any* model (native engines for major providers, Exa fallback). The result count defaults to 10 — the pricing sweet spot: the base $0.005/request covers up to 10 results, and each result beyond 10 costs $0.001 extra. Override it per session with `--web-results <n>` or `/web-results <n>` (the banner then shows `[web: N]`). `--web-results` implies web search is on for that invocation; `/web-results` only sets the count, it does not toggle the flag. Validation accepts any positive integer — larger counts work but cost more (see pricing above).
- **Venice** — web search is on/off only (`venice_parameters.enable_web_search`); there is no result-count knob, so `--web-results`/`/web-results` have no effect there. Venice gates on the model's `supportsWebSearch` capability: enabling it for a model that doesn't support web search refuses with a message (interactive) or exits with an error (CLI flags). Venice web search is billed per usage.
- Web search state is stored in the session file (`webSearch`/`webResults`) and restored on `--resume`.

### Slash commands

| Input          | Action                                                                              |
|----------------|-------------------------------------------------------------------------------------|
| `/quit`        | Save the session and exit the chat                                                  |
| `/new`         | Save the current session and start a fresh one (same model and reasoning effort)    |
| `/model`       | Save, then switch models mid-chat — re-picks reasoning effort and endpoint          |
| `/reasoning`   | Re-run the reasoning effort picker for the current model                            |
| `/temp`        | Set the session temperature (`/temp 0.4`), or show the current value with no args    |
| `/budget`      | Show used/remaining budget, or set one with `/budget <usd>`                          |
| `/web-search`  | Toggle web search on/off (`/web-search on` / `/web-search off`), show state with no args |
| `/web-results` | Set the web search result count (`/web-results <n>`, OpenRouter only), show it with no args |
| `/retry`       | Re-run the last user turn (regenerates the last answer)                             |
| `/copy`        | Copy the last assistant response to the clipboard                                   |
| `/markdown`    | Toggle terminal markdown rendering (default on)                                     |
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

Every chat session is automatically saved to `~/.communicator/sessions/<timestamp>.json`, with a `title` auto-generated from the first user message (whitespace collapsed, truncated to 50 chars). Sessions are saved when you quit (`/quit` or `Ctrl+C`), when you switch models or start a new session, and on interrupt during streaming (including the partial response). A metadata index at `~/.communicator/sessions/.index.json` powers `--list-sessions` and the resume/export/delete pickers so listing never has to parse full session files. If the index is missing or stale (e.g. sessions from an older version), it is rebuilt automatically from the session files.

### Listing sessions

```bash
communicator --list-sessions
```

Output shows each session's timestamp, model, message count, and the session title:

```
3 saved session(s):

2026-07-30 19:15:22  openai/gpt-4o                        12 msgs       "Write a Python script that..."
2026-07-30 18:42:10  deepseek-v4-flash                     5 msgs       "Explain how garbage collection..."
2026-07-30 17:11:45  google/gemini-2.5-pro                 23 msgs       "Compare Rust and Go for..."
```

### Resuming a session

```bash
# Interactive picker — browse and select from all saved sessions
communicator --resume

# Prefix match — resumes if exactly one session starts with "2026-07-30"
communicator --resume 2026-07-30

# Full session ID — resumes the exact session
communicator --resume 2026-07-30T19-11-45
```

When resuming, the original model, provider backend (OpenRouter or Venice), endpoint provider, reasoning effort, temperature, budget, and web search state (on/off + result count) are restored automatically. The conversation picks up right where you left off — all previous messages are preserved. `--resume` takes precedence over `-m` and `-p` flags (they are silently ignored).

Older sessions saved without a `providerType` field default to OpenRouter for backward compatibility.

### Deleting sessions

```bash
# Interactive picker — browse and select from all saved sessions
communicator --delete

# Prefix match — deletes if exactly one session starts with "2026-07-30"
communicator --delete 2026-07-30

# Full session ID — deletes the exact session
communicator --delete 2026-07-30T19-11-45
```

`--delete` always asks for confirmation before removing the session file (and its sidecar entry). It cannot be combined with `--resume`, `--export`, or a prompt argument, and needs a TTY for the confirmation prompt.

### Exporting sessions

Export any saved session as a clean, readable markdown file:

```bash
# Interactive picker — browse and select from all saved sessions
communicator --export

# Prefix match — exports if exactly one session starts with "2026-07-30"
communicator --export 2026-07-30

# Full session ID — exports the exact session
communicator --export 2026-07-30T19-11-45

# Export to a custom directory (persisted in preferences)
communicator --export --output-dir ~/Documents/CommunicatorExports
```

The exported markdown file is saved as `session-{id}.md` in the current working directory by default. Use `--output-dir` to set a custom directory — once set, it's saved in your preferences and used for all future exports (omit the flag to revert to cwd).

- **Header** — timestamp, title, model, provider, message count, reasoning effort, and accumulated cost
- **User messages** — blockquoted under a `## You` heading
- **Assistant responses** — reasoning shown under `### thinking`, final answer under `### Answer`
- **Cost** — calculated from token usage and provider pricing (shows "N/A" if pricing is unavailable)

Example output:

```markdown
# Chat Session — 2026-07-30 19:11:45 UTC
**Title:** What is the capital of France?
**Model:** `openai/gpt-4o` | **Provider:** OpenAI | **Messages:** 4 | **Cost:** $0.000124

---

## You
> What is the capital of France?

---

## Assistant
### thinking
The user is asking a straightforward geography question...

### Answer
The capital of France is Paris.
```

### Session file format

Each session is stored as a JSON file:

```json
{
  "model": "openai/gpt-4o",
  "providerName": "OpenAI",
  "providerType": "openrouter",
  "reasoningEffort": "high",
  "temperature": 0.7,
  "budget": 0.5,
  "webSearch": true,
  "webResults": 5,
  "title": "What is the capital of France?",
  "pricing": {
    "prompt": 0.0000025,
    "completion": 0.00001
  },
  "createdAt": "2026-07-30T19:11:45.000Z",
  "updatedAt": "2026-07-30T19:15:22.000Z",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi there!", "reasoning": "...", "usage": { "prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17 } }
  ]
}
```

- `providerName` is the endpoint provider (e.g., `"OpenAI"` for OpenRouter, `"venice"` for Venice)
- `providerType` is the API backend (`"openrouter"` or `"venice"`). Older sessions without this field default to `"openrouter"` on resume
- `reasoningEffort` is `null` when reasoning is explicitly disabled
- `temperature` is the resolved session temperature (0–2); `budget` is the per-session cap in USD (`null` when unset)
- `webSearch` is whether web search was enabled; `webResults` is the OpenRouter result count (`null` when default) — both restored on resume
- `title` is auto-generated from the first user message
- `pricing` stores per-token dollar amounts used for cost calculation
- `updatedAt` is bumped on every auto-save
- Empty sessions (no user messages) are never saved
- Older sessions without `temperature`/`budget`/`title` fall back to `0.7` / no cap / no title

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
    "openai/gpt-4o": true
  },
  "outputDir": "/home/user/Documents/CommunicatorExports"
}
```

The last model and provider become defaults in the interactive pickers. Reasoning effort, temperature, and web search are saved per model ID and restored automatically. Preferences are currently scoped across both API backends — your last OpenRouter model will show as the favorite even when using Venice (this will be improved in a future release).

## How it works

```
cli (index.js)            — commander argument parsing, delegates to command modules
├── commands/
│   ├── list-models.js    — --list-models handler
│   ├── list-endpoints.js — --list-endpoints handler
│   ├── list-sessions.js  — --list-sessions handler
│   ├── export-cmd.js     — --export handler
│   ├── delete-cmd.js     — --delete handler (confirm + remove session)
│   ├── one-shot.js       — one-shot mode: prompt argument / stdin piping
│   ├── resume.js         — --resume handler (load session, return params)
│   ├── chat-start.js     — session context setup, chat start, end-of-chat persist
│   └── chat/
│       └── index.js      — slash command registry (12 chatCommands) + budgetGuard
├── providers/
│   ├── index.js          — factory: getProvider(name) → provider module; common chatCompletion contract
│   ├── openrouter.js     — OpenRouter API client: models, endpoints, chat completions
│   └── venice.js         — Venice.ai API client: models, synthetic endpoints, chat
├── model-selection.js    — interactive and non-interactive (-m) selection flows
├── http.js               — fetchWithTimeout (30s) + fetchWithRetry (backoff, stream-safe)
├── errors.js             — ApiError (status/provider/retryable) and formatError
├── sse-parser.js         — shared SSE stream parser (consumed by both providers)
├── config.js             — API key lookup (provider meta), preferences load/save (~/.communicator.json)
├── constants.js          — shared constants (paths, labels, temperature bounds, SSE markers) and formatCost
├── prompts.js            — interactive TUI pickers using @inquirer/prompts (model, provider, reasoning effort)
├── flags.js              — CLI flag resolvers (temperature, web search/results, reasoning, budget)
├── reasoning.js          — reasoning effort default resolution + web search capability check
├── chat-state.js         — ChatState: session state + pure transitions + final-state snapshot
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
│   ├── markdown.js       — line-buffered terminal markdown renderer
│   └── stream.js         — stream renderer + history replay
└── chat.js               — runChatSession: DI chat loop (readInput/renderer/stdout/exit/save/signals), banner, SIGINT
```

Dependencies: [`commander`](https://www.npmjs.com/package/commander) for CLI argument parsing and [`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts) for the interactive search/select UI. Multi-line input uses a vendored copy of [`@toiroakr/read-multiline`](https://www.npmjs.com/package/@toiroakr/read-multiline) 0.4.1 (see `src/vendor/read-multiline/README.md`).

### Architecture

The chat flow is built around four pieces:

- **`ChatState` (`src/chat-state.js`)** — the mutable session state (model, reasoning effort, temperature, budget, web search, messages, …) with pure transitions (`setTemperature`, `applyModelSelection`, `toggleMarkdown`, …). `toFinalState()` produces the exact snapshot written to the session file; `resetForNewSession()` backs `/new`.
- **Command registry (`src/commands/chat/index.js`)** — the 12 slash commands live in a data-driven map of `/name → async (ctx) => outcome`; `CHAT_COMMANDS` is derived from the registry keys so the suggestion list and the loop can never drift. Handlers never call `process.exit` — they return `{ exit }` / `{ reset }` signals that the loop translates into exit codes, which keeps every handler unit-testable (`test/chat-commands.test.js`).
- **`runChatSession(ctx, deps)` (`src/chat.js`)** — the chat loop is dependency-injected: `deps = { readInput, renderer, stdout, exit, saveSession, savePrefs, onSignal, newSessionId }`, each defaulting to the real implementation, so production behavior is unchanged while the whole loop is drivable with fakes (`test/chat-loop.test.js`). Signal handling (idle/streaming SIGINT, `beforeExit`, `uncaughtException`) is registered through `onSignal`.
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
- `chatCompletion` receives `signal` (AbortController) for SIGINT cancellation, `sessionId` for server-side prompt caching (OpenRouter currently ignores it; Venice maps it to `prompt_cache_key`), and `temperature` (default `0.7`, must be set in the request body). `webSearch`/`webResults` enable web search — providers may ignore options they do not support (see the contract doc in `src/providers/index.js`)
- HTTP calls should go through `fetchWithRetry` from `src/http.js`; errors must be thrown as `ApiError`, never `process.exit`

See `src/providers/openrouter.js` and `src/providers/venice.js` for reference implementations.

## Uninstall

```bash
npm unlink -g communicator
rm ~/.communicator.json
rm -rf ~/.communicator
```

If you used a custom config path with `--config`, delete that file instead.

## License

[MIT](LICENSE.md)
