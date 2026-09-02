# Communicator Documentation

User-facing documentation for the `communicator` CLI, split into guides, reference pages, and a contributor guide. See the [README](../README.md#documentation) for the landing page.

## Guides

| Page | Covers |
|------|--------|
| [chat.md](chat.md) | The interactive flow, one-shot mode, chat session output (CTX indicator), markdown rendering, smooth streaming, budget caps, and the system prompt |
| [web-search.md](web-search.md) | Web search modes, OpenRouter vs Venice behavior, result counts, and clickable sources |
| [web-scrape.md](web-scrape.md) | Web scraping (Venice only): `--scrape`/`/scrape`, content injection, flat pricing, and cost tracking |
| [attachments.md](attachments.md) | File & image attachments: supported formats, interactive and one-shot usage, gating, limits |
| [images.md](images.md) | Image generation on Venice and OpenRouter: unified model picker, image sessions, `--image` flags, `/aspect`/`/format`, `-m` parity, model listing, sizing defaults, storage |

## Reference

| Page | Covers |
|------|--------|
| [commands.md](commands.md) | The full CLI flag reference table, usage examples for every flag, and the in-chat slash commands with autocomplete behavior |
| [sessions.md](sessions.md) | Session persistence: listing, resuming, deleting, exporting, and the on-disk session file format |
| [preferences.md](preferences.md) | The preferences file (`~/.communicator.json`), per-model defaults, and standalone config commands |
| [providers.md](providers.md) | The OpenRouter and Venice.ai backends, and zero-data-retention (ZDR) routing |
| [platforms.md](platforms.md) | Platform support, clipboard tools, terminals, data locations, per-OS install notes, and uninstalling |

## Development

| Page | Covers |
|------|--------|
| [development.md](development.md) | Internal architecture, the module layout, and the provider contract for contributors |
| [audit-2026-08-29.md](audit-2026-08-29.md) | Historical security & performance audit report (2026-08-29; findings reviewed, fixes merged) |

New here? Start with the [Quick start](../README.md#quick-start) in the README.
