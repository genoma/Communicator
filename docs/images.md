# Image Generation (Venice)

See the [README](../README.md#documentation) for the full docs index.

Generate images directly from the terminal with Venice's image models (Flux, Nano Banana, GPT Image, ...). Venice exposes image generation on a **separate non-streaming endpoint** with per-image pricing, so this works as its own standalone flow — it does not go through a chat completion.

**Venice only** — `--image`, `--list-image-models`, `/image`, image sessions, and `-m <image-model>` fail with a clear error on OpenRouter (OpenRouter image output already works through the chat artifact flow).

## Unified model picker & image sessions

The interactive model picker (Venice) now shows **text models and image models together**: image models appear after an `Image models` separator, tagged `[image]`, with your last-used image model pinned first. Picking an image model starts an **image session** instead of a chat:

```text
Select a model
❯ venice/llama-3.3-70b
  flux-1-1  (flux-1-1)  [image]
  ...
──────────────────────────
Image models
  venice-sd35  (venice-sd35)  [image]
  gpt-image-2  (gpt-image-2)  [image]  [offline]
```

- Every prompt you type generates an image (`saved to …` lines after each turn).
- `/help` lists the commands; `/exit` and `/quit` (or Ctrl+C / EOF) leave the session.
- Each turn is persisted to the session (system + prompt + image messages), so the session shows up in `--list-sessions`, is exportable, and `--resume <id>` re-enters the image session to keep generating. Your last-used image model is remembered (`lastImageModel`).
- `-m <image-model> "prompt"` runs the same generation as a one-shot (persisted + printed, `--attach` rejected), and `--image`/`/image` keep working as before for one-off generations inside text sessions.

## One-shot: `--image`

```bash
communicator -p venice --image "a red cat in a spacesuit"
```

The description is the positional prompt; piped stdin works too (`echo "a red cat" | communicator -p venice --image`). Flags:

| Flag                 | Description                                                               |
|----------------------|---------------------------------------------------------------------------|
| `--image-model <id>` | Skip the interactive model picker and use this image model directly (required when piping input) |
| `--image-format`     | Output format: `png`, `jpeg`, `webp` (default `webp`)                      |
| `--variants <n>`     | Number of images to generate, 1–4 (default 1)                              |
| `--aspect-ratio <x:y>` | Aspect ratio (model-dependent, e.g. `16:9`, `1:1`)                       |
| `--resolution <tier>` | Resolution tier (model-dependent): `1K`, `2K`, `4K`                       |
| `--quality <level>`  | Quality tier (model-dependent): `low`, `medium`, `high`                    |
| `--width <px>` / `--height <px>` | Pixel dimensions, 1–1280 (pixel-based models; cannot be combined with `--aspect-ratio` or `--resolution`) |
| `--seed <int>`       | Random seed for reproducible generations                                   |
| `--no-safe-mode`     | Disable safe mode (adult content is returned unblurred)                    |
| `--no-watermark`     | Hide the Venice watermark on the generated images (persisted as the global `hideWatermark` pref) |
| `--output-dir <path>`| Also copy the generated images to this directory (saved as the default for later runs) |

Flags are validated against the chosen model's `constraints` (supported aspect ratios, resolution tiers, quality levels, width/height divisor) when the model is known; an unknown `--image-model` id passes the flags through and the API surfaces any error.

## Listing models

```bash
communicator -p venice --list-image-models
```

Prints each image model's name, id, per-image price, and its sizing options (`[aspect: …]`, `[resolution: …]`, `[quality: …]`, `[privacy]`, `[offline]`). No API key is needed to list models.

## In chat: `/image <description>`

Inside a Venice session, `/image a red cat` runs the generation with the same flags behavior (interactive model picker, since chat flags don't apply) and appends the result to the current session as an assistant message — visible on `--resume` and included in `--export`. Bare `/image` prints a usage hint. Image parts are re-sent to the chat model on later turns of the same session, like any other produced artifact.

## Watermark hiding

Venice stamps generated images with a watermark unless `hide_watermark: true` is sent. This CLI exposes it as a **global setting** (not per model):

- `--no-watermark` disables it for the current `--image`/`-m <image-model>` one-shot and persists `hideWatermark: true` in the preferences file.
- `/watermark off` disables the watermark for this and future generations; `/watermark on` re-enables it. Works inside a Venice chat session or an image session (bare `/watermark` shows the current state). The setting takes effect immediately, including for `/image` calls in the same session.
- The persisted `hideWatermark` pref applies to all Venice image generation; `/watermark on` (or removing the pref) re-enables the watermark.
- Venice may ignore the request for some content or models.

## Storage & costs

- Every generated image is saved as a blob in the session's attachment directory (`~/.communicator/sessions/attachments/<session-id>/`), referenced from the assistant message, and `saved to <path>` lines print the locations. `--output-dir` also copies the files there.
- The session is a normal session: it appears in `--list-sessions`, resumes, and exports.
- Image generation has no tokens, so no usage/cost is recorded in the tracker — instead a cost line prints the per-image price times the number of images returned (`Cost: $0.18 per image × 2 = $0.36`), derived from the model's pricing (resolution/quality matrix when applicable).
- With safe mode on (default), adult-content results are returned blurred and a warning line prints. The last used image model (`lastImageModel`) is remembered and shown first in the picker. Watermark hiding (`hideWatermark`) is a global preference applied to every generation (see [Watermark hiding](#watermark-hiding)).
- Generations are synchronous and can take minutes on high-end models (`gpt-image-2`, `nano-banana-2`, ...); the client waits up to 10 minutes per request.

Out of scope for now: `style_references`, `negative_prompt`, `enhance_prompt`, `steps`, `cfg_scale`, image edit/upscale, and interactive sizing pickers.
