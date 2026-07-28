# Communicator

OpenRouter CLI chat client with interactive model and provider selection.

# NOTE

This is a very small project, for general testing, not meant for serious usage.

## Compatibility

- macOS (Apple Silicon + Intel) — tested
- Linux — should work, untested
- Windows — should work, untested
- Node.js 18, 20, 22, 24, 26+

## Install

```bash
# Clone and link globally
git clone https://github.com/user/communicator.git ~/Communicator
cd ~/Communicator
npm install
npm link
```

`npm link` creates a symlink at `/opt/homebrew/bin/communicator` (Apple Silicon with Homebrew Node) or `/usr/local/bin/communicator` (Intel / non-Homebrew).

Verify with:

```bash
communicator --help
```

## Uninstall

```bash
npm unlink -g communicator
```

Or manually:

```bash
rm /opt/homebrew/bin/communicator
rm -rf /opt/homebrew/lib/node_modules/communicator
```

## Remove trailing files:
```bash
rm ~/.communicator
rm ~/.openrouter-key
```

## Setup

Set the `OPENROUTER_API_KEY` environment variable:

```bash
export OPENROUTER_API_KEY="sk-or-v1-your-key-here"
```

Add that line to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) to persist it.

## Usage

```bash
communicator                                        # interactive: pick model → reasoning effort → provider → chat
communicator -m "openai/gpt-4o"                     # skip model picker
communicator -m "openai/gpt-4o" -p "OpenAI"          # skip model and provider pickers
communicator -l                                     # list all available models
communicator -L "openai/gpt-4o"                     # list providers/endpoints for a model
communicator --reasoning-effort high                # force reasoning effort level
communicator --no-reasoning                         # disable reasoning entirely
communicator --config /path/to/config.json          # custom preferences file path
communicator -m "openai/gpt-4o" -p "OpenAI" \
  --reasoning-effort high --no-reasoning            # mutually exclusive — last wins
```

### Options

| Flag | Description |
|------|-------------|
| `-m, --model <id>` | Skip the model picker and use the given model ID directly |
| `-p, --provider <name>` | Skip the provider picker and use the given provider name directly |
| `-l, --list` | Fetch and display all available models (name, ID, context length) then exit |
| `-L, --list-endpoints <model>` | Fetch and display providers/endpoints for a specific model (pricing, uptime) then exit |
| `--reasoning-effort <level>` | Override reasoning effort: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none` |
| `--no-reasoning` | Disable reasoning entirely (`reasoning.enabled: false`) |
| `--config <path>` | Custom path for the preferences JSON file (default: `~/.communicator.json`) |

### Interactive flow

1. **Model selection** — searchable, filterable picker. If you have a saved preference, your last model appears first.
2. **Reasoning effort** — only shown for models that support reasoning. Effort is saved per model across sessions.
3. **Provider selection** — shows pricing, uptime, and tags. You can go ← back to model selection. Single-provider models skip this step.

### Chat

Once connected, type your message and press Enter. Responses stream token by token. Reasoning tokens are displayed in gray with a `[Thinking]` label, then a `[Answer]` separator precedes the final response.

```
> What is the capital of France?

[Thinking]
The user is asking about the capital of France...

[Answer]

The capital of France is Paris.
```

Special commands:
- `/quit` — exit the chat session
- `Cmd+C` / `Ctrl+C` — interrupt and exit

### Preferences

Preferences are saved to `~/.communicator.json` (or the path from `--config`):

```json
{
  "lastModel": "openai/gpt-4o",
  "lastProvider": "OpenAI",
  "reasoningEffort": {
    "openai/o1-pro": "high"
  }
}
```

The last model and provider are restored as defaults in the interactive pickers on next launch. Reasoning effort preferences are stored per model ID.
