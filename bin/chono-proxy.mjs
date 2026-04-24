#!/usr/bin/env node
/**
 * Chono proxy — sits between Claudex and DeepSeek API.
 * Handles:
 *   1. reasoning_content: accumulates across SSE stream chunks, stores complete
 *      pair at end, injects back into conversation history on next request
 *   2. Model name mapping: Claude aliases → DeepSeek model IDs
 */

import http from 'http'
import https from 'https'

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const DEEPSEEK_KEY  = process.env.DEEPSEEK_API_KEY ?? ''
const PORT          = parseInt(process.env.CHONO_PROXY_PORT ?? '4799')

const MODEL_MAP = {
  'claude-opus-4-7':           'deepseek-v4-pro',
  'claude-opus-4-6':           'deepseek-v4-pro',
  'claude-sonnet-4-6':         'deepseek-v4-flash',
  'claude-sonnet-4-5':         'deepseek-v4-flash',
  'claude-haiku-4-5-20251001': 'deepseek-v4-flash',
  'opus':                      'deepseek-v4-pro',
  'sonnet':                    'deepseek-v4-flash',
  'haiku':                     'deepseek-v4-flash',
}

// full assistant content → full reasoning_content
const reasoningStore = new Map()

function resolveModel(model) {
  return MODEL_MAP[model] ?? model
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('')
  }
  return ''
}

function injectReasoning(messages) {
  return messages.map(msg => {
    if (msg.role !== 'assistant' || !msg.content) return msg
    const key = extractText(msg.content)
    const rc = reasoningStore.get(key)
    process.stderr.write(`[proxy] assistant msg key="${key.slice(0,60)}..." store_size=${reasoningStore.size} hit=${!!rc}\n`)
    if (!rc) return msg
    return { ...msg, reasoning_content: rc }
  })
}

function buildPayload(body) {
  return JSON.stringify({
    ...body,
    model:    resolveModel(body.model),
    messages: injectReasoning(body.messages ?? []),
  })
}

function makeRequest(data, opts) {
  const url = new URL('/v1/chat/completions', DEEPSEEK_BASE)
  const isHttps = url.protocol === 'https:'
  const lib = isHttps ? https : http
  return lib.request({
    hostname: url.hostname,
    port:     url.port || (isHttps ? 443 : 80),
    path:     url.pathname,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Authorization':  `Bearer ${DEEPSEEK_KEY}`,
      'Content-Length': Buffer.byteLength(data),
      ...(opts.streaming ? { 'Accept': 'text/event-stream' } : {}),
    },
  })
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  let rawReq = ''
  req.on('data', chunk => rawReq += chunk)
  req.on('end', () => {
    let body
    try { body = JSON.parse(rawReq) } catch (e) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: { message: 'Bad JSON', type: 'proxy_error' } }))
      return
    }

    const streaming = !!body.stream
    const data = buildPayload(body)
    const upstream = makeRequest(data, { streaming })

    upstream.on('response', upRes => {
      // Forward headers
      res.writeHead(upRes.statusCode, {
        'Content-Type': upRes.headers['content-type'] ?? 'application/json',
      })

      if (!streaming) {
        // Non-streaming: buffer, store reasoning, forward
        let raw = ''
        upRes.on('data', chunk => raw += chunk)
        upRes.on('end', () => {
          if (upRes.statusCode === 200) {
            try {
              const parsed = JSON.parse(raw)
              const msg = parsed.choices?.[0]?.message
              if (msg?.role === 'assistant' && msg.reasoning_content && msg.content) {
                reasoningStore.set(msg.content, msg.reasoning_content)
              }
            } catch {}
          }
          res.end(raw)
        })
        return
      }

      // Streaming: pass through chunks in real time, accumulate for storage
      let accContent = ''
      let accReasoning = ''

      upRes.on('data', chunk => {
        const text = chunk.toString()
        res.write(chunk) // pass through immediately

        // Parse SSE lines to accumulate content + reasoning
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue
          const json = line.slice(5).trim()
          if (json === '[DONE]') {
            // Stream ended — store the complete pair
            if (accContent && accReasoning) {
              reasoningStore.set(accContent, accReasoning)
            }
            continue
          }
          try {
            const evt = JSON.parse(json)
            const delta = evt.choices?.[0]?.delta
            if (delta?.content)           accContent   += delta.content
            if (delta?.reasoning_content) accReasoning += delta.reasoning_content
          } catch {}
        }
      })

      upRes.on('end', () => {
        // Final store in case [DONE] wasn't in last chunk
        if (accContent && accReasoning) {
          reasoningStore.set(accContent, accReasoning)
        }
        res.end()
      })
    })

    upstream.on('error', err => {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }))
    })

    upstream.write(data)
    upstream.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`chono-proxy listening on 127.0.0.1:${PORT}\n`)
})
