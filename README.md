# Communicator

A terminal-first AI chat client for **OpenRouter** and **Venice.ai** — stream responses with visible reasoning, pick models and providers interactively, track live usage and cost with per-session budget caps, search the web with clickable sources, and resume or export any conversation as markdown.

## Features

- **Multi-provider** — OpenRouter and Venice.ai backends, switchable via `--provider`; the provider abstraction layer makes adding new backends straightforward
- **Interactive model picker** — searchable and filterable by name or model ID, with context-length display
- **Provider selection** — compare pricing, uptime %, and routing tags before starting a chat. Single-provider models skip this step automatically, and Venice models go straight to chat
- **Reasoning effort control** — per-model effort level persisted across sessions. OpenRouter uses its native reasoning format; Venice uses the standard OpenAI `reasoning_effort`
- **Temperature control** — `--temperature <0-2|default>` flag, `/temp` command (with `default` to reset), per-model default persisted in preferences (omitted unless set, so the provider default applies)
- **Top-p control** — `--top-p <0-1|default>` flag, `/top-p` command (with `default` to reset), per-model default persisted in preferences (omitted unless set, so the provider default applies)
- **Web search** — three modes per model (`off`, `auto` = model decides, `always` = force a search) via `--web-search`/`/web-search`, with a result-count knob on OpenRouter. See [docs/web-search.md](docs/web-search.md)
- **Web scraping** — scrape a public page into the conversation as markdown context with `--scrape <url>` (one-shot + prompt, or bare to open a chat with the page) and `/scrape <url>` mid-chat; flat $0.01 per page, tracked in the session cost. Venice only. See [docs/web-scrape.md](docs/web-scrape.md)
- **File & image attachments** — attach images, PDFs, office files, and text/code files with `/attach <path>...` (interactive) or `--attach <path>` (one-shot). See [docs/attachments.md](docs/attachments.md)
- **Model-produced images & files** — artifacts from image-output models are downloaded into the session, saved with the conversation, replayed on `--resume`, and exported as files under the session's `attachments/` folder with `--export`
- **Image generation** — generate images on **both providers** with `--image`, or by picking an image model in the unified picker; per-provider sizing defaults, Venice watermark and safe mode controls included. See [docs/images.md](docs/images.md)
- **One-shot mode** — pass a prompt argument or pipe stdin for a single non-interactive answer. TTY-aware output: styled with a usage footer on a terminal, plain answer text only when piped
- **RPG mode** — `--rpg <dir>` assembles `char.md`, `user.md`, `prompt.md`, and `scenario.md` into one fixed roleplay system prompt and seeds `first-message.md` as the opening assistant turn; missing files are created as fill-in templates. Continue a story with `--rpg <dir> --resume`; add `--debug` to log every request to `prompt-log.jsonl` in the directory. See [docs/chat.md](docs/chat.md)
- **Per-session budget caps** — `--budget <usd>` or `/budget <usd>` limits accumulated session cost; warns at 80% used and refuses turns at 100%
- **Zero data retention** — `--zdr` (OpenRouter only) forces every request through zero-data-retention routing: no caching, no logging, no training. Picker selection filters to ZDR-capable entries
- **End-to-end encryption** — `--e2ee` (Venice only) runs the session against E2EE-capable models: prompts are encrypted client-side with ECDH + AES-256-GCM before leaving your machine, and only the attested TEE enclave can decrypt them. Web search, attachments, and prompt caching are disabled; model selection and `/model` switch only to E2EE-capable models, and unencrypted sessions cannot be resumed. See [docs/providers.md#end-to-end-encryption-e2ee](docs/providers.md#end-to-end-encryption-e2ee)
- **Terminal markdown rendering** — responses styled in the terminal (headers, bold/italic, code blocks, lists, quotes, links) with a `/markdown` toggle
- **Streaming responses** — tokens appear as they arrive, with reasoning shown in gray under a `❯ Thinking` banner
- **Stop with `Esc`** — press `Esc` while a response is streaming to abort the provider fetch and keep what has already streamed as the turn result, returning straight to the prompt (the app does not exit). `Ctrl+C` keeps its existing behavior: save the partial and exit
- **Smooth streaming** — interactive output is paced for a steady render rate (default on; disable with `--no-smooth-streaming` or `/smooth off`)
- **Compact thinking** — replace the streamed reasoning text with a live `Thinking` meter (spinner + character count + elapsed seconds) on TTY; toggle anytime with `/compact-thinking` or persist with `--compact-thinking`. The reasoning stays in the session file and exports
- **Usage & cost tracking** — per-turn and cumulative token counts, a context-window (CTX) indicator, cache-hit detection, and dollar-cost breakdowns; check anytime with `/cost`
- **Slash commands** — `/new`, `/model`, `/reasoning`, `/temp`, `/top-p`, `/budget`, `/web-search`, `/attach`, `/retry`, `/edit`, `/delete`, `/copy`, `/markdown`, `/smooth`, `/compact-thinking`, `/cost`, `/quit`, and more (image sessions add sizing commands plus Venice-only `/watermark`). See [docs/commands.md#slash-commands](docs/commands.md#slash-commands)
- **Session auto-save** — every chat is saved as a JSON file in `~/.communicator/sessions/` with an auto-generated title, on quit, model switch, new session, or `Ctrl+C` — the last exchange is never lost
- **Session resume** — restore any past conversation with `--resume`, keeping the same model, provider, reasoning effort, temperature, top-p, and budget
- **Session deletion** — remove one or more saved sessions with `--delete` (multi-select checkbox with confirmation), or wipe everything with `--delete-all-sessions y` (default no)
- **Markdown export** — export one or more saved sessions with `--export` (multi-select checkbox) into per-session folders (`session-{id}/`), with separate thinking sections, cost summary, and attachments materialized as linked files
- **Session persistence** — last model, provider, and per-model reasoning effort, temperature and top-p are saved to `~/.communicator.json` and restored on next launch
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
git clone <your-fork-or-original-repo-url> ~/Communicator
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
