# Preferences

Persisted settings in `~/.communicator.json` (customizable with `--config`). See the [README](../README.md#documentation) for the full docs index.

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
  "smoothSpeed": "normal",
  "budget": 2,
  "webResults": 10,
  "outputDir": "/home/user/Documents/CommunicatorExports",
  "hideWatermark": true
}
```

The last model and provider become defaults in the interactive pickers. Reasoning effort, temperature, and web search mode are saved per model ID and restored automatically. `smoothStreaming` and `smoothSpeed` are global defaults, and `budget`/`webResults` are the session defaults applied when no flag is given. `hideWatermark` is a global Venice image setting: when `true`, generated images are requested without the Venice watermark (Venice may ignore it for some content/models). `imageDefaults` holds per-provider image sizing defaults (`venice`/`openrouter`, each `{ aspectRatio, format }`), saved by `--aspect-ratio`/`--image-format` alone, by any explicit flag or non-default picker choice, and by `/aspect`/`/format` in image sessions. Legacy `webSearch: true` values are read as `auto`. Preferences are currently scoped across both API backends — your last OpenRouter model will show as the favorite even when using Venice (this will be improved in a future release).
