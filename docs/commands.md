# Commands

Complete reference for the `communicator` CLI: the flag table, usage examples, and the in-chat slash commands. See the [README](../README.md#documentation) for the full docs index.

## CLI flags

| Short | Flag                  | Args     | Description                                                                          |
|-------|-----------------------|----------|--------------------------------------------------------------------------------------|
| `-m`  | `--model`             | `<id>`   | Skip all pickers and use this model ID directly (non-interactive)                    |
| `-p`  | `--provider`          | `<name>` | Select the API backend: `openrouter` (default) or `venice`                           |
|       | `--reasoning-effort`  | `<level>`| Force reasoning effort: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`. `none` disables reasoning. With `--model` alone, saves the per-model default |
|       | `--temperature`       | `<0-2>`  | Temperature override for the session (default: per-model preference, then 0.7). With `--model` alone, saves the per-model default |
|       | `--budget`            | `<usd>`  | Per-session budget cap in USD. Warns at 80% used, refuses turns at 100%. Bare use saves the default |
|       | `--web-search`        | `[mode]` | Web search mode: `auto`, `always`, `on`, `off` (`on` = `auto`; bare flag = `auto`). Per-model default is persisted in preferences |
|       | `--web-results`       | `<n>`    | Number of web search results, 1–100 (OpenRouter only, default 10). Implies `auto` mode. Bare use saves the default |
|       | `--zdr`               | —        | Force zero-data-retention routing (OpenRouter only). Filters model/provider selection to ZDR-capable endpoints; errors at selection if a model has none |
|       | `--attach`            | `<path>` | Attach a file to the one-shot message (repeatable: images, pdf, xlsx/docx/pptx, txt, md, code, ...). Requires a prompt argument or piped stdin |
|       | `--no-smooth-streaming` | —      | Disable smooth streaming (default: on in interactive sessions). Bare use saves the default |
|       | `--smooth-speed`      | `<level\|cps>` | Smooth streaming speed: `slow`, `normal`, `fast`, or chars per second (default: `normal` ≈ 2000). Bare use saves the default |
| `-V`  | `--version`           | —        | Print the version and exit                                                           |
| `-h`  | `--help`              | —        | Show the help menu and exit                                                          |
|       | `--list-models`       | —        | List all available models (name, ID, context length) and exit                        |
|       | `--list-endpoints`    | `[model]`| List providers for a model (pricing, uptime, ZDR support, privacy policy link). No arg = picker, partial ID = fuzzy match |
|       | `--list-sessions`     | —        | List saved sessions (timestamp, model, message count, title) and exit                |
| `-r`  | `--resume`            | `[id]`   | Resume a saved session. No arg = picker, partial ID = prefix match                   |
| `-x`  | `--export`            | `[id]`   | Export saved session(s) to markdown. No arg = multi-select checkbox; partial ID = prefix match, unique prefix exports directly |
|       | `--delete`            | `[id]`   | Delete saved session(s) (asks for confirmation). No arg = multi-select checkbox; partial ID = prefix match, unique prefix deletes directly |
|       | `--delete-all-sessions` | `[y/N]` | Delete ALL saved sessions. Pass `y` (or `yes`) to confirm; bare flag or anything else does nothing. Asks "Are you sure?" again on a terminal |
|       | `--output-dir`        | `<path>` | Set export directory for markdown files (saved in preferences). Bare use saves it as the default (requires a TTY and no prompt). With `--image`, generated images are also copied there |
|       | `--config`            | `[path]` | Custom path for the preferences JSON file (default: `~/.communicator.json`). Bare flag prints the current config |
|       | `--system-prompt`     | `<path>` | Custom path for the system prompt file (default: `~/.communicator-system-prompt.md`) |
|       | `--image`             | —        | Generate an image with an image model and exit (both providers). See [docs/images.md](images.md) |
|       | `--image-model`       | `<id>`   | Image model ID, skipping the interactive image model picker (required when piping input) |
|       | `--image-format`      | `<fmt>`  | Image output format: `png`, `jpeg`, `webp` (default `webp` on Venice, `png` on OpenRouter; only sent when the model supports it). Bare use saves the per-provider default |
|       | `--variants`          | `<n>`    | Number of images to generate, 1–4 (default 1) |
|       | `--aspect-ratio`      | `<x:y>`  | Image aspect ratio, model-dependent (e.g. `16:9`, `auto`; decimal ratios like `9:19.5` accepted). Bare use saves the per-provider default. Conflicts with `--width`/`--height` |
|       | `--resolution`        | `<tier>` | Image resolution tier, model-dependent: `1K`, `2K`, `4K`. Conflicts with `--width`/`--height` |
|       | `--quality`           | `<level>`| Image quality tier, model-dependent: `low`, `medium`, `high` |
|       | `--seed`              | `<int>`  | Random seed for image generation (between -999999999 and 999999999) |
|       | `--width`             | `<px>`   | Image width in pixels, 1–1280, multiples of the model's divisor (pixel-based models). Must be given with `--height` |
|       | `--height`            | `<px>`   | Image height in pixels, 1–1280, multiples of the model's divisor (pixel-based models). Must be given with `--width` |
|       | `--no-safe-mode`      | —        | Disable safe mode for image generation (adult content returned unblurred). Bare use saves the default (global setting) and opens a chat session |
|       | `--no-watermark`      | —        | Hide the Venice watermark on generated images. Bare use saves the default (global setting) |
|       | `--list-image-models` | —        | List image models (name, id, per-image price, sizing options) and exit |

## Usage examples

```bash
# OpenRouter (default)
communicator                                            # full interactive flow
communicator -m "openai/gpt-4o" "Hello there"           # one-shot chat with a fixed model
communicator --list-models                                       # list OpenRouter models
communicator --list-endpoints "anthropic/claude-sonnet-4-20250514"  # list endpoints for a model
communicator --list-endpoints "inkling-small"                       # fuzzy match: unique partial IDs work
communicator --list-endpoints                                       # no arg: interactive model picker

# Venice.ai
communicator -p venice                                  # Venice interactive flow
communicator -p venice -m "qwen-3-7-max" "Hello"        # one-shot chat with a fixed model
communicator -p venice --list-models                             # list Venice models (no API key needed)
communicator -p venice --list-endpoints "qwen-3-7-max"           # show Venice endpoint info

# Image generation (both providers)
communicator -p venice --image "a red cat"                        # interactive image model picker
communicator -p openrouter --image "a red cat"                    # OpenRouter image models
communicator -p venice --image --image-model flux-1-1 "a red cat" # fixed image model, no picker
communicator -p openrouter --image --image-model "openai/gpt-image-1-mini" --aspect-ratio 16:9 "a red cat"
communicator -p venice --image --variants 2 --image-format png --seed 42 "cyberpunk city"
communicator -p venice --image --image-model gpt-image-2 --resolution 2K --quality high "wide shot"
communicator -p venice --image --image-model z-image-turbo --aspect-ratio 2:3 "portrait"   # pixel-based model: ratio is computed to pixels
communicator -p venice --image --output-dir ~/Pictures "a red cat"   # also copy the images there
communicator -p venice --list-image-models                           # list image models (no API key needed)
communicator -p openrouter --list-image-models                       # includes per-model pricing
communicator -p venice -m venice-sd35 "a red cat"                    # one-shot image generation via -m
communicator -p venice --aspect-ratio 16:9 --image-format png        # save per-provider image defaults
communicator -p venice --resume <image-session-id>                   # re-enter an image session

# Image sessions (interactive): pick an image model from the unified picker (tagged [image]);
# every prompt generates an image; /help, /exit and /quit control the session.

# One-shot mode (non-interactive, no chat loop)
communicator -m "openai/gpt-4o" "What is the capital of France?"     # positional prompt
echo "Summarize this: ..." | communicator -m "openai/gpt-4o"          # piped stdin
communicator -m "openai/gpt-4o" --temperature 0.2 "Write a haiku"     # with temperature
cat notes.md | communicator -m "openai/gpt-4o" --budget 0.5 "Fix typos:" # with budget cap
communicator -m "openai/gpt-4o" --attach screenshot.png "What is the bug?"   # vision model + image
communicator -p venice -m "qwen-3-7-max" --attach data.xlsx "Summarize this" # Venice office file

# Session management
communicator --list-sessions                                   # list saved sessions
communicator --resume                                   # resume a saved session
communicator --export                                   # pick one or more sessions to export to cwd (multi-select)
communicator --export --output-dir ~/Documents          # export to custom directory
communicator --delete                                   # pick one or more sessions to delete (with confirmation)
communicator --delete 2026-07-30T19-11-45               # delete a specific session
communicator --delete-all-sessions y                    # delete ALL saved sessions (asks "Are you sure?" on a terminal)

# Reasoning (one-shot session, or use -m alone to save the default)
communicator -m "deepseek/deepseek-v4-flash" --reasoning-effort high "Solve this"   # force high reasoning effort
communicator -m "deepseek/deepseek-v4-flash" --reasoning-effort none                # disable reasoning
communicator -p venice -m "deepseek-v4-flash" --reasoning-effort high "Solve this"  # Venice with reasoning

# Web search (one-shot session; standalone use saves the default)
communicator -m "openai/gpt-4o" --web-search auto "Latest AI news"      # auto mode: the model decides when to search
communicator -m "openai/gpt-4o" --web-search always "Latest AI news"    # force a web search on every request
communicator -m "openai/gpt-4o" --web-search off "Latest AI news"       # disable web search
communicator -m "openai/gpt-4o" --web-results 5 "Latest AI news"        # 5 results, implies auto mode
communicator -p venice -m "qwen-3-7-max" --web-search "Latest AI news"  # Venice: no result count; always maps to on

# Standalone config commands (persist defaults to ~/.communicator.json and exit)
communicator --output-dir ~/Documents                                  # save the default export directory
communicator --config                                                  # print the current config
communicator -m "deepseek/deepseek-v4-flash"                           # validate a model, show its details, set it as default
communicator -m "deepseek/deepseek-v4-flash" --temperature 0.5         # set per-model temperature default
communicator -m "deepseek/deepseek-v4-flash" --reasoning-effort high   # set per-model reasoning default
communicator -m "deepseek/deepseek-v4-flash" --web-search always       # set per-model web search default
communicator --budget 2                                                # set the default budget cap for sessions
communicator --web-results 5                                           # set the default result count (OpenRouter only)
communicator --smooth-speed fast                                       # set the default smooth streaming speed
communicator --no-smooth-streaming                                     # disable smooth streaming by default
communicator --no-watermark                                            # hide the Venice watermark on generated images by default
```

## Slash commands

| Input          | Action                                                                              |
|----------------|-------------------------------------------------------------------------------------|
| `/quit`        | Save the session and exit the chat                                                  |
| `/new`         | Save the current session and start a fresh one (same model and reasoning effort)    |
| `/model`       | Save, then switch models mid-chat — re-picks reasoning effort and endpoint          |
| `/reasoning`   | Re-run the reasoning effort picker for the current model                            |
| `/temp`        | Set the session temperature (`/temp 0.4`), or show the current value with no args    |
| `/budget`      | Show used/remaining budget, or set one with `/budget <usd>`                          |
| `/web-search`  | Set the web search mode (`/web-search auto|always|off`; `on` = `auto`), show the current mode with no args |
| `/web-results` | Set the web search result count (`/web-results <n>`, OpenRouter only), show it with no args |
| `/attach`      | Queue files for the next message (`/attach <path>...`). No args = same as `/attachments` |
| `/attachments` | List the queued attachments, or clear them with `/attachments clear` |
| `/retry`       | Re-run the last user turn (regenerates the last answer)                             |
| `/copy`        | Copy the last assistant response to the clipboard                                   |
| `/markdown`    | Toggle terminal markdown rendering (default on)                                     |
| `/smooth`      | Show smooth streaming state and speed, or set them with `/smooth on|off|<level>|<cps>` (a speed value implies on) |
| `/cost`        | Print the running session cost/token totals and current reasoning effort            |
| `/image`       | Generate an image (`/image [--ratio <x:y>] [--format <png|jpeg|webp>] <description>`; leading flags are stripped from the message; without them compact pickers appear with the saved default preselected) |
| `/watermark`   | Show whether the Venice watermark is on/off, or set it with `/watermark on|off` (`off` hides it; persisted as a global setting; Venice sessions only) |
| `Cmd+C` / `Ctrl+C` | During streaming: abort, save the partial response, and exit. At the prompt: cancel and exit |

Unknown slash commands (anything starting with `/`) print a hint listing the available commands instead of being sent to the model.

Image sessions additionally accept `/model` (opens the unified picker: another image model switches the session in place, a text model continues the session as a chat with the same history), `/aspect <x:y>` and `/format <fmt>` (bare shows the model's supported values with the current one marked, e.g. `Aspect ratios: 1:1 [16:9] 3:2.`; `clear` unsets it) to set the aspect ratio and output format for the rest of the session — see [docs/images.md](images.md).

While typing at the prompt, a live list of matching commands appears below the input as soon as the line starts with `/` (single line, cursor at line end, not yet an exact match). **Tab** fills the first match, **Shift+Tab** fills the last one, and **Enter always submits**. The list hides once the line is an exact match — keep typing to refine, or backspace the `/` to dismiss it. Parameterized commands like `/temp 0.7` are typed manually after completion.
