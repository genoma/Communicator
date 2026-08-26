import { DEFAULT_SYSTEM_PROMPT } from './constants.js'
import { normalizeSmoothSpeed, normalizeWebSearchMode } from './flags.js'

export class ChatState {
  constructor({ modelId, endpointProviderName, reasoningEffort, temperature, topP, budget, pricing, contextLength, supportsReasoning, webSearch, webResults, zdr = false, e2ee = false, e2eeContext = null, webSearchSupported, visionSupported, fileSupported, imageOutputSupported, sessionId, createdAt, updatedAt = null, modelReasoning, reasoningMandatory, markdown = true, smoothStreaming = true, smoothSpeed, compactThinking = false, messages, systemContent, scrapes = 0 }) {
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
    // The user turn that failed with a retryable error: popped from
    // `messages` (so it is never re-sent silently with the next prompt) but
    // preserved here, attachments included, for /retry. Never persisted.
    this.retryTurn = null
    this.sessionId = sessionId
    this.createdAt = createdAt
    this.updatedAt = updatedAt
    this.modelReasoning = modelReasoning
    this.reasoningMandatory = reasoningMandatory === true || modelReasoning?.mandatory === true
    this.markdown = markdown
    this.smoothStreaming = smoothStreaming
    this.smoothSpeed = normalizeSmoothSpeed(smoothSpeed)
    this.compactThinking = compactThinking === true
    this.scrapes = scrapes
    this.systemContent = systemContent || DEFAULT_SYSTEM_PROMPT
    this.messages = messages || [{ role: 'system', content: this.systemContent }]
  }

  toFinalState(providerType) {
    return {
      messages: this.messages,
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
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
      reasoningMandatory: this.reasoningMandatory,
      webSearchSupported: this.webSearchSupported,
      visionSupported: this.visionSupported,
      fileSupported: this.fileSupported,
      imageOutputSupported: this.imageOutputSupported,
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
    this.updatedAt = null
    this.pendingAttachments = []
    this.retryTurn = null
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
    this.reasoningMandatory = sel.modelReasoning?.mandatory === true
    this.temperature = prefs.temperature?.[sel.modelId]
    this.topP = prefs.topP?.[sel.modelId]
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

  setCompactThinking(value) {
    this.compactThinking = value === true
  }

  appendUser(content) {
    this.messages.push({ role: 'user', content })
    // A sent message is the activity signal: updatedAt is only bumped when
    // new turn content is actually added, never by resuming alone.
    this.updatedAt = new Date().toISOString()
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
