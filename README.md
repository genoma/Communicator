# Communicator

Chat from your terminal with streaming responses, interactive model/provider selection, and live cost tracking.

> ⚠️ **Heads up:** This is a hobby project I built for myself, shared in case it helps someone else. It works ish, but:
> - OpenRouter only, no other APIs for now
> - Rough around the edges (minimal error handling)
> - Text only, no vision
> - No promises beyond "it mostly doesn't break"
> 
> Fork it, break it, fix it, disregard it, I won't take it personally.

## Features

- **Interactive model picker** — searchable and filterable by name or model ID, with context-length display
- **Provider selection** — compare pricing, uptime %, and routing tags before starting a chat. Single-provider models skip this step automatically. Navigate back to the model picker at any time
- **Reasoning effort control** — per-model effort level persisted across sessions. Only shown for models that support reasoning
- **Streaming responses** — tokens appear as they arrive, with reasoning tokens shown in gray under a `[Thinking]` banner and a `[Answer]` separator before the final response
- **Usage & cost tracking** — after each turn: prompt / completion / total token counts, cache hit detection, and a dollar-cost breakdown (per turn + cumulative session total)
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
communicator --config /path/to/config.json            # custom preferences path
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
| `--config <path>`                 | Custom path for the preferences JSON file (default: `~/.communicator.json`)                          |

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
├── tracker.js     — per-turn + cumulative token/cost accounting with cache detection
└── chat.js        — readline loop, token streaming display, usage tracking integration
```

Dependencies: [`commander`](https://www.npmjs.com/package/commander) for CLI argument parsing and [`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts) for the interactive search/select UI.

## Uninstall

```bash
npm unlink -g communicator
rm ~/.communicator.json
```

If you used a custom config path with `--config`, delete that file instead.

## License

[MIT](LICENSE.md)
