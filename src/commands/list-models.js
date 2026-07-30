import { fetchModels } from "../openrouter.js"

export async function listModelsCmd(apiKey) {
  const models = await fetchModels(apiKey)
  for (const m of models) {
    console.log(
      `${m.name.padEnd(40)} ${m.id.padEnd(50)} ${m.contextLength?.toLocaleString() || "?"} ctx`
    )
  }
}
