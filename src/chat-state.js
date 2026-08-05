import { DEFAULT_TEMPERATURE } from './constants.js'
import { normalizeSmoothSpeed, normalizeWebSearchMode } from './flags.js'

export class ChatState {
  constructor({ modelId, endpointProviderName, reasoningEffort, temperature, budget, pricing, contextLength, supportsReasoning, webSearch, webResults, zdr = false, webSearchSupported, visionSupported, fileSupported, sessionId, createdAt, modelReasoning, markdown = true, smoothStreaming = true, smoothSpeed, messages, systemContent }) {
    this.modelId = modelId
    this.endpointProviderName = endpointProviderName
    this.reasoningEffort = reasoningEffort
    this.temperature = temperature
    this.budget = budget
    this.pricing = pricing
    this.contextLength = contextLength
    this.supportsReasoning = supportsReasoning
    this.webSearch = normalizeWebSearchMode(webSearch)
    this.webResults = webResults
    this.zdr = zdr === true
    this.webSearchSupported = webSearchSupported
    this.visionSupported = visionSupported
    this.fileSupported = fileSupported
    this.pendingAttachments = []
    this.sessionId = sessionId
    this.createdAt = createdAt
    this.modelReasoning = modelReasoning
    this.markdown = markdown
    this.smoothStreaming = smoothStreaming
    this.smoothSpeed = normalizeSmoothSpeed(smoothSpeed)
    this.systemContent = systemContent || 'You are a helpful assistant.'
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
      budget: this.budget,
      webSearch: this.webSearch,
      webResults: this.webResults,
      pricing: this.pricing,
      contextLength: this.contextLength,
      providerType,
    }
  }

  resetForNewSession(systemContent = this.systemContent) {
    this.messages = [{ role: 'system', content: systemContent }]
    this.budget = null
    this.webResults = null
    this.pendingAttachments = []
    return true
  }

  setTemperature(value) {
    this.temperature = value
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
    this.webSearchSupported = sel.webSearchSupported
    this.webSearch = sel.webSearchSupported === false ? 'off' : normalizeWebSearchMode(prefs.webSearch?.[sel.modelId])
    this.visionSupported = sel.visionSupported
    this.fileSupported = sel.fileSupported
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
