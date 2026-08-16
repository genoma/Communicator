#!/usr/bin/env node

import { Command } from 'commander'
import pkg from './package.json' with { type: 'json' }
import { runCli } from './src/cli-main.js'
import { collectFlag } from './src/cli-utils.js'

const program = new Command()

program
  .name('communicator')
  .description('AI CLI chat with interactive model & provider selection')
  .version(pkg.version)
  .argument('[prompt]', 'message to send in one-shot mode')
  .option('-m, --model <id>', 'skip all pickers, use this model ID directly')
  .option('-p, --provider <name>', 'AI provider backend: openrouter or venice', 'openrouter')
  .option('--list-models', 'list available models and exit')
  .option('--list-image-models', 'list available image generation models and exit')
  .option('--image', 'generate an image with an image model and exit')
  .option('--image-model <id>', 'image generation model ID (skips the interactive image model picker)')
  .option('--image-format <png|jpeg|webp>', 'image output format (default: webp on Venice, png on OpenRouter)')
  .option('--variants <n>', 'number of images to generate (1-4)')
  .option('--aspect-ratio <x:y>', 'image aspect ratio, model-dependent (e.g. 16:9; "auto" and decimal ratios accepted)')
  .option('--resolution <1K|2K|4K>', 'image resolution tier, model-dependent')
  .option('--quality <low|medium|high>', 'image quality tier, model-dependent')
  .option('--seed <int>', 'random seed for image generation')
  .option('--width <px>', 'image width in pixels (1-1280)')
  .option('--height <px>', 'image height in pixels (1-1280)')
  .option('--no-safe-mode', 'disable safe mode for image generation (adult content will not be blurred; persisted as a global Venice setting)')
  .option('--no-watermark', 'hide the Venice watermark on generated images (persisted as a global Venice setting)')
  .option('--list-endpoints [model]', 'list providers/endpoints for a model (interactive picker when omitted)')
  .option('-r, --resume [session-id]', 'resume a saved session (optional session ID)')
  .option('-x, --export [session-id]', 'export saved sessions as markdown (select one or more)')
  .option('--output-dir <path>', 'custom directory for exported markdown files (bare use saves it as the default)')
  .option('--list-sessions', 'list saved sessions and exit')
  .option('--config [path]', 'path to preferences config file (bare flag prints the current config)')
  .option('--system-prompt <path>', 'path to a custom system prompt file')
  .option('--rpg <dir>', 'enable RPG mode using char.md, user.md, prompt.md, scenario.md, and first-message.md from a directory')
  .option('--debug', 'with --rpg: log the full prompt sent to the model to prompt-log.jsonl in the RPG directory')
  .option('--reasoning-effort <level>', 'reasoning effort: max, xhigh, high, medium, low, minimal, none')
  .option('--temperature <0-2>', 'temperature override (0 to 2)')
  .option('--budget <usd>', 'per-session budget cap in USD')
  .option('--web-search [mode]', 'web search mode: auto, always, on, off (bare flag = auto; per-model default persisted)')
  .option('--web-results <n>', 'number of web search results (OpenRouter only, default 10)')
  .option('--zdr', 'force zero-data-retention routing (OpenRouter only; filters model/provider selection to ZDR-capable endpoints)')
  .option('--e2ee', 'enable end-to-end encryption (Venice only; filters model selection to E2EE-capable models, disables web search and attachments)')
  .option('--attach <path>', 'attach a file (repeatable; images/pdf/xlsx/txt/...)', collectFlag, [])
  .option('--scrape <url>', 'scrape a web page into the session as context, then chat or answer (Venice only, $0.01 per page)')
  .option('--no-smooth-streaming', 'disable smooth streaming (default: on in interactive sessions)')
  .option('--smooth-speed <level|cps>', 'smooth streaming speed: slow, normal, fast, or chars per second')
  .option('--delete [partial-id]', 'delete saved sessions (with confirmation, select one or more)')
  .option('--delete-all-sessions [y/N]', 'delete ALL saved sessions (pass y to confirm; default: no)')

program.parse()
const opts = program.opts()

await runCli(opts, program.args[0])
