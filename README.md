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
- **Streaming responses** — tokens appear as they arrive, with reasoning tokens shown in gray under a `[Thinking]` banner and a `[Answer]` separator before the final response
- **Usage & cost tracking** — after each turn: prompt / completion / total token counts, cache hit detection (OpenRouter), and a dollar-cost breakdown (per turn + cumulative session total). Check anytime with `/cost`
- **Slash commands** — `/new` starts a fresh session, `/model` switches models mid-chat, `/reasoning` re-picks the reasoning effort, `/cost` shows the running total, `/quit` exits
- **Session auto-save** — every chat is saved as a JSON file in `~/.communicator/sessions/`. Sessions are saved when you quit, switch models, start a new session, or interrupt with `Ctrl+C`, so the last exchange is never lost
- **Session resume** — restore any past conversation with `--resume`, keeping the same model, provider, and reasoning effort. Automatically detects and uses the correct API backend. Supports prefix matching and an interactive picker
- **Markdown export** — export any saved session as a clean markdown file with `--export`, with collapsible reasoning blocks and cost summary
- **Session persistence** — last model, provider, and per-model reasoning effort are saved to `~/.communicator.json` and restored on next launch
- **CLI flags to skip pickers** — pass `-m`, `--reasoning-effort`, or `--no-reasoning` to bypass interactive prompts. `-m` skips *all* pickers (model, reasoning, endpoint) for fully non-interactive use
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
|       | `--reasoning-effort`  | `<level>`| Force reasoning effort: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`   |
|       | `--no-reasoning`      | —        | Disable reasoning entirely                                                           |
| `-V`  | `--version`           | —        | Print the version and exit                                                           |
|       | `--list-models`       | —        | List all available models (name, ID, context length) and exit                        |
|       | `--list-endpoints`    | `<model>`| List providers for a model (pricing, uptime) and exit                                |
|       | `--list-sessions`     | —        | List saved sessions (timestamp, model, message count, preview) and exit              |
| `-r`  | `--resume`            | `[id]`   | Resume a saved session. No arg = picker, partial ID = prefix match                   |
| `-x`  | `--export`            | `[id]`   | Export a session to markdown. Same ID matching as `--resume`                         |
|       | `--output-dir`        | `<path>` | Set export directory for markdown files (saved in preferences)                       |
|       | `--config`            | `<path>` | Custom path for the preferences JSON file (default: `~/.communicator.json`)          |
|       | `--system-prompt`     | `<path>` | Custom path for the system prompt file (default: `~/.communicator-system-prompt.md`) |

`--reasoning-effort` and `--no-reasoning` are mutually exclusive — the last one on the command line wins.

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

# Session management
communicator --list-sessions                                   # list saved sessions
communicator --resume                                   # resume a saved session
communicator --export                                   # export a session to cwd
communicator --export --output-dir ~/Documents          # export to custom directory

# Reasoning
communicator -m "deepseek/deepseek-v4-flash" --reasoning-effort high  # force high reasoning effort
communicator --no-reasoning                                              # disable reasoning
communicator -p venice -m "deepseek-v4-flash" --reasoning-effort high    # Venice with reasoning
```

## Usage

### Providers

Communicator supports two API backends:

- **OpenRouter** — Multi-provider gateway with endpoint-level routing. When you select a model, you'll pick which provider (e.g., OpenAI, Azure, Anthropic) actually serves the request. Supports cache-hit detection and per-endpoint pricing comparisons. Use `--provider openrouter` (this is the default).

- **Venice.ai** — Direct model access without multi-provider routing. Models are available directly; there's no endpoint picker step. Venice's `/models` endpoint is public, so you can list models without an API key. Use `--provider venice`.

The provider is saved in each session, so resuming a Venice session automatically uses the Venice backend — no need to pass `-p venice` again.

### Interactive flow

1. **Model selection** — searchable picker with fuzzy filtering by name or ID. Your last-used model appears first. Venice models show names as listed on the Venice dashboard (e.g., `Qwen 3.7 Max`); OpenRouter models include the org prefix (e.g., `Google: Gemini 3.6 Flash`).
2. **Reasoning effort** — shown only when the selected model supports reasoning. The chosen level is saved per model and restored as default next time. Venice uses the standard OpenAI `reasoning_effort` parameter; OpenRouter uses its native reasoning format.
3. **Provider selection** (OpenRouter only) — displays pricing, 30-minute uptime %, and routing tags. Navigate ← back to the model picker to change your selection. Models with a single provider skip this step entirely. Venice models go straight to chat.

Passing `-m <id>` skips **all** pickers: the reasoning effort is restored from your saved per-model preference (or the model default), and the OpenRouter endpoint is auto-selected (cheapest provider with pricing, otherwise the first one). Venice always goes straight to chat. `--reasoning-effort` / `--no-reasoning` still override the effort when given.

### Chat session

Once connected, responses stream token by token. Reasoning tokens appear in gray with a `[Thinking]` label. After the final answer, a usage summary is printed automatically:

