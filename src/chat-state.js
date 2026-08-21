import { DEFAULT_TEMPERATURE, DEFAULT_TOP_P, DEFAULT_SYSTEM_PROMPT } from './constants.js'
import { normalizeSmoothSpeed, normalizeWebSearchMode } from './flags.js'

export class ChatState {
  constructor({ modelId, endpointProviderName, reasoningEffort, temperature, topP = DEFAULT_TOP_P, budget, pricing, contextLength, supportsReasoning, webSearch, webResults, zdr = false, e2ee = false, e2eeContext = null, webSearchSupported, visionSupported, fileSupported, imageOutputSupported, sessionId, createdAt, modelReasoning, markdown = true, smoothStreaming = true, smoothSpeed, messages, systemContent, scrapes = 0 }) {
    this.modelId = modelId
    this.endpointProviderName = endpointProviderName
    this.reasoningEffort = reasoningEffort
    this.temperature = temperature
    this.topP = topP
    this.budget = budget
    this.pricing = pricing
    this.contextLength = contextLength
    this.supportsReasoning = supportsReasoning
    this.webSearch = e2ee ? 'off' : normalizeWebSearchMode(webSearch)
    this.webResults = e2ee ? null : webResults
    this.zdr = zdr === true
    this.e2ee = e2ee === true
    // Session-scoped E2EE crypto state: client key pair plus the attested
    // model public key. Never serialized; modelPubKeyHex is refreshed when
    // the active model changes via /model.
    this.e2eeContext = this.e2ee ? e2eeContext : null
    this.webSearchSupported = webSearchSupported
    this.visionSupported = visionSupported
    this.fileSupported = fileSupported
    this.imageOutputSupported = imageOutputSupported
    this.pendingAttachments = []
    this.sessionId = sessionId
    this.createdAt = createdAt
    this.modelReasoning = modelReasoning
    this.markdown = markdown
    this.smoothStreaming = smoothStreaming
    this.smoothSpeed = normalizeSmoothSpeed(smoothSpeed)
    this.scrapes = scrapes
    this.systemContent = systemContent || DEFAULT_SYSTEM_PROMPT
    this.messages = messages || [{ role: 'system', content: this.systemContent }]
  }

  toFinalState(providerType) {
    return {
      messages: this.messages,
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      modelId: this.modelId,
      endpointProviderName: this.endpointProviderName,
      reasoningEffort: this.reasoningEffort,
      temperature: this.temperature,
      topP: this.topP,
      budget: this.budget,
      webSearch: this.webSearch,
      webResults: this.webResults,
      pricing: this.pricing,
      contextLength: this.contextLength,
      supportsReasoning: this.supportsReasoning,
      webSearchSupported: this.webSearchSupported,
      e2ee: this.e2ee,
      scrapes: this.scrapes,
      providerType,
    }
  }

  resetForNewSession(systemContent = this.systemContent) {
    this.messages = [{ role: 'system', content: systemContent }]
    this.budget = null
    this.webResults = null
    this.scrapes = 0
    this.pendingAttachments = []
    return true
  }

  setTemperature(value) {
    this.temperature = value
  }

  setTopP(value) {
    this.topP = value
  }

  setBudget(value) {
    this.budget = value
  }

  setWebSearch(value) {
    this.webSearch = normalizeWebSearchMode(value)
  }

  setWebResults(value) {
    this.webResults = value
  }

  setReasoningEffort(value) {
    this.reasoningEffort = value
  }

  applyModelSelection(sel, prefs) {
    this.modelId = sel.modelId
    this.endpointProviderName = sel.endpointProviderName
    this.pricing = sel.pricing
    this.contextLength = sel.contextLength
    this.reasoningEffort = sel.reasoningEffort
    this.supportsReasoning = sel.supportsReasoning
    this.modelReasoning = sel.modelReasoning
    this.temperature = prefs.temperature?.[sel.modelId] ?? DEFAULT_TEMPERATURE
    this.topP = prefs.topP?.[sel.modelId] ?? DEFAULT_TOP_P
    this.webSearchSupported = sel.webSearchSupported
    this.webSearch = this.e2ee ? 'off' : (sel.webSearchSupported === false ? 'off' : normalizeWebSearchMode(prefs.webSearch?.[sel.modelId]))
    this.visionSupported = sel.visionSupported
    this.fileSupported = sel.fileSupported
    this.imageOutputSupported = sel.imageOutputSupported
  }

  toggleMarkdown() {
    this.markdown = !this.markdown
  }

  setSmoothStreaming(value) {
    this.smoothStreaming = value
  }

  setSmoothSpeed(value) {
    this.smoothSpeed = normalizeSmoothSpeed(value)
  }

  appendUser(content) {
    this.messages.push({ role: 'user', content })
  }

  appendAssistant(message) {
    this.messages.push(message)
  }

  popLastMessage() {
    return this.messages.pop()
  }

  get lastAssistantMessage() {
    return [...this.messages].reverse().find((m) => m.role === 'assistant' && m.content)
  }
}
