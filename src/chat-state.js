import { DEFAULT_TEMPERATURE } from './constants.js'

export class ChatState {
  constructor({ modelId, endpointProviderName, reasoningEffort, temperature, budget, pricing, supportsReasoning, webSearch, webResults, webSearchSupported, sessionId, createdAt, modelReasoning, markdown = true, messages, systemContent }) {
    this.modelId = modelId
    this.endpointProviderName = endpointProviderName
    this.reasoningEffort = reasoningEffort
    this.temperature = temperature
    this.budget = budget
    this.pricing = pricing
    this.supportsReasoning = supportsReasoning
    this.webSearch = webSearch
    this.webResults = webResults
    this.webSearchSupported = webSearchSupported
    this.sessionId = sessionId
    this.createdAt = createdAt
    this.modelReasoning = modelReasoning
    this.markdown = markdown
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
      providerType,
    }
  }

  resetForNewSession(systemContent = this.systemContent) {
    this.messages = [{ role: 'system', content: systemContent }]
    this.budget = null
    this.webResults = null
    return true
  }

  setTemperature(value) {
    this.temperature = value
  }

  setBudget(value) {
    this.budget = value
  }

  setWebSearch(value) {
    this.webSearch = value
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
    this.reasoningEffort = sel.reasoningEffort
    this.supportsReasoning = sel.supportsReasoning
    this.modelReasoning = sel.modelReasoning
    this.temperature = prefs.temperature?.[sel.modelId] ?? DEFAULT_TEMPERATURE
    this.webSearchSupported = sel.webSearchSupported
    this.webSearch = sel.webSearchSupported === false ? false : (prefs.webSearch?.[sel.modelId] ?? false)
  }

  toggleMarkdown() {
    this.markdown = !this.markdown
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
