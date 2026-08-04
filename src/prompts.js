import { search, select } from '@inquirer/prompts'
import { Separator } from '@inquirer/core'
import { EFFORT_LABELS } from './constants.js'
import { formatModelPrice } from './ui/format.js'
import { hyperlink } from './ui/hyperlink.js'
import { bold, dim } from './ui/style.js'

export const BACK_SENTINEL = Symbol('back')

export const pickerTheme = {
  style: {
    keysHelpTip: (keys) =>
      keys
        .map(([key, action]) => `${bold(key.replaceAll('↑↓', '↑ ↓'))} ${dim(action)}`)
        .join(dim(' • ')),
  },
}

export function orderModelChoices(models, lastModel) {
  const choices = models.map((m) => ({
    name: `${m.name}  (${m.id})`,
    value: { id: m.id, name: m.name },
    description: m.description || `${m.contextLength?.toLocaleString() || '?'} context`,
  }))

  if (lastModel) {
    const idx = choices.findIndex((c) => c.value.id === lastModel)
    if (idx >= 0) {
      const fav = choices[idx]
      return [fav, ...choices.filter((_, i) => i !== idx)]
    }
  }
  return choices
}

export function filterModelChoices(choices, input) {
  const q = input.toLowerCase()
  return choices.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.value.id.toLowerCase().includes(q)
  )
}

export function searchPrompt(message, choices, filter) {
  return search({
    message,
    theme: pickerTheme,
    source: async (input) => {
      if (!input) return choices
      return filter(choices, input)
    },
  })
}

export async function selectModel(models, lastModel, zdrOnly = false) {
  const choices = orderModelChoices(models, lastModel)
  return searchPrompt(zdrOnly ? 'Select a model (ZDR-capable only)' : 'Select a model', choices, filterModelChoices)
}

export function formatEndpointLabel(ep) {
  const priceText = formatModelPrice(ep.pricing?.prompt, ep.pricing?.completion)
  const uptime = ep.uptime30m != null ? `${ep.uptime30m.toFixed(0)}% uptime` : '?'
  const zdr = ep.zdr ? '  [zero retention]' : ''
  return `${ep.providerName}  —  ${priceText}  ${uptime}${zdr}`
}

export function formatEndpointDescription(ep) {
  const parts = []
  if (ep.tag) parts.push(`tag: ${ep.tag}`)
  if (ep.privacyPolicyURL) {
    const link = hyperlink(ep.privacyPolicyURL, 'privacy policy')
    if (link) parts.push(link)
  }
  return parts.length ? parts.join(' · ') : undefined
}

export async function selectProvider(endpoints, zdrOnly = false) {
  if (endpoints.length === 1) {
    const ep = endpoints[0]
    const priceText = formatModelPrice(ep.pricing?.prompt, ep.pricing?.completion)
    const zdr = ep.zdr ? ' [zero retention]' : ''
    console.log(`Only one provider available: ${ep.providerName}${zdr} (${priceText})`)
    return ep
  }

  const backChoice = {
    name: '← Back to model selection',
    value: BACK_SENTINEL,
    description: 'Return to the model picker',
  }

  const providerChoices = endpoints.map((ep) => ({
    name: formatEndpointLabel(ep),
    value: ep,
    description: formatEndpointDescription(ep),
  }))

  const fullChoices = [backChoice, new Separator(), ...providerChoices]

  return searchPrompt(
    zdrOnly
      ? `Select a provider (${endpoints.length} available, ZDR only)`
      : `Select a provider (${endpoints.length} available)`,
    fullChoices,
    (_, input) => {
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
    }
  )
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
    theme: pickerTheme,
    choices: efforts.map((e) => ({
      name: getEffortLabel(e),
      value: e === 'none' ? null : e,
    })),
    default: defaultEffort,
  })

  return answer
}
