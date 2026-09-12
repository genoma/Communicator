# Preferences

The preferences file (`~/.communicator.json`, customizable with `--config`), per-model defaults, and the in-chat setters. See the [README](../README.md#documentation) for the full docs index.

```json
{
  "lastModel": "openai/gpt-4o",
  "lastImageModel": "venice-sd35",
  "lastProvider": "OpenAI",
  "reasoningEffort": {
    "openai/o1-pro": "high"
  },
  "temperature": {
    "openai/gpt-4o": 0.2
  },
  "topP": {
    "openai/gpt-4o": 0.8
  },
  "webSearch": {
    "openai/gpt-4o": "auto"
  },
  "smoothStreaming": true,
  "smoothSpeed": 2000,
  "compactThinking": true,
  "webResults": 10,
  "outputDir": "/home/user/Documents/CommunicatorExports",
  "hideWatermark": true,
  "safeMode": false
}
```

- `lastModel` / `lastProvider` — become the defaults in the interactive pickers.
- `lastImageModel` — becomes the default in the interactive image model picker.
- `reasoningEffort` / `temperature` / `topP` / `webSearch` — saved per model ID and restored automatically.
- `smoothStreaming` / `smoothSpeed` — global defaults; the speed is stored as a chars-per-second number, e.g. `2000`.
- `compactThinking` — global default for the reasoning display: `true` shows a `Thinking` meter (TTY only) instead of streaming the reasoning text. Set by `/compact-thinking`, and removed or set `false` by `/compact-thinking off`; `--compact-thinking` applies it to that run without persisting it.
- `webResults` — session default applied when no flag is given. (`budget` is inert since 4.0.0: the cap comes from `/budget <usd>` for the current session only, and a leftover `budget` key is ignored — no migration removes it.)
- `exportFormat` — format for future `--export` runs: `markdown` (default) or `jsonl`; set with `/export-format` in chat or persisted by an `--export --export-format <fmt>` run.
- `hideWatermark` — global Venice image setting: when `true`, generated images are requested without the Venice watermark (Venice may ignore it for some content/models).
- `safeMode` — global Venice image setting: when `false`, generated images are requested with safe mode disabled (`--no-safe-mode` persists it; removing the key re-enables safe mode).
- `imageDefaults` — per-provider image sizing defaults (`venice`/`openrouter`, each `{ aspectRatio, format, resolution, quality, variants }`), saved by a run carrying `--aspect-ratio`/`--image-format`, by any explicit flag or non-default picker choice, and by `/aspect`/`/format`/`/resolution`/`/quality`/`/variants` in image sessions. `/seed` is never persisted.
- Legacy `webSearch: true` values are read as `auto`.

Preferences are currently scoped across both API backends — your last OpenRouter model shows as the favorite even when using Venice (this will be improved in a future release).
