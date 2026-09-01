# Session Persistence & Resume

Session persistence: listing, resuming, deleting, exporting, and the on-disk session file format. See the [README](../README.md#documentation) for the full docs index.

Every chat session is automatically saved to `~/.communicator/sessions/<timestamp>.json`,
with a `title` auto-generated from the first user message (whitespace collapsed;
when longer than 50 chars the title is the first 50 chars plus `...`). Sessions are saved when you quit (`/quit` or `Ctrl+C`),
when you switch models or start a new session, and on interrupt during streaming
(including the partial response). A metadata index at
`~/.communicator/sessions/.index.json` powers `--list-sessions` and the
resume/export/delete pickers so listing never has to parse full session files.
If the index is missing or stale (e.g. from an older version), it is rebuilt
automatically from the session files.

## Listing sessions

```bash
communicator --list-sessions
```

Output shows each session's ID, last-activity timestamp, model, message count, and the session title. Sessions are listed most-recently-used first: the timestamp is `updatedAt`, bumped when new content is saved (a new message or an image generation) — merely resuming an old conversation does not bump it, so it keeps its place until you actually use it again. Legacy sessions without `updatedAt` fall back to `createdAt`, then to the creation-time id:

```
3 saved session(s):

  ID: 2026-07-30T19-15-22
     2026-08-02 14:31:08  openai/gpt-4o                        12 msgs       "Write a Python script that..."
  ID: 2026-07-30T18-42-10
     2026-07-30 18:42:10  deepseek-v4-flash                     5 msgs       "Explain how garbage collection..."
  ID: 2026-07-30T17-11-45
     2026-07-30 17:11:45  google/gemini-2.5-pro                 23 msgs       "Compare Rust and Go for..."
```

## Resuming a session

```bash
# Interactive picker — browse and select from all saved sessions
communicator --resume

# Prefix match — resumes if exactly one session starts with "2026-07-30"
communicator --resume 2026-07-30

# Full session ID — resumes the exact session
communicator --resume 2026-07-30T19-11-45
```

When resuming, the original model, provider backend (OpenRouter or Venice),
endpoint provider, reasoning effort, temperature, top-p, budget, and web search state
(mode + result count) are restored automatically. The conversation picks up
right where you left off — all previous messages are preserved. Session flags
override the stored values on resume (`--temperature`, `--top-p`, `--budget`,
`--web-search`, `--web-results`, `--reasoning-effort`), while `-p` is silently
ignored and `-m`, `--output-dir`, `--attach`, and `--scrape` are rejected with
an error. An ambiguous prefix (matching more than one session) opens an
interactive picker.

Older sessions saved without a `providerType` field default to OpenRouter for
backward compatibility.

## Deleting sessions

```bash
# Multi-select checkbox — pick one or more sessions to delete
communicator --delete

# Prefix match — deletes if exactly one session starts with "2026-07-30"
communicator --delete 2026-07-30

# Full session ID — deletes the exact session
communicator --delete 2026-07-30T19-11-45
```

`--delete` always asks for confirmation before removing the session file (and
its sidecar entry, plus any attachment blobs under
`~/.communicator/sessions/attachments/<sessionId>/`). Selecting multiple
sessions shows a single `Delete N sessions?` confirmation and removes them all;
selecting none prints `Deletion cancelled.` and exits without changes. It
cannot be combined with `--resume`, `--export`, or a prompt argument, and needs
a TTY for the confirmation prompt. Removal is best-effort per session: an entry
that cannot be removed (a locked file, a stray directory named like a session)
is skipped and reported, the rest are deleted, and the command exits 1 naming
what it could not remove.

To wipe **all** saved sessions at once:

```bash
communicator --delete-all-sessions       # asks "Are you sure?" on a terminal
communicator --delete-all-sessions y     # confirm non-interactively (piped stdin)
```

`--delete-all-sessions` is one-shot: the bare flag asks "Are you sure?" on a
terminal and deletes nothing until you confirm; `y` or `yes` (case-insensitive)
confirms, which is also the way to approve with piped stdin (where the prompt
cannot run). Any other value — `n`, `no`, anything else — deletes nothing. On a
terminal it asks "Are you sure?" before wiping even after `y`; `y` with piped
stdin is sufficient. It removes every session file (even corrupt ones), save-conflict backups (see below), the `.index.json` sidecar, and the whole `attachments/` directory. Removal is best-effort: an entry that cannot be removed (e.g. a locked file or a stray directory named like a session) is skipped with a warning and the sweep continues, then the command exits 1 after reporting what it could not delete.

### Save conflict backups

If another CLI instance writes the same session id while one is running (the same session resumed in two terminals), the second save preserves the version it would otherwise overwrite as `<id>.json.conflict-<timestamp>` next to the session file and prints a warning; the backup is invisible to listings (it does not end in `.json`) but contains the full transcript, so `--delete <id>` and `--delete-all-sessions` remove it along with the session. Deleting the backup manually (same directory, `rm` it) is equally fine.

## Exporting sessions

Export any saved session as a clean, readable markdown file (or JSONL for
machine-readable interchange):

```bash
# Multi-select checkbox — pick one or more sessions to export
communicator --export

# Prefix match — exports if exactly one session starts with "2026-07-30"
communicator --export 2026-07-30

# Full session ID — exports the exact session
communicator --export 2026-07-30T19-11-45

# Export to a custom directory (persisted in preferences)
communicator --export --output-dir ~/Documents/CommunicatorExports

# Export as JSONL (one JSON object per line: session header + messages)
communicator --export --export-format jsonl
```

Selecting multiple sessions exports each one into its own folder, printing one
`Exported to ...` line per session; selecting none prints `Export cancelled.`
and exits without changes. Export is best-effort per session: a session whose
file is corrupt or missing is skipped (the others still export) and the
command exits 1 naming the sessions it could not export.

Each session is exported into its own folder: `session-{id}/` in the current
working directory by default, containing the conversation as `session-{id}.md`
(or `session-{id}.jsonl` with `--export-format jsonl`). Use `--output-dir` to
set a custom base directory — once set, it's saved in your preferences and
used for all future exports until you override it again.

- **Header** — timestamp, title, model, provider, message count, reasoning effort, and accumulated cost
- **User messages** — blockquoted under a `## You` heading
- **Assistant responses** — reasoning shown under `### thinking`, final answer under `### Answer`
- **Attachments** — user-attached images/pdf/office files and assistant-produced artifacts are materialized as real files in `session-{id}/attachments/` and referenced from the markdown by portable relative links (`> **Attachment:**` lines whose `attachments/image.png`-style target resolves to the written file). Filenames are sanitized and deduplicated within the session. Remote artifact URLs (a generation-time download failure) and text-file attachments stay as they are — clickable links / inline text
- **Sources** — when web search was used, a `**Sources:**` markdown list follows each answer, with inline `^n^` citations converted to `[n](url)` links
- **Cost** — from the persisted per-session cost summary (the flat scrape fee included); legacy sessions without a summary fall back to replaying per-message usage, and "N/A" shows when pricing is unavailable

Example output:

```markdown
# Chat Session — 2026-07-30 19:11:45 UTC
**Title:** What is the capital of France?
**Model:** `openai/gpt-4o` | **Provider:** OpenAI | **Messages:** 4 | **Cost:** $0.000124

---

## You
> What is the capital of France?

---

## Assistant
### thinking
The user is asking a straightforward geography question...

### Answer
The capital of France is Paris.
```

## Session file format

Each session is stored as a JSON file:

```json
{
  "model": "openai/gpt-4o",
  "providerName": "OpenAI",
  "providerType": "openrouter",
  "reasoningEffort": "high",
  "temperature": 0.7,
  "topP": 0.8,
  "budget": 0.5,
  "webSearch": "auto",
  "webResults": 5,
  "scrapes": 0,
  "title": "What is the capital of France?",
  "pricing": {
    "prompt": 0.0000025,
    "completion": 0.00001
  },
  "contextLength": 128000,
  "createdAt": "2026-07-30T19:11:45.000Z",
  "updatedAt": "2026-07-30T19:15:22.000Z",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi there!", "reasoning": "...", "usage": { "prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17 }, "sources": [{ "title": "Example", "url": "https://example.com" }] }
  ]
}
```

- `providerName` is the endpoint provider (e.g., `"OpenAI"` for OpenRouter, `"venice"` for Venice)
- `providerType` is the API backend (`"openrouter"` or `"venice"`). Older sessions without this field default to `"openrouter"` on resume
- `reasoningEffort` is `"auto"` when the model reasons without effort control, `null` when reasoning is explicitly disabled, and a level string (`"low"`, `"medium"`, ...) otherwise. Older sessions without the field or with `null` restore as disabled
- `reasoningMandatory` is `true` when the model's reasoning cannot be disabled (e.g. DeepSeek R1) — `false` for legacy sessions; used to avoid sending a disable the provider rejects
- `temperature` is the resolved session temperature (0–2); `topP` is the resolved session top-p (0–1) — both present only when explicitly set; when unset the parameters are omitted from the request and the provider applies its own default; `budget` is the per-session cap in USD (`null` when unset)
- `pricing` is the endpoint's per-token USD rates (`null` when unknown); `contextLength` is the endpoint's advertised context window (`null` when undisclosed, e.g. some Venice models) — used by the CTX indicator on resume
- `webSearch` is the web search mode (`"off"`, `"auto"`, or `"always"`); `webResults` is the OpenRouter result count (`null` when unset — the provider default of 10 applies) — both restored on resume
- `scrapes` is the number of Venice web-scraped pages in the session (`0` when none); the flat $0.01 per page is added to the resumed session cost. The scraped page itself is a normal user message and persists like any other message
- `title` is auto-generated from the first user message
- User messages with attachments store `content` as an OpenAI-style parts array (`[{ type: 'text', ... }, { type: 'image_url', ... }, { type: 'file', ... }]`); plain text messages keep the string form, so older sessions stay readable
- Binary attachment payloads (`image_url.url` / `file.file_data`) are not stored inline: the data URL is replaced by a `ref://attachments/<sha256>.<ext>` sentinel pointing at a blob in `~/.communicator/sessions/attachments/<sessionId>/` (raw bytes, deduplicated by sha256 within the session). On `--resume`/`--export` the blob is read back and re-encoded into the `data:<mime>;base64,...` URL. Text-file attachments stay inline as `text` parts. Old sessions with inline data URLs load unchanged and convert to refs on the next save; a missing blob drops that part with a warning
- `pricing` stores per-token dollar amounts used for cost calculation
- Assistant messages may carry `sources` (`[{ title, url }]`) when web search was used — restored on `--resume` (numbered list + clickable inline citations) and exported as a markdown `**Sources:**` list with `^n^` citations converted to `[n](url)` links; older sessions without the field render no sources and keep citations literal
- `updatedAt` is bumped when new content is saved (a new message or an image generation), and kept as-is on resumes that add nothing — `--resume` alone never reorders the listing
- Empty sessions (no user messages) are never saved
- Older sessions without `temperature`/`topP`/`budget`/`title` restore unset / unset / no cap / no title
