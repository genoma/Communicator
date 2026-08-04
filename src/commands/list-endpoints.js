import { formatModelPrice } from '../ui/format.js'
import { selectModel } from '../prompts.js'
import { fail } from '../cli-utils.js'

export function matchModelId(models, partial) {
  const exact = models.find((m) => m.id === partial)
  if (exact) return { model: exact, candidates: [] }
  const q = partial.toLowerCase()
  const seen = new Set()
  const candidates = []
  for (const m of models) {
    if (seen.has(m.id)) continue
    const id = m.id.toLowerCase()
    if (id.startsWith(q) || id.includes(q)) {
      seen.add(m.id)
      candidates.push(m)
    }
  }
  if (candidates.length === 1) return { model: candidates[0], candidates: [] }
  return { model: null, candidates }
}

async function printEndpoints(provider, apiKey, modelId) {
  const endpoints = await provider.fetchEndpoints(apiKey, modelId)
  if (!endpoints.length) {
    if (!provider.meta.hasEndpoints) {
      console.log(`${modelId} is directly available on Venice (no multi-provider routing)`)
    } else {
      console.log(`No endpoints found for ${modelId}`)
    }
    return
  }
  console.log(`${endpoints.length} provider(s) for ${modelId}:\n`)
  for (const ep of endpoints) {
    const priceText = formatModelPrice(ep.pricing?.prompt, ep.pricing?.completion)
    const uptime = ep.uptime30m != null ? `${ep.uptime30m.toFixed(0)}%` : '?'
    const zdrCol = ep.zdr !== undefined ? ` | zdr ${ep.zdr ? 'yes' : 'no'}` : ''
    const privacyCol = ep.privacyPolicyURL ? ` | privacy ${ep.privacyPolicyURL}` : ''
    console.log(
      `${ep.providerName.padEnd(20)} | ${priceText.padEnd(26)} | uptime ${uptime} | tag ${ep.tag}${zdrCol}${privacyCol}`
    )
  }
}

export async function listEndpointsCmd(provider, apiKey, modelArg, prefs) {
  let modelId
  if (modelArg === true) {
    if (!process.stdin.isTTY) {
      fail('Error: interactive model selection needs a TTY. Pass a model id: --list-endpoints <model>')
    }
    const models = await provider.fetchModels(apiKey)
    const selected = await selectModel(models, prefs?.lastModel)
    modelId = selected.id
  } else if (typeof modelArg === 'string' && modelArg.trim()) {
    const models = await provider.fetchModels(apiKey)
    const { model, candidates } = matchModelId(models, modelArg.trim())
    if (!model) {
      if (!candidates.length) {
        fail(`Error: Model "${modelArg}" not found. Use --list-models to list available models.`)
      }
      const shown = candidates.slice(0, 10).map((m) => `  ${m.id}`).join('\n')
      const more = candidates.length > 10 ? `\n  ... and ${candidates.length - 10} more` : ''
      fail(`Error: "${modelArg}" matches ${candidates.length} models. Be more specific:\n${shown}${more}`)
    }
    modelId = model.id
  } else {
    fail('Error: --list-endpoints requires a model id. Use --list-models to list available models.')
  }
  await printEndpoints(provider, apiKey, modelId)
}
