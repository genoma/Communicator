# File & Image Attachments

Supported formats, interactive and one-shot usage, gating, and limits. See the [README](../README.md#documentation) for the full docs index.

Attach local files to a message so the model can see or read them. Queued files are sent with the next message, and the original message text goes along unchanged. Attachments persist in the session file (as OpenAI-style content parts), so `--resume` replays them and re-sending works.

Supported formats:

| Kind     | Extensions                                              | How it is sent                                        |
|----------|---------------------------------------------------------|-------------------------------------------------------|
| Image    | `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`              | base64 `image_url` part — requires a vision model      |
| PDF      | `pdf`                                                   | base64 `file` part (server-side parsing; only on models that support file input) |
| Office   | `xlsx`, `xls`, `docx`, `pptx`                           | base64 `file` part — **Venice only** (server-side extraction) |
| Text     | `txt`, `md`, `markdown`, `csv`, `json`, `yaml`, `yml`, `toml`, `xml`, `log`, `py`, `js`, `mjs`, `cjs`, `ts`, `tsx`, `jsx`, `css`, `html`, `sh`, `sql`, `go`, `rs`, `java`, `c`, `cpp`, `h`, `hpp`, `ini` | inlined as a `text` part (no base64 bloat) |

Anything else is rejected with `Unsupported file type: <ext>`.

- **Interactive** — `/attach <path>...` queues one or more files (relative paths resolve from the current directory). Each file prints `attached: <name> (<kind>, <size>)` or an error line, and one failing file does not abort the rest. Paths with spaces can be backslash-escaped (`/attach Screenshot\ 2026-07-23.png`).
  - `/attach` with no arguments lists the queue, `/attachments` lists it too, and `/attachments clear` empties it. Queued files are sent with the very next message you type and the queue resets; `/new` also clears the queue.
  - Words without a file extension or path separator are treated as prose and ignored with a hint.
  - Type your message on the next line, not after the paths — a multi-line submission uses the first line as the command and sends the remaining lines as your message.
- **One-shot** — `--attach <path>` is repeatable and requires a prompt argument or piped stdin (`communicator --attach report.pdf "Summarize"`). It cannot be combined with `--resume`, `--export`, `--delete`, `--list-*`, or bare `--config`.
- **Vision gating** — image attachments are blocked at attach time when the selected model is known to lack vision (`The selected model does not support image input.`). Unknown capability allows the attachment — API errors surface naturally. On models known to lack vision, `/attach` and `/attachments` are hidden from the interactive hint, autocomplete, and the unknown-command list, though typing them manually still works (text/PDF attach stays available) and `/model` to a vision model re-shows them. Text files work on any model; PDFs (and office files on Venice) need a model that supports file input — on OpenRouter the model's `supported_parameters` must include `file` (models without a parameter list stay assumed-capable), and the gate rejects with `The selected model does not support file attachments.` otherwise. Office files are rejected on OpenRouter with a clear message (`xlsx/docx/pptx are only supported on Venice...`) and accepted on Venice.ai, which extracts them server-side.
- **Switching models** — `/model` re-checks the queue against the new model and drops entries it can't accept, with a warning line per dropped file.
- **Limits** — images over 20 MB and pdf/office files over 25 MB (the Venice cap) are rejected based on the base64-encoded size; text files over 25 MB are rejected too. Inline text over 256 KB is still accepted but warns about context usage.
- **Display & export** — resumed sessions render `attached: <filename> (<kind>)` lines under user messages and `image: <filename>` / `file: <filename>` lines under assistant messages (images show as `image.<ext>` because only the image URL is persisted; pdf/office/text keep their real filenames); `--export` materializes image/pdf/office attachments as real files under `session-<id>/attachments/` and renders `> **Attachment:** [<filename>](attachments/<filename>)` links; text-file attachments stay inline in the message text; `/copy` copies only the message text, never file contents or base64.
