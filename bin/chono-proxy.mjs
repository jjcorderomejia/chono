#!/usr/bin/env node
/**
 * Chono proxy — sits between Claudex and DeepSeek API.
 * Handles:
 *   1. reasoning_content: stores it from responses, injects it back into
 *      conversation history on subsequent requests (DeepSeek V4 Pro requirement)
 *   2. Model name mapping: Claude aliases → DeepSeek model IDs
 */

import http from 'http'
import https from 'https'

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const DEEPSEEK_KEY  = process.env.DEEPSEEK_API_KEY ?? ''
const PORT          = parseInt(process.env.CHONO_PROXY_PORT ?? '4799')

const MODEL_MAP = {
  // Claude aliases → DeepSeek
  'claude-opus-4-7':              'deepseek-v4-pro',
  'claude-opus-4-6':              'deepseek-v4-pro',
  'claude-sonnet-4-6':            'deepseek-v4-flash',
  'claude-sonnet-4-5':            'deepseek-v4-flash',
  'claude-haiku-4-5-20251001':    'deepseek-v4-flash',
  'opus':                         'deepseek-v4-pro',
  'sonnet':                       'deepseek-v4-flash',
  'haiku':                        'deepseek-v4-flash',
}

// content → reasoning_content (keyed by assistant message content string)
const reasoningStore = new Map()

function resolveModel(model) {
  return MODEL_MAP[model] ?? model
}

function injectReasoning(messages) {
  return messages.map(msg => {
    if (msg.role !== 'assistant') return msg
    const rc = reasoningStore.get(msg.content)
    if (!rc) return msg
    return { ...msg, reasoning_content: rc }
  })
}

function storeReasoning(choices) {
  for (const choice of choices ?? []) {
    const msg = choice.message ?? choice.delta
    if (msg?.role === 'assistant' && msg.reasoning_content && msg.content) {
      reasoningStore.set(msg.content, msg.reasoning_content)
    }
  }
}

async function forward(body) {
  const payload = {
    ...body,
    model:    resolveModel(body.model),
    messages: injectReasoning(body.messages ?? []),
  }

  const url = new URL('/v1/chat/completions', DEEPSEEK_BASE)
  const isHttps = url.protocol === 'https:'
  const lib = isHttps ? https : http

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${DEEPSEEK_KEY}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let raw = ''
      res.on('data', chunk => raw += chunk)
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  let raw = ''
  req.on('data', chunk => raw += chunk)
  req.on('end', async () => {
    try {
      const body = JSON.parse(raw)
      const result = await forward(body)

      // Store reasoning_content from successful responses
      if (result.status === 200) {
        try {
          const parsed = JSON.parse(result.body)
          storeReasoning(parsed.choices)
        } catch {}
      }

      res.writeHead(result.status, { 'Content-Type': 'application/json' })
      res.end(result.body)
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }))
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`chono-proxy listening on 127.0.0.1:${PORT}\n`)
})
