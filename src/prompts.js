import { search, select } from '@inquirer/prompts'
import { Separator } from '@inquirer/core'
import { EFFORT_LABELS } from './constants.js'
import { formatModelPrice, formatImagePrice } from './ui/format.js'
import { hyperlink, sanitizeAnsi, sanitizeSingleLine } from './ui/hyperlink.js'
import { bold, dim } from './ui/style.js'

export const BACK_SENTINEL = Symbol('back')

export const BACK_CHOICE = {
  name: '← Back to model selection',
  value: BACK_SENTINEL,
  description: 'Return to the model picker',
}

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
    name: sanitizeSingleLine(`${m.name}  (${m.id})${m.visionSupported === true ? '  [vision]' : ''}`),
    value: { id: m.id, name: m.name },
    description: sanitizeAnsi(m.description || `${m.contextLength?.toLocaleString() || '?'} context`),
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
      c.name &&
      c.value?.id &&
      (c.name.toLowerCase().includes(q) || c.value.id.toLowerCase().includes(q))
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

export function orderImageModelChoices(models, lastImageModel) {
  const choices = models.map((m) => ({
    name: sanitizeSingleLine(`${m.name}  (${m.id})  [image]${m.offline === true ? '  [offline]' : ''}`),
    value: { id: m.id, name: m.name },
    description: sanitizeAnsi(m.description || m.id),
  }))

  if (lastImageModel) {
    const idx = choices.findIndex((c) => c.value.id === lastImageModel)
    if (idx >= 0) {
      const fav = choices[idx]
      return [fav, ...choices.filter((_, i) => i !== idx)]
    }
  }
  return choices
}

export async function selectImageModel(models, lastImageModel) {
  return searchPrompt('Select an image model', orderImageModelChoices(models, lastImageModel), filterModelChoices)
}

export function orderModelWithImages(textModels, imageModels, lastModel, lastImageModel) {
  const textChoices = orderModelChoices(textModels, lastModel)
  const imageChoices = orderImageModelChoices(imageModels, lastImageModel)

  if (lastImageModel) {
    const lastImg = imageChoices.find((c) => c.value.id === lastImageModel)
    if (lastImg) {
      return [
        lastImg,
        new Separator('Image models'),
        ...imageChoices.filter((c) => c.value.id !== lastImageModel),
        new Separator('Text models'),
        ...textChoices,
      ]
    }
  }

  return [
    ...textChoices,
    new Separator('Image models'),
    ...imageChoices,
  ]
}

export async function selectModelWithImages(textModels, imageModels, lastModel, lastImageModel, zdrOnly = false) {
  const choices = orderModelWithImages(textModels, imageModels, lastModel, lastImageModel)
  return searchPrompt(zdrOnly ? 'Select a model (ZDR-capable only)' : 'Select a model', choices, filterModelChoices)
}

export function formatEndpointLabel(ep) {
  const priceText = formatModelPrice(ep.pricing?.prompt, ep.pricing?.completion)
  const uptime = ep.uptime30m != null ? `${ep.uptime30m.toFixed(0)}% uptime` : '?'
  const zdr = ep.zdr ? '  [zero retention]' : ''
  return `${sanitizeSingleLine(ep.providerName)}  —  ${priceText}  ${uptime}${zdr}`
}

export function formatEndpointDescription(ep) {
  const parts = []
  if (ep.tag) parts.push(`tag: ${sanitizeSingleLine(ep.tag)}`)
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
    console.log(`Only one provider available: ${sanitizeSingleLine(ep.providerName)}${zdr} (${priceText})`)
    return ep
  }

  const providerChoices = endpoints.map((ep) => ({
    name: formatEndpointLabel(ep),
    value: ep,
    description: formatEndpointDescription(ep),
  }))

  return providerSearchPrompt(
    zdrOnly
      ? `Select a provider (${endpoints.length} available, ZDR only)`
      : `Select a provider (${endpoints.length} available)`,
    providerChoices,
    BACK_CHOICE,
    { withBack: true, filterFields: ['providerName', 'tag'] }
  )
}

