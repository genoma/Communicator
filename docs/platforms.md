# Platform Compatibility

Supported platforms, terminals, data locations, per-OS install notes, and uninstalling. See the [README](../README.md#documentation) for the full docs index.

Communicator is written in Node.js ESM. Its one native piece is [`sharp`](https://sharp.pixelplumbing.com/), a prebuilt image codec loaded only when you attach an image and never required to run the app, so the same codebase runs on macOS, Linux, and Windows. It is developed and tested on macOS; Linux and Windows are verified by the CI matrix (GitHub Actions runs `npm test` and `npm run lint` on all three OSes).

| Platform | Status | Notes |
|----------|--------|-------|
| macOS    | Primary — developed and tested locally and in CI | Clipboard via built-in `pbcopy`; prompt-editor spelling assistance (system spell checker, optional compiled helper — see Data locations); `heic`/`heif` attachments decoded by the built-in `sips` converter |
| Linux    | Expected to work, CI-verified | Clipboard tools probed at runtime: `wl-copy` (Wayland) → `xclip` → `xsel` (X11); prompt-editor spelling assistance via the built-in English dictionary (`nspell`); `heic`/`heif` attachments rejected |
| Windows  | Expected to work, CI-verified | Clipboard via built-in `clip`; multi-line input normalizes CRLF; prompt-editor spelling assistance via the built-in English dictionary (`nspell`); `heic`/`heif` attachments rejected |

`heic`/`heif` attachments are macOS-only: the system `sips` converter decodes them there (converting the result to `jpeg`/`png` still needs the image codec), while Linux and Windows reject them before reading the file with `Unsupported file type: heic (HEIC/HEIF images are supported on macOS only — convert to JPEG or PNG)` (the `heif` spelling for a `.heif` file).

## Requirements

- **Node.js >= 22.15** on all platforms
- One native piece — [`sharp`](https://sharp.pixelplumbing.com/), a per-platform prebuilt image codec imported only when you attach an image; it is never required to run the app. Without it, png/jpg/jpeg/webp attachments are sent untransformed (and `gif`/`bmp` are always untouched), while the formats that must be converted — `avif`, `tif`/`tiff` and `heic`/`heif` — are rejected with `Cannot read attachment: <path> (image conversion failed)` (on Linux and Windows `heic`/`heif` report the macOS-only message above instead, before the file is read), and `heic`/`heif` are macOS-only regardless (`sips`)

## Clipboard tools

| OS      | Tools probed (in order)          | Notes |
|---------|----------------------------------|-------|
| macOS   | `pbcopy`                         | Built-in |
| Windows | `clip`                           | Built-in |
| Linux   | `wl-copy` → `xclip` → `xsel`     | First one found wins; install any single one (`wl-clipboard` on Wayland, `xclip`/`xsel` on X11) |

When none is available, `/copy` reports `Copy failed: No clipboard tool found. Install wl-copy, xclip, or xsel.`

## Clipboard image paste

`/paste` queues the image currently on the clipboard. Reading is separate from copying and has its own tools: `osascript` on macOS (built-in), Windows PowerShell 5.1 (`Get-Clipboard -Format Image`, built-in — PowerShell 7 cannot read images at all), and `wl-paste` or `xclip` on Linux (from the `wl-clipboard`/`xclip` packages; `xsel` cannot serve images, so on X11 install `xclip`). When no reader is present, or the clipboard holds no image, or the image is over the 20 MB attachment limit, `/paste` says so and queues nothing.

## Terminals

The full experience requires a modern terminal emulator:

- **ANSI colors and styling** — all modern terminals
- **OSC 8 clickable links** (web sources, inline citations) — iTerm2, Warp, WezTerm, kitty, GNOME Terminal, Windows Terminal, and most others; support varies by terminal and version
- **Braille spinner, markdown tables, smooth streaming** — degrade gracefully elsewhere

Terminals without ANSI support get plain-text fallbacks: link labels render as plain text (the app emits OSC 8 escapes for http(s) links, and terminals that do not understand them ignore the escape) and streaming text is written as-is. On Windows, use **Windows Terminal** (or another modern emulator) — legacy `conhost`/`cmd` renders plain text without styling, colors, or clickable links.

## Data locations

All persistent data is resolved from `os.homedir()` at runtime, so the paths are identical across OSes:

| Path | Contents |
|------|----------|
| `~/.communicator/sessions/` | Session files + `.index.json` metadata |
| `~/.communicator/sessions/attachments/<sessionId>/` | Binary attachment blobs (images, PDFs, office files), referenced via `ref://attachments/` in session JSON |
| `~/.communicator.json` | Preferences |
| `~/.communicator-system-prompt.md` | Optional custom system prompt |
| `~/.communicator/history.json` | Prompt input history (max 200 entries) |
| `~/.communicator/spelling-helper-<hash>` | Compiled macOS spelling helper (macOS only; built on first use, never without Command Line Tools) |

On macOS the prompt editor uses the system spell checker; on first use Communicator compiles a small helper into `~/.communicator/spelling-helper-<16-hex>` when Command Line Tools (or Xcode) are present. Without a toolchain nothing is compiled and every request goes through a per-call `osascript` process instead. On Linux and Windows spelling assistance runs on a built-in pure-JS English dictionary (`nspell` + `dictionary-en`, shipped with the app — no system checker, nothing to compile): typo underlines, the Ctrl+. replacement list and autocorrect all work, while dictionary completions (the dim inline hint) are macOS-only.

## Install & environment on Linux/Windows

`npm install -g @vioni/communicator` installs the `communicator` binary (or `npx @vioni/communicator` runs it without installing); a source checkout can use `npm link` instead. The exact location depends on your Node.js setup:

| OS / setup                                   | Symlink path                               |
|----------------------------------------------|--------------------------------------------|
| macOS Apple Silicon + Homebrew Node          | `/opt/homebrew/bin/communicator`           |
| macOS Intel / system Node                    | `/usr/local/bin/communicator`              |
| Linux + nvm                                  | `~/.nvm/versions/node/<version>/bin/communicator` |
| Windows                                      | `%APPDATA%\npm\communicator` (add `%APPDATA%\npm` to `PATH` if needed) |

Set the API keys per platform:

```bash
# macOS / Linux — add to ~/.zshrc or ~/.bashrc
export OPENROUTER_API_KEY="sk-or-v1-your-key-here"
export VENICE_API_KEY="vkey-your-key-here"
```

```powershell
# Windows PowerShell — current session, or persist with setx
$env:OPENROUTER_API_KEY = "sk-or-v1-your-key-here"
$env:VENICE_API_KEY = "vkey-your-key-here"
setx OPENROUTER_API_KEY "sk-or-v1-your-key-here"
setx VENICE_API_KEY "vkey-your-key-here"
```

The `~/.zshrc` / `~/.bashrc` examples in the Quick start section of the README are Unix-specific; on Windows use PowerShell `$PROFILE` instead.

## Uninstall

```bash
npm uninstall -g @vioni/communicator   # or: npm unlink -g communicator, for a source checkout
rm ~/.communicator.json
rm -rf ~/.communicator
```

If you used a custom config path with `--config`, delete that file instead.
