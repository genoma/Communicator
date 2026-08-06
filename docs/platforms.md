# Platform Compatibility

Supported platforms, terminals, data locations, per-OS install notes, and uninstalling. See the [README](../README.md#documentation) for the full docs index.

Communicator is written in pure Node.js ESM with no native dependencies, so the same codebase runs on macOS, Linux, and Windows. It is developed and tested on macOS; Linux and Windows are verified by the CI matrix (GitHub Actions runs `npm test` and `npm run lint` on all three OSes).

| Platform | Status | Notes |
|----------|--------|-------|
| macOS    | Primary — developed and tested locally and in CI | Clipboard via built-in `pbcopy` |
| Linux    | Expected to work, CI-verified | Clipboard tools probed at runtime: `wl-copy` (Wayland) → `xclip` → `xsel` (X11) |
| Windows  | Expected to work, CI-verified | Clipboard via built-in `clip`; multi-line input normalizes CRLF |

## Requirements

- **Node.js >= 22.3** on all platforms
- No native dependencies — pure ESM

## Clipboard tools

| OS      | Tools probed (in order)          | Notes |
|---------|----------------------------------|-------|
| macOS   | `pbcopy`                         | Built-in |
| Windows | `clip`                           | Built-in |
| Linux   | `wl-copy` → `xclip` → `xsel`     | First one found wins; install any single one (`wl-clipboard` on Wayland, `xclip`/`xsel` on X11) |

When none is available, `/copy` reports `Copy failed: No clipboard tool found. Install wl-copy, xclip, or xsel.`

## Terminals

The full experience requires a modern terminal emulator:

- **ANSI colors and styling** — all modern terminals
- **OSC 8 clickable links** (web sources, inline citations) — iTerm2, Terminal.app, Warp, WezTerm, kitty, GNOME Terminal, Windows Terminal, and most others
- **Braille spinner, markdown tables, smooth streaming** — degrade gracefully elsewhere

Terminals without ANSI support get plain-text fallbacks: OSC 8 escapes are stripped automatically and streaming text is written as-is. On Windows, use **Windows Terminal** (or another modern emulator) — legacy `conhost`/`cmd` renders plain text without styling, colors, or clickable links.

## Data locations

All persistent data is resolved from `os.homedir()` at runtime, so the paths are identical across OSes:

| Path | Contents |
|------|----------|
| `~/.communicator/sessions/` | Session files + `.index.json` metadata |
| `~/.communicator/sessions/attachments/<sessionId>/` | Binary attachment blobs (images, PDFs, office files), referenced via `ref://attachments/` in session JSON |
| `~/.communicator.json` | Preferences |
| `~/.communicator-system-prompt.md` | Optional custom system prompt |

## Install & environment on Linux/Windows

`npm link` places the `communicator` binary on your PATH. The exact location depends on your Node.js setup:

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

The `~/.zshrc` / `~/.bashrc` examples in the Setup section are Unix-specific; on Windows use PowerShell `$PROFILE` instead.

## Uninstall

```bash
npm unlink -g communicator
rm ~/.communicator.json
rm -rf ~/.communicator
```

If you used a custom config path with `--config`, delete that file instead.
