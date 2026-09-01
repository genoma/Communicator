import { fetchWithRetry, readJsonBounded } from '../http.js'
import { ApiError } from '../errors.js'

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
export const CACHE_TTL_MS = 5 * 60 * 1000

const zdrCache = { fetchedAt: 0, tags: null, modelIds: null, degraded: false }
const policiesCache = { fetchedAt: 0, policies: null }

const noRetry = () => new ApiError('metadata fetch failed', { retryable: false })

async function loadZdrIndex() {
  const res = await fetchWithRetry(`${OPENROUTER_BASE}/endpoints/zdr`, {}, { attempts: 1, errorResponse: noRetry })
  const { data } = await readJsonBounded(res)
  zdrCache.tags = new Set((data || []).map((e) => e.tag).filter(Boolean))
  zdrCache.modelIds = new Set((data || []).map((e) => e.model_id).filter(Boolean))
  zdrCache.fetchedAt = Date.now()
  zdrCache.degraded = false
  return zdrCache
}

async function loadPolicies() {
  const res = await fetchWithRetry(`${OPENROUTER_BASE}/providers`, {}, { attempts: 1, errorResponse: noRetry })
  const { data } = await readJsonBounded(res)
  const policies = new Map()
  for (const p of data || []) {
    if (p?.name && p.privacy_policy_url) {
      policies.set(p.name, {
        privacyPolicyURL: p.privacy_policy_url,
        termsOfServiceURL: p.terms_of_service_url || null,
      })
    }
  }
  policiesCache.policies = policies
  policiesCache.fetchedAt = Date.now()
  return policies
}

export async function getZdrIndex() {
  if (zdrCache.tags && Date.now() - zdrCache.fetchedAt < CACHE_TTL_MS) return zdrCache
  try {
    return await loadZdrIndex()
  } catch {
    // non-fatal: degrade to untagged
    zdrCache.tags = new Set()
    zdrCache.modelIds = new Set()
    zdrCache.fetchedAt = Date.now()
    zdrCache.degraded = true
    return zdrCache
  }
}

export async function getProviderPolicies() {
  if (policiesCache.policies && Date.now() - policiesCache.fetchedAt < CACHE_TTL_MS) return policiesCache.policies
  try {
    return await loadPolicies()
  } catch {
    // non-fatal: degrade to no links
    policiesCache.policies = new Map()
    policiesCache.fetchedAt = Date.now()
    return policiesCache.policies
  }
}

export function resetMetadataCaches() {
  zdrCache.fetchedAt = 0
  zdrCache.tags = null
  zdrCache.modelIds = null
  zdrCache.degraded = false
  policiesCache.fetchedAt = 0
  policiesCache.policies = null
}
