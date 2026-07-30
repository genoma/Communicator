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

## Usage

```bash
communicator                                          # full interactive flow
communicator -m "openai/gpt-4o"                       # skip model picker
communicator -m "openai/gpt-4o" -p "OpenAI"            # skip model + provider pickers
communicator -l                                       # list all available models
communicator -L "openai/gpt-4o"                       # list providers for a model
communicator --reasoning-effort high                  # force reasoning level
communicator --no-reasoning                           # disable reasoning
communicator --resume                                  # pick a session to resume from a list
communicator --resume 2026-07-30                       # resume matching a prefix (first 10 chars of session ID)
communicator --resume 2026-07-30T19-11-45              # resume an exact session by its ID
communicator --list-sessions                           # list saved sessions and exit
communicator --config /path/to/config.json             # custom preferences path
communicator --system-prompt /path/to/prompt.md        # custom system prompt file
```

### Options

| Flag                              | Description                                                                                          |
|-----------------------------------|------------------------------------------------------------------------------------------------------|
| `-m, --model <id>`                | Skip the model picker, use this model ID directly                                                    |
| `-p, --provider <name>`           | Skip the provider picker, use this provider name directly                                            |
| `-l, --list`                      | Fetch and display all available models (name, ID, context length), then exit                         |
| `-L, --list-endpoints <model>`    | Fetch and display providers/endpoints for a model (pricing, uptime), then exit                       |
| `--reasoning-effort <level>`      | Force reasoning effort: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`                   |
| `--no-reasoning`                  | Disable reasoning entirely                                                                           |
| `-r, --resume [session-id]`      | Resume a saved session. Without an ID, shows an interactive picker. With an ID, matches by prefix    |
| `--list-sessions`                | List saved sessions (timestamp, model, message count, preview) and exit                              |
| `--config <path>`                 | Custom path for the preferences JSON file (default: `~/.communicator.json`)                          |
| `--system-prompt <path>`          | Custom path for the system prompt file (default: `~/.communicator-system-prompt.md`)                 |

`--reasoning-effort` and `--no-reasoning` are mutually exclusive — the last one on the command line wins.

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
  }
}
```

The last model and provider become defaults in the interactive pickers. Reasoning effort is saved per model ID and restored automatically.

## How it works

```
cli (index.js)     — commander argument parsing, orchestration
├── config.js      — API key (env), preferences load/save (~/.communicator.json)
├── openrouter.js  — OpenRouter API client: models, endpoints, streaming chat completions
├── prompts.js     — interactive TUI pickers using @inquirer/prompts (model, provider, reasoning)
├── sessions.js    — session persistence: save, load, list, resolve (~/.communicator/sessions/)
├── session-picker.js — interactive session selector for --resume
├── tracker.js     — per-turn + cumulative token/cost accounting with cache detection
└── chat.js        — readline loop, token streaming display, usage tracking integration, auto-save
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
