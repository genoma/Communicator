# Preferences

The preferences file (`~/.communicator.json`, customizable with `--config`), per-model defaults, and standalone config commands. See the [README](../README.md#documentation) for the full docs index.

```json
{
  "lastModel": "openai/gpt-4o",
  "lastProvider": "OpenAI",
  "reasoningEffort": {
    "openai/o1-pro": "high"
  },
  "temperature": {
    "openai/gpt-4o": 0.2
  },
  "webSearch": {
    "openai/gpt-4o": "auto"
  },
  "smoothStreaming": true,
  "smoothSpeed": 2000,
  "budget": 2,
  "webResults": 10,
  "outputDir": "/home/user/Documents/CommunicatorExports",
  "hideWatermark": true,
  "safeMode": false
}
```

- `lastModel` / `lastProvider` — become the defaults in the interactive pickers.
- `reasoningEffort` / `temperature` / `webSearch` — saved per model ID and restored automatically.
- `smoothStreaming` / `smoothSpeed` — global defaults; the speed is stored as a chars-per-second number, e.g. `2000`.
- `budget` / `webResults` — session defaults applied when no flag is given.
- `hideWatermark` — global Venice image setting: when `true`, generated images are requested without the Venice watermark (Venice may ignore it for some content/models).
- `safeMode` — global Venice image setting: when `false`, generated images are requested with safe mode disabled (`--no-safe-mode` persists it; removing the key re-enables safe mode).
- `imageDefaults` — per-provider image sizing defaults (`venice`/`openrouter`, each `{ aspectRatio, format }`), saved by `--aspect-ratio`/`--image-format` alone, by any explicit flag or non-default picker choice, and by `/aspect`/`/format` in image sessions.
- Legacy `webSearch: true` values are read as `auto`.

Preferences are currently scoped across both API backends — your last OpenRouter model shows as the favorite even when using Venice (this will be improved in a future release).
