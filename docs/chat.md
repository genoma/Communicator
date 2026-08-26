# Chat

The interactive chat experience: the selection flow, one-shot mode, terminal rendering, smooth streaming, budget caps, and the system prompt. See the [README](../README.md#documentation) for the full docs index.

## Interactive flow

1. **Model selection** — searchable picker with fuzzy filtering by name or ID. Your last-used model appears first. Venice.ai models show names as listed on the Venice dashboard (e.g., `Qwen 3.7 Max`); OpenRouter models include the org prefix (e.g., `Google: Gemini 3.6 Flash`).
2. **Provider selection** (OpenRouter only) — displays pricing, 30-minute uptime %, and routing tags. Navigate back to the model picker to change your selection. Models with a single provider skip this step entirely. Venice models go straight to chat.
3. **Reasoning effort** — shown only when the selected model supports reasoning effort control. A `Disabled` ("none") option is offered whenever the model allows turning reasoning off; models that reason automatically (no effort control) skip this step entirely. The chosen level is saved per model and restored as default next time. Venice uses the standard OpenAI `reasoning_effort` parameter; OpenRouter uses its native `reasoning` object, where `Disabled` sends `effort: "none"` so the model really stops thinking (models where reasoning is mandatory, e.g. DeepSeek R1, never offer `Disabled`).

Passing `-m <id>` skips **all** pickers: the reasoning effort is restored from your saved per-model preference (or the model default), and the OpenRouter endpoint is auto-selected (cheapest provider with pricing, otherwise the first one). Venice always goes straight to chat. `--reasoning-effort` still overrides the effort when given; `--reasoning-effort none` disables reasoning. Models that are disabled by default (`default_enabled: false`) restore as disabled.

## One-shot mode

Pass a prompt as a positional argument, or pipe input via stdin, to get a single answer without entering the chat loop:

```bash
communicator -m "openai/gpt-4o" "What is the capital of France?"
echo "Summarize the README" | communicator -m "openai/gpt-4o"
cat notes.md | communicator -m "openai/gpt-4o" --system-prompt ~/reviewer.md
```

- Without `-m`, the model pickers run first (they need a TTY), then the one-shot answer is sent.
- Piped stdin is read up to a 10MB sanity limit. Piping input without `-m` is an error — pickers can't run without a TTY.
- Output is TTY-aware: on a terminal you get the streaming response with reasoning labels and the usage/cost footer; when stdout is piped you get **only** the plain answer text (no banners, no usage) — ideal for scripting: `communicator -m ... "hi" | jq`.
- The answer is saved as a regular session (title, temperature, top-p, budget, usage) and the model/temperature/top-p preferences are persisted, exactly like an interactive chat.
- Exit codes: `0` success, `1` API/validation error (message on stderr), `130` interrupted with `Ctrl+C`.
- A prompt *argument* cannot be combined with `--resume`, `--export`, `--delete`, or `--list-*` flags (error + exit 1), and `--resume`/`--export`/`--delete` cannot be combined with `--list-*` flags either. Piped stdin has no such conflict: `--list-models`, `--list-sessions`, and `--list-endpoints <model>` work with piped stdin. The interactive pickers (`--resume`/`--export`/`--delete` in any form — even with a full session ID, and bare `--list-endpoints`) need a TTY.

## Chat session

Once connected, responses stream token by token. Reasoning tokens appear in gray with a `❯ Thinking` label. After the final answer, a usage summary is printed automatically:

```
❯ You

What is the capital of France?

❯ Thinking

The user is asking about the capital of France...

❯ Answer

The capital of France is Paris.

───────────────────────────────────────
  Tokens  ↑ 12 prompt  ↓ 28 completion  = 40 total
  Cost    $0.000034 this turn  |  $0.000124 session
───────────────────────────────────────
```

The last footer row holds the **CTX indicator**: the session's peak context usage — the most context a single turn has occupied (`prompt + completion` divided by the endpoint's advertised context length). It never decreases as the conversation grows, even when web search results transiently inflate a turn's prompt.

The row appears only when the context window is known and at least 5% occupied (`CTX    ██████░░░░ 60%`; with a 1M-token model like DeepSeek V4 Flash, ordinary chats rarely show it). The bar turns yellow at 80% and red at 95%. When the budget warning fires (see below), the budget bar joins the same row instead of adding a line.

The `Cache ⚡` line appears only when OpenRouter serves a cached response — on a cache miss it is omitted entirely. The session cost accumulates across turns within the same chat, and Venice pricing is normalized from per-1M-token rates to per-token for a consistent cost display.

## Current settings line

On connect, the banner and `/status` print the **same** snapshot line — model identity, context window, pricing, and every setting badge — so entering a model and checking status can never drift apart. On a TTY the bracket labels (`[thinking:`, `[top-p:`, …) and the `Connected to` / `Current settings:` prefixes are dimmed so the values read as the headline; piped output is plain:

