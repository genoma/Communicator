# Web Scraping (Venice)

Venice's web scraping feature turns a public web page into markdown and feeds it to the model as conversation context. It is a Venice-only API (`POST /api/v1/augment/scrape`) and billed at a flat **$0.01 per page**, independent of the page size. The feature is experimental — request/response formats may change without notice; sites that block automated access (e.g. X/Twitter, Reddit) return an error.

## `--scrape <url>` (launch)

Scrapes the page, prints a confirmation with the character count, and injects the markdown as a context turn:

```bash
communicator -p venice --scrape "https://example.com/article" "Summarize this article"
```

With a prompt argument or piped stdin the scraped page is prepended to the conversation and the prompt is answered immediately (one-shot). Bare `--scrape <url>` on a TTY opens an interactive chat session with the page already in context. The URL must be `http(s)`; anything else errors before any API call.

`--scrape` is a chat session flag: it conflicts with `--list-*`, `--export`, `--delete`, `--delete-all-sessions`, `--resume`, `--image`, and bare `--config`, and cannot be combined with `--e2ee` (the host would see the scraped content) or a non-Venice provider.

## `/scrape <url>` (interactive)

Mid-chat, `/scrape <url>` fetches the page, appends it to the conversation as a context turn, and prints a confirmation including the session cost total. Use the multi-line input to ask about the page in the same submission:

```
/scrape https://example.com/article
What are the key points?
```

Bare `/scrape` prints usage; a non-http(s) URL errors locally. The command is hidden outside Venice and under `--e2ee` (both the hint list and the suggestion list).

## Cost tracking & persistence

- The flat $0.01 is added to the session's usage tracker: `/cost` reports it (plus a scrape count), and it counts toward `/budget` exactly like token spend.
- The scrape count is stored in the session file, so `--resume` restores the cost and the scrape counter; the scraped page itself is a normal user message and persists in the session like any other message (replays on `--resume`, appears in `--export`).
- Pages are capped at 200,000 characters; larger pages are truncated before entering context (the confirmation says so).
- `/new` clears the current session's scrape history along with its tracker.
