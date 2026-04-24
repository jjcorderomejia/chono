/**
 * NVIDIA AI provider for Claudex.
 *
 * Routes requests to NVIDIA's OpenAI-compatible inference API at
 * https://integrate.api.nvidia.com/v1
 *
 * Uses the existing OpenAI shim — NVIDIA's endpoint is fully
 * OpenAI-compatible, so no translation layer is needed.
 *
 * Environment variables:
 *   CLAUDE_CODE_USE_NVIDIA=1          — enable this provider
 *   NVIDIA_API_KEY=nvapi-...          — your NVIDIA API key
 *   NVIDIA_MODEL=moonshotai/kimi-k2-instruct  — model override
 *   NVIDIA_BASE_URL=https://...       — endpoint override (optional)
 */

export const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
export const DEFAULT_NVIDIA_MODEL = 'moonshotai/kimi-k2-instruct'

/** Well-known NVIDIA NIM models with their capabilities */
export const NVIDIA_MODELS = {
  // Reasoning / flagship
  'moonshotai/kimi-k2-instruct': { tier: 'large', description: 'Kimi K2 — strong reasoning & coding' },
  'nvidia/llama-3.1-nemotron-ultra-253b-v1': { tier: 'large', description: 'Nemotron Ultra 253B' },
  'nvidia/llama-3.3-nemotron-super-49b-v1': { tier: 'large', description: 'Nemotron Super 49B' },
  'meta/llama-3.1-405b-instruct': { tier: 'large', description: 'Llama 3.1 405B' },
  'meta/llama-3.3-70b-instruct': { tier: 'medium', description: 'Llama 3.3 70B' },
  // Fast / small
  'meta/llama-3.1-8b-instruct': { tier: 'small', description: 'Llama 3.1 8B — fast' },
  'mistralai/mistral-large-2-instruct': { tier: 'large', description: 'Mistral Large 2' },
  'mistralai/mixtral-8x22b-instruct-v0.1': { tier: 'large', description: 'Mixtral 8x22B' },
  'google/gemma-3-27b-it': { tier: 'medium', description: 'Gemma 3 27B' },
  'deepseek-ai/deepseek-r1': { tier: 'large', description: 'DeepSeek R1 — reasoning' },
  'qwen/qwen3-235b-a22b': { tier: 'large', description: 'Qwen3 235B MoE' },
} as const

export type NvidiaModelId = keyof typeof NVIDIA_MODELS

export function getNvidiaApiBaseUrl(baseUrl?: string): string {
  return (baseUrl || process.env.NVIDIA_BASE_URL || DEFAULT_NVIDIA_BASE_URL).replace(/\/+$/, '')
}

export function getNvidiaModel(): string {
  return process.env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL
}

export function getNvidiaApiKey(): string | undefined {
  return process.env.NVIDIA_API_KEY
}

/** Check if the NVIDIA endpoint is reachable */
export async function hasNvidiaAccess(baseUrl?: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const apiKey = getNvidiaApiKey()
    const headers: Record<string, string> = {}
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const response = await fetch(`${getNvidiaApiBaseUrl(baseUrl)}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    // 200 = ok, 401 = reachable but bad key — both mean the endpoint is up
    return response.status === 200 || response.status === 401
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

/** List available NVIDIA NIM models from the API */
export async function listNvidiaModels(baseUrl?: string): Promise<string[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const apiKey = getNvidiaApiKey()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const response = await fetch(`${getNvidiaApiBaseUrl(baseUrl)}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    if (!response.ok) return []

    const data = (await response.json()) as { data?: Array<{ id?: string }> }
    return (data.data ?? []).filter(m => Boolean(m.id)).map(m => m.id!)
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}

/** Build the env block for a NVIDIA profile */
export function buildNvidiaProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  processEnv?: Record<string, string | undefined>
}): { CLAUDE_CODE_USE_NVIDIA: string; NVIDIA_BASE_URL: string; NVIDIA_MODEL: string; NVIDIA_API_KEY?: string } | null {
  const processEnv = options.processEnv ?? (typeof process !== 'undefined' ? process.env : {})
  const key = options.apiKey ?? processEnv['NVIDIA_API_KEY'] ?? processEnv['OPENAI_API_KEY']
  if (!key) return null

  return {
    CLAUDE_CODE_USE_NVIDIA: '1',
    NVIDIA_BASE_URL: options.baseUrl ?? processEnv['NVIDIA_BASE_URL'] ?? DEFAULT_NVIDIA_BASE_URL,
    NVIDIA_MODEL: options.model ?? processEnv['NVIDIA_MODEL'] ?? DEFAULT_NVIDIA_MODEL,
    NVIDIA_API_KEY: key,
  }
}
