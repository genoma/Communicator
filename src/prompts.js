import { search, select } from "@inquirer/prompts"
import { Separator } from "@inquirer/core"
import { EFFORT_LABELS } from "./constants.js"

export const BACK_SENTINEL = Symbol("back");

export async function selectModel(models, lastModel) {
  const choices = models.map((m) => ({
    name: `${m.name}  (${m.id})`,
    value: { id: m.id, name: m.name },
    description: m.description || `${m.contextLength?.toLocaleString() || "?"} context`,
  }));

  const answer = await search({
    message: "Select a model",
    source: async (input) => {
      if (!input) {
        if (lastModel) {
          const idx = choices.findIndex((c) => c.value.id === lastModel);
          if (idx >= 0) {
            const [fav] = choices.splice(idx, 1);
            return [fav, ...choices];
          }
        }
        return choices;
      }
      const q = input.toLowerCase();
      return choices.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.value.id.toLowerCase().includes(q)
      );
    },
  });

  return answer;
}

export async function selectProvider(endpoints) {
  if (endpoints.length === 1) {
    const ep = endpoints[0];
    console.log(`Only one provider available: ${ep.providerName} (${ep.pricing?.prompt || "?"})`);
    return ep;
  }

  const backChoice = {
    name: "← Back to model selection",
    value: BACK_SENTINEL,
    description: "Return to the model picker",
  };

  const providerChoices = endpoints.map((ep) => {
    const promptPrice = ep.pricing?.prompt
      ? `$${(parseFloat(ep.pricing.prompt) * 1_000_000).toFixed(2)}/M tokens`
      : "?";
    const uptime = ep.uptime30m != null ? `${ep.uptime30m.toFixed(0)}% uptime` : "?";
    const label = `${ep.providerName}  —  ${promptPrice}  ${uptime}`;

    return {
      name: label,
      value: ep,
      description: ep.tag ? `tag: ${ep.tag}` : undefined,
    };
  });

  const fullChoices = [backChoice, new Separator(), ...providerChoices];

  const answer = await search({
    message: `Select a provider (${endpoints.length} available)`,
    source: async (input) => {
      if (!input) return fullChoices;
      const q = input.toLowerCase();
      const filtered = providerChoices.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.value.providerName.toLowerCase().includes(q) ||
          (c.value.tag && c.value.tag.toLowerCase().includes(q))
      );
      if (filtered.length === 0) {
        const backMatch =
          "← back to model selection".includes(q) ||
          "back".includes(q);
        return backMatch ? [backChoice] : [];
      }
      return filtered;
    },
  });

  return answer;
}

const FULL_EFFORT_LIST = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];

export function getEffortLabel(effort) {
  return EFFORT_LABELS[effort] || effort;
}

export async function selectReasoningEffort(reasoning, lastEffort) {
  if (!reasoning) return undefined;

  const efforts = reasoning.supported_efforts || FULL_EFFORT_LIST;
  const mandatory = reasoning.mandatory === true;

  const filteredEfforts = mandatory
    ? efforts.filter((e) => e !== "none")
    : efforts;

  const noneIdx = filteredEfforts.indexOf("none");
  if (noneIdx > 0) {
    filteredEfforts.splice(noneIdx, 1);
    filteredEfforts.unshift("none");
  }

  if (filteredEfforts.length === 0) return undefined;

  const defaultEffort =
    lastEffort ||
    (reasoning.default_effort && reasoning.default_effort !== "none"
      ? reasoning.default_effort
      : null) ||
    "medium";

  const defaultIdx = filteredEfforts.indexOf(defaultEffort);

  const answer = await select({
    message: "Select reasoning effort:",
    choices: filteredEfforts.map((e) => ({
      name: getEffortLabel(e),
      value: e === "none" ? null : e,
    })),
    default: defaultIdx >= 0 ? filteredEfforts[defaultIdx] : undefined,
  });

  return answer;
}

export function resolveReasoningFlag({ reasoning, reasoningEffort }) {
  if (reasoning === false) return null
  if (reasoningEffort) return reasoningEffort
  return undefined
}
