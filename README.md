# Communicator

OpenRouter CLI chat client with interactive model and provider selection.

## NOTE

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
communicator                                 # pick model → pick provider → chat
communicator -m "openai/gpt-4o"             # skip model picker
communicator -m "openai/gpt-4o" -p "OpenAI" # skip both pickers
communicator -l                             # list all models
communicator -L "openai/gpt-4o"             # list providers for a model
communicator --config /path/to/config.json  # custom config file path
```

In chat mode, type your message and press Enter. The response streams token by token.
Type `/quit` or Cmd+C/Ctrl+C to exit.

Preferences (last chosen model and provider) are saved to `~/.communicator.json`.
