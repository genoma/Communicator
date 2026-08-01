import { search, select } from '@inquirer/prompts'
import { Separator } from '@inquirer/core'
import { EFFORT_LABELS, MAX_TEMPERATURE } from './constants.js'
import { formatModelPrice } from './ui/format.js'

export const BACK_SENTINEL = Symbol('back')

export async function selectModel(models, lastModel) {
  const choices = models.map((m) => ({
    name: `${m.name}  (${m.id})`,
    value: { id: m.id, name: m.name },
    description: m.description || `${m.contextLength?.toLocaleString() || '?'} context`,
  }))

  const answer = await search({
    message: 'Select a model',
    source: async (input) => {
      if (!input) {
        if (lastModel) {
          const idx = choices.findIndex((c) => c.value.id === lastModel)
          if (idx >= 0) {
            const [fav] = choices.splice(idx, 1)
            return [fav, ...choices]
          }
        }
        return choices
      }
      const q = input.toLowerCase()
      return choices.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.value.id.toLowerCase().includes(q)
      )
    },
  })

  return answer
}

export async function selectProvider(endpoints) {
  if (endpoints.length === 1) {
    const ep = endpoints[0]
    const priceText = formatModelPrice(ep.pricing?.prompt, ep.pricing?.completion)
    console.log(`Only one provider available: ${ep.providerName} (${priceText})`)
    return ep
  }

  const backChoice = {
    name: '← Back to model selection',
    value: BACK_SENTINEL,
    description: 'Return to the model picker',
  }

  const providerChoices = endpoints.map((ep) => {
    const priceText = formatModelPrice(ep.pricing?.prompt, ep.pricing?.completion)
    const uptime = ep.uptime30m != null ? `${ep.uptime30m.toFixed(0)}% uptime` : '?'
    const label = `${ep.providerName}  —  ${priceText}  ${uptime}`

    return {
      name: label,
      value: ep,
      description: ep.tag ? `tag: ${ep.tag}` : undefined,
    }
  })

  const fullChoices = [backChoice, new Separator(), ...providerChoices]

  const answer = await search({
    message: `Select a provider (${endpoints.length} available)`,
    source: async (input) => {
      if (!input) return fullChoices
      const q = input.toLowerCase()
      const filtered = providerChoices.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.value.providerName.toLowerCase().includes(q) ||
          (c.value.tag && c.value.tag.toLowerCase().includes(q))
      )
      if (filtered.length === 0) {
        const backMatch =
          '← back to model selection'.includes(q) ||
          'back'.includes(q)
        return backMatch ? [backChoice] : []
      }
      return filtered
    },
  })

  return answer
}

const FULL_EFFORT_LIST = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']

export function getEffortLabel(effort) {
  if (effort == null) return EFFORT_LABELS.none
  return EFFORT_LABELS[effort] || effort
}

export async function selectReasoningEffort(reasoning, lastEffort) {
  if (!reasoning || reasoning.supportsEffort === false) return undefined

  const mandatory = reasoning.mandatory === true
  const efforts = mandatory
    ? (reasoning.supported_efforts || FULL_EFFORT_LIST).filter((e) => e !== 'none')
    : [...(reasoning.supported_efforts || FULL_EFFORT_LIST)]

  if (!mandatory && !efforts.includes('none')) {
    efforts.push('none')
  }

  const noneIdx = efforts.indexOf('none')
  if (noneIdx > 0) {
    efforts.splice(noneIdx, 1)
    efforts.unshift('none')
  }

  if (efforts.length === 0) return undefined

  let defaultEffort =
    lastEffort ??
    (reasoning.default_enabled === false ? null : reasoning.default_effort) ??
    'medium'
  if (defaultEffort === 'none') defaultEffort = null

  const answer = await select({
    message: 'Select reasoning effort:',
    choices: efforts.map((e) => ({
      name: getEffortLabel(e),
      value: e === 'none' ? null : e,
    })),
    default: defaultEffort,
  })

  return answer
}

export function resolveReasoningFlag({ reasoningEffort }) {
  if (reasoningEffort === 'none') return null
  return reasoningEffort
}

export function validateTemperature(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TEMPERATURE
}

export function resolveTemperatureFlag({ temperature } = {}) {
  if (temperature === undefined || temperature === null || temperature === '') return undefined
  const num = Number(temperature)
  if (!Number.isFinite(num) || num < 0 || num > MAX_TEMPERATURE) {
    throw new Error(`Temperature must be a number between 0 and ${MAX_TEMPERATURE}.`)
  }
  return num
}

export function resolveWebResultsFlag({ webResults } = {}) {
  if (webResults === undefined || webResults === null || webResults === '') return undefined
  const num = Number(webResults)
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error('--web-results must be a positive integer.')
  }
  return num
}