export function formatImageEndpointLabel(ep) {
  return `${sanitizeSingleLine(ep.providerName)}  —  ${formatImagePrice(ep.pricing)}`
}

export async function selectImageProvider(endpoints, { withBack = false } = {}) {
  if (endpoints.length === 1) {
    const ep = endpoints[0]
    console.log(`Only one provider available: ${sanitizeSingleLine(ep.providerName)} (${formatImagePrice(ep.pricing)})`)
    return ep
  }

  const providerChoices = endpoints.map((ep) => ({
    name: formatImageEndpointLabel(ep),
    value: ep,
    description: ep.tag ? `tag: ${sanitizeSingleLine(ep.tag)}` : undefined,
  }))

  return providerSearchPrompt(
    `Select a provider (${endpoints.length} available)`,
    providerChoices,
    BACK_CHOICE,
    { withBack, filterFields: ['providerName', 'slug', 'tag'] }
  )
}

// Shared search-prompt machinery for provider pickers: back choice handling
// and the case-insensitive filter over the given endpoint fields.
function providerSearchPrompt(message, providerChoices, backChoice, { withBack, filterFields }) {
  const fullChoices = withBack ? [backChoice, new Separator(), ...providerChoices] : providerChoices
  return searchPrompt(message, fullChoices, (_, input) => {
    const q = input.toLowerCase()
    const filtered = providerChoices.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        filterFields.some((f) => (c.value[f] || '').toLowerCase().includes(q))
    )
    if (filtered.length === 0 && withBack) {
      const backMatch =
        '← back to model selection'.includes(q) ||
        'back'.includes(q)
      return backMatch ? [backChoice] : []
    }
    return filtered
  })
}

const FULL_EFFORT_LIST = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']

export function getEffortLabel(effort) {
  if (effort == null) return EFFORT_LABELS.none
  return EFFORT_LABELS[effort] || sanitizeSingleLine(effort)
}

export async function selectReasoningEffort(reasoning, lastEffort, opts = {}) {
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
  // The saved pref or provider default may not be in the model's current
  // effort list (list shrank, or 'none' is not offered); clamp to a valid
  // choice so the picker never receives an out-of-list default.
  if (defaultEffort === null && !efforts.includes('none')) {
    defaultEffort = efforts.includes('medium') ? 'medium' : efforts[0]
  } else if (defaultEffort !== null && !efforts.includes(defaultEffort)) {
    defaultEffort = efforts.includes('medium') ? 'medium' : efforts[0]
  }

  const effortChoices = efforts.map((e) => ({
    name: getEffortLabel(e),
    value: e === 'none' ? null : e,
  }))

  const choices = opts.withBack
    ? [
        BACK_CHOICE,
        new Separator(),
        ...effortChoices,
      ]
    : effortChoices

  const answer = await select({
    message: 'Select reasoning effort:',
    theme: pickerTheme,
    choices,
    default: defaultEffort,
  })

  return answer
}

const RATIO_LABELS = {
  '1:1': '1:1 (square)',
  '16:9': '16:9 (widescreen)',
  '9:16': '9:16 (vertical)',
  '3:2': '3:2 (photo)',
  '2:3': '2:3 (portrait photo)',
  '4:3': '4:3 (classic)',
  '3:4': '3:4 (portrait)',
  '4:5': '4:5 (social portrait)',
  '21:9': '21:9 (ultrawide)',
  auto: 'auto (provider decides)',
}

export function ratioLabel(value) {
  return RATIO_LABELS[value] || value
}

export async function selectSizingOption(message, values, defaultValue, labelFn = ratioLabel) {
  const choices = values.map((v) => ({ name: labelFn(v), value: v }))
  return select({
    message,
    theme: pickerTheme,
    choices,
    ...(defaultValue !== undefined && values.includes(defaultValue) ? { default: defaultValue } : {}),
  })
}
