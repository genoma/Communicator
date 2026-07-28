import { search } from "@inquirer/prompts";

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

  const choices = endpoints.map((ep) => {
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

  const answer = await search({
    message: `Select a provider (${endpoints.length} available)`,
    source: async (input) => {
      if (!input) return choices;
      const q = input.toLowerCase();
      return choices.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.value.providerName.toLowerCase().includes(q) ||
          (c.value.tag && c.value.tag.toLowerCase().includes(q))
      );
    },
  });

  return answer;
}
