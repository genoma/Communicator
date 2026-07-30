# Communicator

Chat from your terminal with streaming responses, interactive model/provider selection, and live cost tracking.

> ⚠️ **Heads up:** This is a hobby project I built for myself, shared in case it helps someone else. It works, maybe, but:
> - OpenRouter only, no other APIs for now
> - Rough around the edges (minimal error handling)
> - Text only, no vision
> - No promises beyond "it mostly doesn't break"
> - Minimal testing (cross your fingers and use cheap models)
> 
> Fork it, break it, fix it, disregard it, I won't take it personally.

## Features

- **Interactive model picker** — searchable and filterable by name or model ID, with context-length display
- **Provider selection** — compare pricing, uptime %, and routing tags before starting a chat. Single-provider models skip this step automatically. Navigate back to the model picker at any time
- **Reasoning effort control** — per-model effort level persisted across sessions. Only shown for models that support reasoning
- **Streaming responses** — tokens appear as they arrive, with reasoning tokens shown in gray under a `[Thinking]` banner and a `[Answer]` separator before the final response
- **Usage & cost tracking** — after each turn: prompt / completion / total token counts, cache hit detection, and a dollar-cost breakdown (per turn + cumulative session total)
- **Session auto-save** — every chat is saved as a JSON file in `~/.communicator/sessions/`. Each turn writes atomically; `/quit` and `Ctrl+C` trigger a final save
- **Session resume** — restore any past conversation with `--resume`, keeping the same model, provider, and reasoning effort. Supports prefix matching and an interactive picker
- **Markdown export** — export any saved session as a clean markdown file with `--export`, with collapsible reasoning blocks and cost summary
- **Session persistence** — last model, provider, and per-model reasoning effort are saved to `~/.communicator.json` and restored on next launch
- **CLI flags to skip pickers** — pass `-m`, `-p`, `--reasoning-effort`, or `--no-reasoning` to bypass interactive prompts
- **Lightweight** — two runtime dependencies, pure Node.js ESM

## Requirements

- **Node.js** >= 18
- **OpenRouter API key** — create one at [openrouter.ai/keys](https://openrouter.ai/keys)

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
export OPENROUTER_API_KEY="sk-or-v1-your-key-here"
```

Add that line to `~/.zshrc`, `~/.bashrc`, or your shell's equivalent to make it permanent.

## Commands

| Short | Flag                  | Args     | Description                                                                          |
|-------|-----------------------|----------|--------------------------------------------------------------------------------------|
| `-m`  | `--model`             | `<id>`   | Skip the model picker and use this model directly                                    |
| `-p`  | `--provider`          | `<name>` | Skip the provider picker and use this provider directly                              |
| `--re`| `--reasoning-effort`  | `<level>`| Force reasoning effort: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`   |
| `--nr`| `--no-reasoning`      | —        | Disable reasoning entirely                                                           |
| `--lm`| `--list-models`       | —        | List all available models (name, ID, context length) and exit                        |
| `--le`| `--list-endpoints`    | `<model>`| List providers for a model (pricing, uptime) and exit                                |
| `--ls`| `--list-sessions`     | —        | List saved sessions (timestamp, model, message count, preview) and exit              |
| `-r`  | `--resume`            | `[id]`   | Resume a saved session. No arg = picker, partial ID = prefix match                   |
| `-e`  | `--export`            | `[id]`   | Export a session to markdown. Same ID matching as `--resume`                         |
| `--od`| `--output-dir`        | `<path>` | Set export directory for markdown files (saved in preferences)                       |
| `--cfg`| `--config`           | `<path>` | Custom path for the preferences JSON file (default: `~/.communicator.json`)          |
| `--sp`| `--system-prompt`     | `<path>` | Custom path for the system prompt file (default: `~/.communicator-system-prompt.md`) |

`--reasoning-effort` and `--no-reasoning` are mutually exclusive — the last one on the command line wins.

Quick start:

```bash
communicator                                         # full interactive flow
communicator -m "openai/gpt-4o" -p "OpenAI"          # skip pickers
communicator --ls                                    # list saved sessions
communicator --resume                                # resume a saved session
communicator --export                                # export a session to cwd
communicator --export --output-dir ~/Documents       # export to custom directory
```

## Usage

### Interactive flow

1. **Model selection** — searchable picker with fuzzy filtering by name or ID. Your last-used model appears first.
2. **Reasoning effort** — shown only when the selected model supports reasoning. The chosen level is saved per model and restored as default next time.
3. **Provider selection** — displays pricing, 30-minute uptime %, and routing tags. Navigate ← back to the model picker to change your selection. Models with a single provider skip this step entirely.

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

Cache hits are detected and shown when OpenRouter serves a cached response. The session cost accumulates across turns within the same chat.

Special commands:

| Input             | Action               |
|-------------------|----------------------|
| `/quit`           | Exit the chat        |
| `Cmd+C` / `Ctrl+C` | Interrupt and exit  |

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

## Session Persistence & Resume

Every chat session is automatically saved to `~/.communicator/sessions/<timestamp>.json`. Sessions are saved after each turn and on exit, so you never lose conversation history even on crashes.

### Listing sessions

```bash
communicator --ls
communicator --list-sessions
```

Output shows each session's timestamp, model, message count, and a preview of the first message:

```
3 saved session(s):

2026-07-30 19:15:22  openai/gpt-4o                        12 msgs       "Write a Python script that..."
2026-07-30 18:42:10  anthropic/claude-sonnet-4-20250514   5 msgs        "Explain how garbage collection..."
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

When resuming, the original model, provider, and reasoning effort are restored automatically. The conversation picks up right where you left off — all previous messages are preserved. `--resume` takes precedence over `-m` and `-p` flags (they are silently ignored).

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
  "reasoningEffort": "high",
  "createdAt": "2026-07-30T19:11:45.000Z",
  "updatedAt": "2026-07-30T19:15:22.000Z",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi there!", "reasoning": "..." }
  ]
}
```

- `reasoningEffort` is `null` when reasoning is explicitly disabled
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

The last model and provider become defaults in the interactive pickers. Reasoning effort is saved per model ID and restored automatically.

## How it works

```
cli (index.js)           — commander argument parsing, delegates to command modules
├── commands/
│   ├── list-models.js   — --list handler
│   ├── list-endpoints.js — --list-endpoints handler
│   ├── list-sessions.js — --list-sessions handler
│   ├── export-cmd.js    — --export handler
│   ├── resume.js        — --resume handler (load session, return params)
│   └── chat-start.js    — main interactive flow: model/provider pickers, chat, save
├── config.js            — API key (env), preferences load/save (~/.communicator.json)
├── constants.js         — shared constants (paths, labels, SSE markers) and formatCost
├── openrouter.js        — OpenRouter API client: models, endpoints, streaming chat completions
├── prompts.js           — interactive TUI pickers using @inquirer/prompts (model, provider, reasoning)
├── sessions.js          — session persistence: save, load, list, resolve (~/.communicator/sessions/)
├── session-picker.js    — interactive session selector for --resume and --export
├── export.js            — markdown exporter: format session data, write to file
├── tracker.js           — per-turn + cumulative token/cost accounting with cache detection
└── chat.js              — readline loop, token streaming display, usage tracking integration, auto-save
```

Dependencies: [`commander`](https://www.npmjs.com/package/commander) for CLI argument parsing and [`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts) for the interactive search/select UI.

## Uninstall

```bash
npm unlink -g communicator
rm ~/.communicator.json
rm -rf ~/.communicator
```

If you used a custom config path with `--config`, delete that file instead.

## License

[MIT](LICENSE.md)
