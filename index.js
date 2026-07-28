#!/usr/bin/env node

import { Command } from "commander";
import { getApiKey, loadPreferences, savePreferences } from "./src/config.js";
import { fetchModels, fetchEndpoints } from "./src/openrouter.js";
import { selectModel, selectProvider, selectReasoningEffort, BACK_SENTINEL } from "./src/prompts.js";
import { startChat } from "./src/chat.js";

const program = new Command();

program
  .name("communicator")
  .description("OpenRouter CLI chat with interactive model & provider selection")
  .option("-m, --model <id>", "skip model picker, use this model ID directly")
  .option("-p, --provider <name>", "skip provider picker, use this provider name directly")
  .option("-l, --list", "list available models and exit")
  .option("-L, --list-endpoints <model>", "list providers/endpoints for a model and exit")
  .option("--config <path>", "path to preferences config file")
  .option("--reasoning-effort <level>", "reasoning effort: max, xhigh, high, medium, low, minimal, none")
  .option("--no-reasoning", "disable reasoning entirely");

program.parse();
const opts = program.opts();

const apiKey = getApiKey();

if (opts.list) {
  const models = await fetchModels(apiKey);
  for (const m of models) {
    console.log(
      `${m.name.padEnd(40)} ${m.id.padEnd(50)} ${m.contextLength?.toLocaleString() || "?"} ctx`
    );
  }
  process.exit(0);
}

if (opts.listEndpoints) {
  const endpoints = await fetchEndpoints(apiKey, opts.listEndpoints);
  if (!endpoints.length) {
    console.log(`No endpoints found for ${opts.listEndpoints}`);
    process.exit(0);
  }
  console.log(`${endpoints.length} provider(s) for ${opts.listEndpoints}:\n`);
  for (const ep of endpoints) {
    const promptPrice = ep.pricing?.prompt
      ? `$${(parseFloat(ep.pricing.prompt) * 1_000_000).toFixed(2)}/M`
      : "?";
    const uptime = ep.uptime30m != null ? `${ep.uptime30m.toFixed(0)}%` : "?";
    console.log(
      `${ep.providerName.padEnd(20)} | prompt ${promptPrice.padEnd(12)} | uptime ${uptime} | tag ${ep.tag}`
    );
  }
  process.exit(0);
}

const prefs = await loadPreferences(opts.config);

let modelId, modelName, providerName, reasoningEffort, pricing;

function resolveReasoningFlag() {
  if (opts.reasoning === false) return null;
  if (opts.reasoningEffort) return opts.reasoningEffort;
  return undefined;
}

if (opts.model && opts.provider) {
  modelId = opts.model;
  modelName = modelId;
  providerName = opts.provider;
  reasoningEffort = resolveReasoningFlag();
} else {
  const models = await fetchModels(apiKey);
  reasoningEffort = resolveReasoningFlag();

  for (;;) {
    let selected;
    if (opts.model) {
      modelId = opts.model;
      modelName = modelId;
      selected = null;
    } else {
      selected = await selectModel(models, prefs.lastModel);
      modelId = selected.id;
      modelName = selected.name;
    }

    if (reasoningEffort === undefined) {
      const modelData = models.find((m) => m.id === modelId);
      const lastEffort = prefs.reasoningEffort?.[modelId];
      reasoningEffort = await selectReasoningEffort(modelData?.reasoning, lastEffort);
    }

    if (opts.provider) {
      providerName = opts.provider;
      break;
    }

    const endpoints = await fetchEndpoints(apiKey, modelId);
    if (!endpoints.length) {
      console.error(`No providers found for model: ${modelId}`);
      process.exit(1);
    }

    const ep = await selectProvider(endpoints);
    if (ep === BACK_SENTINEL) {
      reasoningEffort = undefined;
      continue;
    }
    providerName = ep.providerName;
    pricing = ep.pricing;
    break;
  }
}

await startChat(apiKey, modelId, providerName, reasoningEffort, pricing);

const savedPrefs = { lastModel: modelId, lastProvider: providerName };
if (reasoningEffort !== undefined) {
  if (!prefs.reasoningEffort) prefs.reasoningEffort = {};
  prefs.reasoningEffort[modelId] = reasoningEffort;
  savedPrefs.reasoningEffort = prefs.reasoningEffort;
}
await savePreferences(savedPrefs, opts.config);