```
Connected to OpenRouter / deepseek/deepseek-chat  [131,072 context]  [in $0.10 / out $0.20/M]  [thinking: High]  [temp: 0.3]  [top-p: 0.8]  [web: auto: 5]  [budget: $2.000000]  [smooth: on (normal, ~2000 chars/s)]
```

- The context and pricing segments appear only when known; the pricing format is `in $X.XX / out $Y.YY/M`.
- Badges `[thinking: …]`, `[zdr]`, `[e2ee]`, `[web: <mode>[: N]]`, `[compact-thinking]` appear only when they deviate from the default; `[temp: …]` and `[top-p: …]` are always shown so the active sampling settings are visible on connect and in `/status` (`[temp: default]` / `[top-p: default]` when unset — the parameter is then omitted from the request and the provider applies its own default); `[budget: …]` only when a cap is set; the smooth-streaming badge is always present.
- On a narrow terminal the snapshot line wraps at the terminal width — badges are atomic (a badge never splits mid-way) and continuation lines align under the model label; piped output stays on one unwrapped line.

The same line is re-printed as `Current settings: …` after every mid-chat config change (`/temp`, `/top-p`, `/reasoning`, `/web-search`, `/web-results`, `/smooth`, `/budget`, `/model`, `/new`) and by `/status` on demand. All values are persisted per model where applicable, so the next session's banner reflects what you last set.

## Markdown rendering

By default, assistant responses are rendered as markdown in the terminal: `#` headers bold, `**bold**` / `*italic*` styled inline, `~~strikethrough~~` struck through, `` `code` `` in cyan, fenced code blocks dimmed, lists and blockquotes styled, aligned tables with a bold header row and dim separator, horizontal rules as a thin separator, and `[text](url)` links shown in italics (URL hidden, clickable in supporting terminals); bare URLs and `<url>` autolinks are clickable too. Reasoning text is never restyled.

Streaming is live: the current in-flight line is written as tokens arrive and redrawn in place as it grows, so even single-paragraph answers stream continuously; when a line completes, it is restyled with its final markup. Tables are held until they close and then rendered fully aligned, so columns never shift mid-row. Toggle with `/markdown` (default on); history replay on `--resume` uses the same styling.

## Smooth streaming & waiting indicator

In interactive (TTY) sessions, streaming is paced by default: tokens are buffered and rendered at a steady character rate (~40 chars per 20 ms tick) instead of being written the instant each SSE event arrives. This smooths out bursts — most notably the first content chunk after a web-search delay — while slow streams still render as fast as they arrive (pacing is a cap, not an artificial delay). When the stream ends, any remaining buffered text keeps rendering at the same paced rate rather than popping in all at once. Piped output is never paced. Disable it with `--no-smooth-streaming` at launch or `/smooth off` mid-chat (`/smooth` shows the current state, `/smooth on` re-enables; the choice is persisted in preferences).

The pace is a global speed setting, persisted in preferences under `smoothSpeed` (shared by every session, like `smoothStreaming`). Set it at launch with `--smooth-speed <level|cps>` (`slow` ≈ 500 chars/s, `normal` ≈ 2000 chars/s, `fast` ≈ 8000 chars/s, or any positive chars-per-second value) or mid-chat with `/smooth slow|normal|fast|<cps>`, which also enables smooth streaming. Speed changes apply live: the very next tick of an in-flight stream uses the new pace. The speed is inert when smooth streaming is off or output is piped.

While the model is working, a dim indicator appears on the response line roughly 200 ms after you send the message — `Waiting for response` with a braille spinner (or `Searching the web` when web search is forced with `always`, since that mode is guaranteed to search). The indicator is erased the moment the first token arrives, and it never shows for instant replies. When the stream ends without reasoning, the indicator line resolves to a green `✓ Waiting for response` checkpoint, which is kept in the transcript and replayed on history re-renders (`--resume`, terminal resizes) just like the compact-thinking checkpoint.

## Compact thinking

By default the model's reasoning streams after the `❯ Thinking` banner, dimmed, until `❯ Answer` starts. With compact thinking the reasoning text is not printed: the response line instead shows a live meter — `Thinking · 1.2k` with a braille spinner — whose count is the number of reasoning characters received so far. When thinking ends the line resolves to a green `✓ Thinking · 1.2k` checkpoint and the answer streams normally. The full reasoning text is still saved with the session and included in `--export` markdown; only the terminal display (and history replay on `--resume`, which replays the checkpoint) hides it.

Enable/disable with `/compact-thinking on|off` mid-chat (`/compact-thinking` shows the current state), persist the default with `--compact-thinking` (bare use saves it, like `--no-smooth-streaming`), and the `compactThinking` preference key. Compact thinking is a TTY display mode: piped output is unaffected. The `[compact-thinking]` badge appears on the banner and `/status` when it is on.

## Budget caps

`--budget <usd>` (or `/budget <usd>` mid-chat) sets a per-session spending cap based on accumulated tracked cost. When 80% is crossed, the last footer row shows the budget bar (`Budget  83% used ($0.0005 of $0.0006), $0.0001 remaining`), joined with the CTX bar on the same row when both are visible. At 100% the next turn is refused with `Budget exhausted ($X of $Y). /new to start fresh or /quit.`. `/budget` with no value prints used/remaining. Budgets are stored in the session file and restored on `--resume`; `/new` clears the budget for the fresh session.

