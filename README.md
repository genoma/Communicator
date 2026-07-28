# Communicator

OpenRouter CLI chat client with interactive model and provider selection.

## Compatibility

- macOS (Apple Silicon + Intel) via Homebrew Node, or any Node.js ≥ 18
- Linux — untested but should work with Node.js ≥ 18
- Node.js 18, 20, 22, 24, 26+

Uses zero native dependencies. Only standard Node APIs plus two pure-JS packages.

## Install

```bash
# Clone and link globally
git clone https://github.com/user/communicator.git ~/Documents/Communicator
cd ~/Documents/Communicator
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

## Setup

Create `~/.openrouter-key` with your OpenRouter API key as plain text:

```bash
echo "sk-or-v1-your-key-here" > ~/.openrouter-key
```

## Usage

```bash
communicator                                 # pick model → pick provider → chat
communicator -m "openai/gpt-4o"             # skip model picker
communicator -m "openai/gpt-4o" -p "OpenAI" # skip both pickers
communicator -l                             # list all models
communicator -L "openai/gpt-4o"             # list providers for a model
communicator --key-file /path/to/key        # custom key file path
communicator --config /path/to/config.json  # custom config file path
```

In chat mode, type your message and press Enter. The response streams token by token.
Type `/quit` or Ctrl+C to exit.

Preferences (last chosen model and provider) are saved to `~/.communicator.json`.
