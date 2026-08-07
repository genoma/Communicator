# Image Generation (Venice)

See the [README](../README.md#documentation) for the full docs index.

Generate images directly from the terminal with Venice's image models (Flux, Nano Banana, GPT Image, ...). Venice exposes image generation on a **separate non-streaming endpoint** with per-image pricing, so this works as its own standalone flow — it does not go through the chat model picker.

**Venice only** — `--image`, `--list-image-models`, and `/image` fail with a clear error on OpenRouter (OpenRouter image output already works through the chat artifact flow).

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
| `--output-dir <path>`| Also copy the generated images to this directory (saved as the default for later runs) |

Flags are validated against the chosen model's `constraints` (supported aspect ratios, resolution tiers, quality levels, width/height divisor) when the model is known; an unknown `--image-model` id passes the flags through and the API surfaces any error.

## Listing models

```bash
communicator -p venice --list-image-models
```

Prints each image model's name, id, per-image price, and its sizing options (`[aspect: …]`, `[resolution: …]`, `[quality: …]`, `[privacy]`, `[offline]`). No API key is needed to list models.

## In chat: `/image <description>`

Inside a Venice session, `/image a red cat` runs the generation with the same flags behavior (interactive model picker, since chat flags don't apply) and appends the result to the current session as an assistant message — visible on `--resume` and included in `--export`. Bare `/image` prints a usage hint. Image parts are re-sent to the chat model on later turns of the same session, like any other produced artifact.

## Storage & costs

- Every generated image is saved as a blob in the session's attachment directory (`~/.communicator/sessions/attachments/<session-id>/`), referenced from the assistant message, and `saved to <path>` lines print the locations. `--output-dir` also copies the files there.
- The session is a normal session: it appears in `--list-sessions`, resumes, and exports.
- Image generation has no tokens, so no usage/cost is recorded in the tracker — instead a cost line prints the per-image price times the number of images returned (`Cost: $0.18 per image × 2 = $0.36`), derived from the model's pricing (resolution/quality matrix when applicable).
- With safe mode on (default), adult-content results are returned blurred and a warning line prints. The last used image model (`lastImageModel`) is remembered and shown first in the picker.
- Generations are synchronous and can take minutes on high-end models (`gpt-image-2`, `nano-banana-2`, ...); the client waits up to 10 minutes per request.

Out of scope for now: `style_references`, `negative_prompt`, `enhance_prompt`, `steps`, `cfg_scale`, image edit/upscale, and interactive sizing pickers.
