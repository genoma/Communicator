# Communicator

A terminal-first AI chat client for **OpenRouter** and **Venice.ai** — stream responses with visible reasoning, pick models and providers interactively, track live usage and cost with per-session budget caps, search the web with clickable sources, and resume or export any conversation as markdown.

## Features

- **Multi-provider** — OpenRouter and Venice.ai backends, switchable via `--provider`; the provider abstraction layer makes adding new backends straightforward
- **Interactive model picker** — searchable and filterable by name or model ID, with context-length display
- **Provider selection** — compare pricing, uptime %, and routing tags before starting a chat. Single-provider models skip this step automatically, and Venice models go straight to chat
- **Reasoning effort control** — per-model effort level persisted across sessions. OpenRouter uses its native reasoning format; Venice uses the standard OpenAI `reasoning_effort`
- **Temperature control** — `--temperature <0-2>` flag, `/temp` command, per-model default persisted in preferences
- **Web search** — three modes per model (`off`, `auto` = model decides, `always` = force a search) via `--web-search`/`/web-search`, with a result-count knob on OpenRouter. See [docs/web-search.md](docs/web-search.md)
- **File & image attachments** — attach images, PDFs, office files, and text/code files with `/attach <path>...` (interactive) or `--attach <path>` (one-shot). See [docs/attachments.md](docs/attachments.md)
- **Model-produced images & files** — artifacts from image-output models are downloaded into the session, saved with the conversation, replayed on `--resume`, and listed in `--export`
- **Image generation** — generate images on **both providers** with `--image`, `/image`, or by picking an image model in the unified picker; per-provider sizing defaults, Venice watermark and safe mode controls included. See [docs/images.md](docs/images.md)
- **One-shot mode** — pass a prompt argument or pipe stdin for a single non-interactive answer. TTY-aware output: styled with a usage footer on a terminal, plain answer text only when piped
- **Per-session budget caps** — `--budget <usd>` or `/budget <usd>` limits accumulated session cost; warns at 80% used and refuses turns at 100%
- **Zero data retention** — `--zdr` (OpenRouter only) forces every request through zero-data-retention routing: no caching, no logging, no training. Picker selection filters to ZDR-capable entries
- **Terminal markdown rendering** — responses styled in the terminal (headers, bold/italic, code blocks, lists, quotes, links) with a `/markdown` toggle
- **Streaming responses** — tokens appear as they arrive, with reasoning shown in gray under a `❯ Thinking` banner
- **Smooth streaming** — interactive output is paced for a steady render rate (default on; disable with `--no-smooth-streaming` or `/smooth off`)
- **Usage & cost tracking** — per-turn and cumulative token counts, a context-window (CTX) indicator, cache-hit detection, and dollar-cost breakdowns; check anytime with `/cost`
- **Slash commands** — `/new`, `/model`, `/reasoning`, `/temp`, `/budget`, `/web-search`, `/attach`, `/retry`, `/copy`, `/markdown`, `/smooth`, `/cost`, `/watermark`, `/quit`, and more. See [docs/commands.md#slash-commands](docs/commands.md#slash-commands)
- **Session auto-save** — every chat is saved as a JSON file in `~/.communicator/sessions/` with an auto-generated title, on quit, model switch, new session, or `Ctrl+C` — the last exchange is never lost
- **Session resume** — restore any past conversation with `--resume`, keeping the same model, provider, reasoning effort, temperature, and budget
- **Session deletion** — remove saved sessions with `--delete` (with confirmation)
- **Markdown export** — export any saved session as a clean markdown file with `--export`, with separate thinking sections and cost summary
- **Session persistence** — last model, provider, and per-model reasoning effort and temperature are saved to `~/.communicator.json` and restored on next launch
- **CLI flags to skip pickers** — `-m` skips *all* pickers for fully non-interactive use; `--reasoning-effort` skips only the reasoning picker
- **Lightweight** — five runtime dependencies, pure Node.js ESM

## Documentation

The full documentation lives in the [`docs/`](docs/) folder, organized into guides, reference pages, and a contributor guide — see the [documentation index](docs/README.md).

## Requirements

- **Node.js** >= 22.3

### API Keys

At least one of:

| Provider   | Env variable          | Get a key at                          |
|------------|-----------------------|---------------------------------------|
| OpenRouter | `OPENROUTER_API_KEY`  | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Venice.ai  | `VENICE_API_KEY`      | [venice.ai/settings/api](https://venice.ai/settings/api) |

You can set up both to switch between them at runtime.

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/communicator.git ~/Communicator
cd ~/Communicator
npm install
npm link
```

`npm link` creates a system-wide symlink so `communicator` is available from any terminal. The exact path depends on your Node.js installation — see [Install & environment on Linux/Windows](docs/platforms.md#install--environment-on-linuxwindows) for the per-OS table.

Set your API key:

```bash
# OpenRouter
export OPENROUTER_API_KEY="sk-or-v1-your-key-here"

# Venice.ai
export VENICE_API_KEY="vkey-your-key-here"
```

Add those lines to `~/.zshrc`, `~/.bashrc`, or your shell's equivalent to make them permanent.

Verify it worked:

```bash
communicator --help
communicator -m "openai/gpt-4o" "What is the capital of France?"
```

## License

[MIT](LICENSE.md)