```
> What is the capital of France?

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

### Slash commands

| Input          | Action                                                                              |
|----------------|-------------------------------------------------------------------------------------|
| `/quit`        | Save the session and exit the chat                                                  |
| `/new`         | Save the current session and start a fresh one (same model and reasoning effort)    |
| `/model`       | Save, then switch models mid-chat — re-picks reasoning effort and endpoint          |
| `/reasoning`   | Re-run the reasoning effort picker for the current model                            |
| `/cost`        | Print the running session cost/token totals and current reasoning effort            |
| `Cmd+C` / `Ctrl+C` | During streaming: abort, save the partial response, and exit. At the prompt: cancel and exit |

Unknown slash commands (anything starting with `/`) print a hint listing the available commands instead of being sent to the model.

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

Every chat session is automatically saved to `~/.communicator/sessions/<timestamp>.json`. Sessions are saved when you quit (`/quit` or `Ctrl+C`), when you switch models or start a new session, and on interrupt during streaming (including the partial response). A metadata index at `~/.communicator/sessions/.index.json` powers `--list-sessions` and the resume/export pickers so listing never has to parse full session files. If the index is missing or stale (e.g. sessions from an older version), it is rebuilt automatically from the session files.

### Listing sessions

```bash
communicator --list-sessions
communicator --list-sessions
```

Output shows each session's timestamp, model, message count, and a preview of the first message:

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

When resuming, the original model, provider backend (OpenRouter or Venice), endpoint provider, and reasoning effort are restored automatically. The conversation picks up right where you left off — all previous messages are preserved. `--resume` takes precedence over `-m` and `-p` flags (they are silently ignored).

Older sessions saved without a `providerType` field default to OpenRouter for backward compatibility.

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

- **Header** — timestamp, model, provider, message count, reasoning effort, and accumulated cost
- **User messages** — blockquoted under a `## You` heading
- **Assistant responses** — reasoning shown under `### thinking`, final answer under `### Answer`
- **Cost** — calculated from token usage and provider pricing (shows "N/A" if pricing is unavailable)

Example output:

```markdown
# Chat Session — 2026-07-30 19:11:45 UTC
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
- `pricing` stores per-token dollar amounts used for cost calculation
- `updatedAt` is bumped on every auto-save
- Empty sessions (no user messages) are never saved

## Preferences

Stored in `~/.communicator.json` (customizable with `--config`):

```json
{
  "lastModel": "openai/gpt-4o",
  "lastProvider": "OpenAI",
  "reasoningEffort": {
    "openai/o1-pro": "high"
  },
  "outputDir": "/home/user/Documents/CommunicatorExports"
}
```

The last model and provider become defaults in the interactive pickers. Reasoning effort is saved per model ID and restored automatically. Preferences are currently scoped across both API backends — your last OpenRouter model will show as the favorite even when using Venice (this will be improved in a future release).

## How it works

```
cli (index.js)           — commander argument parsing, delegates to command modules
├── commands/
│   ├── list-models.js   — --list-models handler
│   ├── list-endpoints.js — --list-endpoints handler
│   ├── list-sessions.js  — --list-sessions handler
│   ├── export-cmd.js     — --export handler
│   ├── resume.js        — --resume handler (load session, return params)
│   └── chat-start.js    — session context setup, chat start, end-of-chat persist
├── providers/
│   ├── index.js         — factory: getProvider(name) → provider module
│   ├── openrouter.js    — OpenRouter API client: models, endpoints, chat completions
│   └── venice.js        — Venice.ai API client: models, synthetic endpoints, chat
├── model-selection.js   — interactive and non-interactive (-m) selection flows
├── http.js              — fetchWithTimeout (30s) + fetchWithRetry (backoff, stream-safe)
├── errors.js            — ApiError (status/provider/retryable) and formatError
├── sse-parser.js        — shared SSE stream parser (consumed by both providers)
├── config.js            — API key lookup (provider meta), preferences load/save (~/.communicator.json)
├── constants.js         — shared constants (paths, labels, SSE markers) and formatCost
├── prompts.js           — interactive TUI pickers using @inquirer/prompts (model, provider, reasoning)
├── sessions.js          — session persistence: save, load, list, sidecar index, resolve
├── session-picker.js    — interactive session selector for --resume and --export
├── export.js            — markdown exporter: format session data, write to file
├── tracker.js           — per-turn + cumulative token/cost accounting with cache detection
├── ui/
│   ├── style.js         — ANSI helpers (dim, bold, sep, thinking, answer)
│   ├── format.js        — price formatting (formatModelPrice, formatPricePerM)
│   └── stream.js        — stream renderer + history replay
└── chat.js              — chat loop, slash commands, save-on-exit, SIGINT handling
```

Dependencies: [`commander`](https://www.npmjs.com/package/commander) for CLI argument parsing, [`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts) for the interactive search/select UI, and [`@toiroakr/read-multiline`](https://www.npmjs.com/package/@toiroakr/read-multiline) for paste-safe multiline input.

### Provider contract

Adding a new provider requires implementing the following exports:

```js
export const meta = { name, baseURL, apiKeyEnv, hasEndpoints }
export async function fetchModels(apiKey) → [{id, name, provider, contextLength, description, reasoning, pricing, capabilities}]
export async function fetchEndpoints(apiKey, modelId, allModels?) → [{name, providerName, tag, status, uptime30m, pricing, ...}]
export async function chatCompletion({apiKey, model, messages, onToken, provider, reasoningEffort, supportsReasoning, sessionId, signal}) → {content, reasoning, usage}
export function normalizePricing(rawPricing) → {prompt, completion}
export function handleHttpError(status, body) → throws ApiError
```

- `pricing` is `{ prompt, completion }` USD per token (or `null`) — use `normalizePricing` and the helpers in `src/ui/format.js` for display
- `chatCompletion` receives `signal` (AbortController) for SIGINT cancellation and `sessionId` for server-side prompt caching (OpenRouter currently ignores it; Venice maps it to `prompt_cache_key`)
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
