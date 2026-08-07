# Image Generation

See the [README](../README.md#documentation) for the full docs index.

Generate images directly from the terminal with **Venice** image models (Flux, Nano Banana, GPT Image, ...) and **OpenRouter** image models (GPT Image, Flux, ...). Both providers expose image generation on a **separate non-streaming endpoint** with per-image pricing, so this works as its own standalone flow — it does not go through a chat completion. Everything below (`--image`, `--list-image-models`, `/image`, image sessions, `-m <image-model>`) works on **both providers**.

## Unified model picker & image sessions

The interactive model picker shows **text models and image models together**: image models appear after an `Image models` separator, tagged `[image]`, with your last-used image model pinned first. Picking an image model starts an **image session** instead of a chat:

```text
Select a model
❯ venice/llama-3.3-70b
  flux-1-1  (flux-1-1)  [image]
  ...
──────────────────────────
Image models
  venice-sd35  (venice-sd35)  [image]
  gpt-image-2  (gpt-image-2)  [image]  [offline]
  openai/gpt-image-1-mini  (openai/gpt-image-1-mini)  [image]
```

- Every prompt you type generates an image (`saved to …` lines after each turn).
- `/help` lists the commands; `/exit` and `/quit` (or Ctrl+C / EOF) leave the session.
- Each turn is persisted to the session (system + prompt + image messages), so the session shows up in `--list-sessions`, is exportable, and `--resume <id>` re-enters the image session to keep generating. Your last-used image model is remembered (`lastImageModel`).
- `-m <image-model> "prompt"` runs the same generation as a one-shot (persisted + printed, `--attach` rejected), and `--image`/`/image` keep working as before for one-off generations inside text sessions.
- Inside an image session, `/aspect <x:y>` and `/format <fmt>` set the sizing for the rest of the session (see [Sizing defaults](#sizing-defaults)); `/watermark` is Venice-only.

## One-shot: `--image`

```bash
communicator -p venice --image "a red cat in a spacesuit"
communicator -p openrouter --image "a red cat in a spacesuit"
```

The description is the positional prompt; piped stdin works too (`echo "a red cat" | communicator -p venice --image`). Flags:

| Flag                 | Description                                                               |
|----------------------|---------------------------------------------------------------------------|
| `--image-model <id>` | Skip the interactive model picker and use this image model directly (required when piping input) |
| `--image-format`     | Output format: `png`, `jpeg`, `webp` (default: `webp` on Venice, `png` on OpenRouter; only sent when the model supports it) |
| `--variants <n>`     | Number of images to generate, 1–4 (default 1; OpenRouter accepts more upstream but the CLI contract stays 1–4) |
| `--aspect-ratio <x:y>` | Aspect ratio (model-dependent, e.g. `16:9`, `1:1`, `auto`; decimal ratios like `9:19.5` are accepted) |
| `--resolution <tier>` | Resolution tier (model-dependent): `1K`, `2K`, `4K` on Venice; OpenRouter tiers like `1024x1024` |
| `--quality <level>`  | Quality tier (model-dependent): `low`, `medium`, `high`                    |
| `--width <px>` / `--height <px>` | Exact pixel dimensions, 1–1280, multiples of the model's divisor (pixel-based models; cannot be combined with `--aspect-ratio` or `--resolution`) |
| `--seed <int>`       | Random seed for reproducible generations                                   |
| `--no-safe-mode`     | Disable safe mode (Venice; adult content is returned unblurred)            |
| `--no-watermark`     | Hide the Venice watermark on the generated images (persisted as the global `hideWatermark` pref) |
| `--output-dir <path>`| Also copy the generated images to this directory (saved as the default for later runs) |

Explicit flags are validated against the chosen model's supported options (aspect ratios, formats, resolution tiers, quality levels, width/height divisor) when the model is known; an unsupported value errors with the supported list. An unknown `--image-model` id passes the flags through and the API surfaces any error.

On a TTY, `--image` (and `-m <image-model>`) without the sizing flags asks for the aspect ratio and output format with compact pickers — the saved default is preselected, so pressing Enter accepts it. Pixel-based models get the same ratio picker over their hardcoded preset list, with each ratio labeled with its computed pixel size (`2:3 · 848x1272`) and the saved ratio preselected (falling back to 1:1). Flags skip the pickers. Piped input uses the saved defaults directly.

## Listing models

```bash
communicator -p venice --list-image-models
communicator -p openrouter --list-image-models
```

Prints each image model's name, id, per-image price, and its sizing options (`[aspect: …]`, `[resolution: …]`, `[quality: …]`, `[privacy]`, `[offline]`). No API key is needed to list models; on OpenRouter the price column fetches per-model endpoint pricing (`from $X per image` across billable output-image entries).

## In chat: `/image <description>`

Inside any session, `/image a red cat` runs the generation and appends the result to the current session as an assistant message — visible on `--resume` and included in `--export`. Bare `/image` prints a usage hint. Image parts are re-sent to the chat model on later turns of the same session, like any other produced artifact.

`/image` accepts leading options that are stripped from the appended description:

```text
/image --ratio 16:9 --format png a red cat      # explicit sizing
/image --aspect-ratio 3:2 a red cat             # --aspect-ratio is an alias of --ratio
/image --ratio 2:3 a red cat                    # pixel-based models: ratio is computed to pixels (e.g. 848x1272)
/image a red cat                                # pickers ask for ratio/format (saved default preselected)
```

Any other leading `--option` is a usage error. Without the flags, compact pickers appear after model selection with the saved default preselected (Enter accepts).

## Sizing defaults

Choices are remembered as **global per-provider defaults** (`venice` and `openrouter` are separate) in the preferences file:

```json
{
  "imageDefaults": {
    "venice": { "aspectRatio": "16:9", "format": "webp" },
    "openrouter": { "aspectRatio": "1:1", "format": "png" }
  }
}
```

- A non-default picker choice or any explicit flag (CLI or `/image --ratio/--format`) becomes the provider default for future generations. Only ratios are stored — pixel sizes are always derived from the ratio and the model's divisor, never persisted.
- Save them directly with the config-setter (no `--image` needed):
  ```bash
  communicator -p venice --aspect-ratio 16:9 --image-format png
  communicator -p openrouter --aspect-ratio 1:1
  ```
- Image sessions apply the saved defaults automatically on start; `/aspect <x:y>` and `/format <fmt>` override them for the rest of the session. Bare `/aspect`/`/format` show the model's full supported list with the current value marked in brackets (`Aspect ratios: 1:1 [16:9] 3:2.`, `Formats: [png] jpeg webp.`); a stored value outside the supported list is reported as such, and a model that cannot take the parameter at all says so. `clear` unsets the value so the parameter is no longer sent — use it to override a saved default for one session. Only advertised values are accepted.
- **Pixel-based models behave like aspect models with a hardcoded ratio list** (`1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5`): `/aspect <x:y>`, `--aspect-ratio`/`--ratio` and the pickers accept exactly these ratios, and the pixel size is computed from the ratio and the model's `widthHeightDivisor` — `aspect_ratio` itself is never sent (those models ignore it and return a square default). Bare `/aspect` shows each preset with its computed size and the current ratio marked: `Aspect ratios: 1:1 1280x1280 · 3:2 1272x848 · 16:9 1280x720 · 21:9 1264x544 · 9:16 720x1280 · [2:3 848x1272] · 3:4 960x1280 · 4:5 1024x1280.`
- **Unsupported defaults are never sent silently**: if a saved default is not supported by the chosen model (or the model cannot take the parameter at all, e.g. GPT-Image models without `output_format`), the CLI drops it and prints a one-line note (`note: saved aspect ratio 21:9 is not supported by <model>; it was not sent.`). Explicit flags always error client-side with the supported list instead. This mirrors the providers' API behavior — a value the model does not support is silently ignored and still billed (Venice pixel-based models ignore `aspect_ratio` and return a square default), so the CLI makes the drop visible rather than relying on the API.
- A model (either provider) whose listing has no `aspect_ratio`/`output_format` support never receives those parameters. On Venice, pixel-based models (`z-image-turbo`, `venice-sd35`, …) take an aspect ratio from the hardcoded preset list (or `--width`/`--height` in multiples of their pixel divisor, up to 1280) instead. Preset ratios are computed to the model's divisor anchored at 1280 per side: on `z-image-turbo` (divisor 8) `2:3` → `848x1272`, `16:9` → `1280x720`, `21:9` → `1264x544`. The web UI shows the divisor-16 rounding (`2:3` → `848x1264`); the CLI follows the API divisor, so `848x1272` is correct even if the web shows 1264.

## Watermark hiding (Venice)

Venice stamps generated images with a watermark unless `hide_watermark: true` is sent. This CLI exposes it as a **global setting** (not per model):

- `--no-watermark` disables it for the current `--image`/`-m <image-model>` one-shot and persists `hideWatermark: true` in the preferences file.
- `/watermark off` disables the watermark for this and future generations; `/watermark on` re-enables it. Works inside a Venice chat session or an image session (bare `/watermark` shows the current state). The setting takes effect immediately, including for `/image` calls in the same session. OpenRouter sessions do not offer `/watermark`.
- The persisted `hideWatermark` pref applies to all Venice image generation; `/watermark on` (or removing the pref) re-enables the watermark.
- Venice may ignore the request for some content or models.

## Safe mode (Venice)

Venice blurs adult-content results unless `safe_mode: false` is sent. This CLI exposes it as a **global setting** (not per model):

- `--no-safe-mode` disables it for the current `--image`/`-m <image-model>` one-shot and persists `safeMode: false` in the preferences file.
- Launching the chat with the flag (`communicator -p venice --no-safe-mode`) opens the session and persists the setting in the same run.
- The persisted `safeMode` pref applies to all Venice image generation; removing the pref from the preferences file re-enables safe mode.
- OpenRouter image generation has no safe-mode parameter, so the setting only affects Venice.

## Provider differences

- **Venice** (`POST /image/generate`): per-image pricing (`$X per image`, sometimes a resolution/quality matrix); every model accepts `png|jpeg|webp`; safe mode + watermark options; `auto` aspect ratio only on some models.
- **OpenRouter** (`POST /api/v1/images`): pricing is per model+endpoint (`from $X per image`); models advertise exactly which `aspect_ratio`/`output_format`/`resolution`/`quality` values they accept (including extended ratios like `9:19.5` and `auto`); no safe-mode or watermark parameters. The generation response's `media_type` decides the saved file type, not the requested format.
- OpenRouter **chat-completion** image-output models (the artifact flow) are unaffected — sizing control only exists for the dedicated image API models listed by `--list-image-models`.

## Storage & costs

- Every generated image is saved as a blob in the session's attachment directory (`~/.communicator/sessions/attachments/<session-id>/`), referenced from the assistant message, and `saved to <path>` lines print the locations. `--output-dir` also copies the files there.
- The session is a normal session: it appears in `--list-sessions`, resumes, and exports.
- Image generation has no tokens, so no usage/cost is recorded in the tracker — instead a cost line prints the per-image price times the number of images returned (`Cost: $0.18 per image × 2 = $0.36`), derived from the model's pricing (resolution/quality matrix on Venice; total `usage.cost` divided by the returned count on OpenRouter).
- With safe mode on (default), Venice adult-content results are returned blurred and a warning line prints. Safe mode is a global preference (`safeMode`, see [Safe mode (Venice)](#safe-mode-(venice))). The last used image model (`lastImageModel`) is remembered and shown first in the picker. Watermark hiding (`hideWatermark`) is a global preference applied to every Venice generation (see [Watermark hiding](#watermark-hiding-(venice))).
- Generations are synchronous and can take minutes on high-end models (`gpt-image-2`, `nano-banana-2`, ...); the client waits up to 10 minutes per request.

Out of scope for now: `style_references`, `negative_prompt`, `enhance_prompt`, `steps`, `cfg_scale`, OpenRouter `background`/`output_compression`/`input_references`, image edit/upscale, per-model defaults, and resolution/quality pickers (the flags keep working where supported).
