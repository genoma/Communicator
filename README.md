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
- **Model-produced images & files** — when a model outputs an image or file (e.g. image-generation models on OpenRouter), the artifact is downloaded into the session, saved with the conversation, and shown with its location — `image: photo.png  saved to ~/.communicator/sessions/…`. Produced artifacts are replayed on `--resume` and listed in `--export`
- **Image generation (Venice)** — generate images directly from the CLI with `--image` (one-shot, `--list-image-models` to browse models, per-model sizing flags) or `/image <description>` inside a Venice chat. Images are saved into the session, resumable and exportable, with an optional `--output-dir` copy
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

Each topic has its own page in the [`docs/`](docs/) folder:

| Page | Covers |
|------|--------|
| [`docs/commands.md`](docs/commands.md) | The full CLI flag reference table, usage examples for every flag, and the in-chat slash commands with autocomplete behavior |
| [`docs/chat.md`](docs/chat.md) | The interactive flow, one-shot mode, chat session output (CTX indicator), markdown rendering, smooth streaming, budget caps, and the system prompt |
| [`docs/web-search.md`](docs/web-search.md) | Web search modes, OpenRouter vs Venice behavior, result counts, and clickable sources |
| [`docs/attachments.md`](docs/attachments.md) | File & image attachments: supported formats, interactive and one-shot usage, gating, limits |
| [`docs/images.md`](docs/images.md) | Venice image generation: `--image` flags, `/image`, model listing, sizing, storage |
| [`docs/providers.md`](docs/providers.md) | The OpenRouter and Venice.ai backends, and zero-data-retention (ZDR) routing |
| [`docs/sessions.md`](docs/sessions.md) | Session persistence: listing, resuming, deleting, exporting, and the on-disk session file format |
| [`docs/preferences.md`](docs/preferences.md) | The preferences file (`~/.communicator.json`), per-model defaults, and standalone config commands |
| [`docs/platforms.md`](docs/platforms.md) | Platform support, clipboard tools, terminals, data locations, per-OS install notes, and uninstalling |
| [`docs/development.md`](docs/development.md) | Internal architecture, the module layout, and the provider contract for contributors |

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