## System Prompt

The system prompt sets the AI's persona and behavior. Customize it by creating a file at `~/.communicator-system-prompt.md` with your system prompt content.

```bash
echo "You are a sarcastic engineer. Always respond with a clever remark." > ~/.communicator-system-prompt.md
```

Override the default path with `--system-prompt`:

```bash
communicator --system-prompt /path/to/custom-prompt.md
```

- If the file is missing or empty, the default `"You are a helpful assistant."` prompt is used silently.
- The file is read once at startup. Changes require restarting the chat.
- Venice always sets `include_venice_system_prompt: false` since the app provides its own system prompt.

## RPG mode

`--rpg <dir>` builds the system prompt from five Markdown files in that directory:

- `char.md` — who the model plays
- `user.md` — who the human plays
- `prompt.md` — tone, world, and rules
- `scenario.md` — the current scene and starting situation
- `first-message.md` — the character's opening message, shown when the chat starts and sent as the first assistant turn
- `post-history-instruction.md` (optional; created empty, never templated) — instructions re-sent after the latest user message on every turn

```bash
communicator --rpg ~/rpg/cyberpunk-campaign
```

On first use the missing files are created as fill-in templates and the command exits so you can edit them. Delete the HTML comment at the top of each story file once it is filled in, then rerun the same command. `post-history-instruction.md` starts empty (an empty file disables the feature), so there is nothing to do there unless you want the extra instructions. In interactive mode, `first-message.md` is rendered immediately after the model/provider selection banner, before the first input prompt. In one-shot mode it is included as the opening assistant message in the request but is not printed to piped stdout.

The files are combined into one fixed system message; the scenario is placed after the character and user sections, just before the per-turn rules. `{{char}}` and `{{user}}` are replaced with the names from the first `# Name` heading in `char.md` and `user.md`; Markdown comments are removed before the prompt is sent. Both `char.md` and `user.md` must keep a real `# <name>` heading as their first H1 — it is the speaker name shown in the transcript (`❯ <name>`) and the value that `{{char}}`/`{{user}}` stands for, and a missing or placeholder heading stops the run with an error telling you the convention. `--rpg` cannot be combined with `--system-prompt` or a session-id `--resume`, and is for text chat models only. A bare `-r`/`--resume` next to `--rpg` means "continue the story from `history.json`" — see below.

If `post-history-instruction.md` contains anything (Markdown comments stripped, `{{char}}`/`{{user}}` expanded), it is sent as a separate system message after the latest user message on every turn. The file is optional — a missing or empty file disables the feature. This is the SillyTavern "post-history instructions" pattern: late instructions get the model's strongest attention and are not diluted by a long conversation, so it is the place for rules the model tends to forget or skim over (never break character, always react to X, keep replies under N words, …). The instruction is added at request time and never saved into `history.json`.

### Saving and resuming the conversation

The conversation is saved to `history.json` in the RPG directory — on `/quit`, `/new`, `/model`, Ctrl+C (including interrupted responses), and after one-shot runs. The file stores the conversation turns without the system prompt, so editing the story files later applies to the resumed conversation.

A plain `--rpg <dir>` run always starts a **new** story: the greeting from `first-message.md` opens the chat, and once the new story has turns it replaces `history.json` (a warning is printed first if a saved story exists). Resuming is opt-in: `communicator --rpg <dir> --resume` (bare `--resume`, no session id) replays the saved turns before the first input prompt and prints a `Resumed RPG conversation from <dir>/history.json (N messages).` notice; if there is no saved history it simply starts a new story. The previous chapter remains available in `~/.communicator/sessions/` via `--resume <id>`/`--export` regardless.

`/new` in RPG mode saves the current chapter and restarts the story **with the first message** — the opening greeting from `first-message.md` is rendered and seeded again instead of a blank page (in non-RPG chat `/new` still clears to an empty conversation as usual).

RPG transcripts use named speaker markers: replayed user turns are shown under `❯ <your name>` (instead of the usual `❯ You`) and the character's turns under `❯ <character name>`, both taken from the `# Name` headings in `user.md` and `char.md`. Live replies stream under the character marker too, placed after the `❯ Thinking`/`❯ Answer` block when the model reasons. Non-RPG chat is unchanged.

### Inspecting the prompt

`--rpg <dir> --debug` logs every request to `prompt-log.jsonl` in the RPG directory: one JSON object per turn, each holding a timestamp, the model, the provider, and the full `request` body exactly as sent (system prompt, history, user turn, temperature, top_p, web search tools, and any other provider parameters). A short `[debug] prompt logged: …` notice is printed to stderr after each turn. The file is created on the first request (never on a turnless launch), grows one line per turn, and stores the plaintext messages even with `--e2ee` — like `history.json`, it is a local, unencrypted artifact.

Note that `history.json` stores messages unencrypted even under `--e2ee` (encryption only applies to messages sent to the API).
