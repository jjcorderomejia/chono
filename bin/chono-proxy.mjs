#!/usr/bin/env node
/**
 * Chono proxy — sits between Claudex and DeepSeek API.
 * Handles:
 *   1. reasoning_content: stores per assistant turn in order, injects back
 *      positionally on next request (works even for empty-content tool-call msgs)
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

// Ordered list of reasoning_content, one entry per assistant turn in session order.
// Injected positionally: the nth assistant message in history gets reasoningList[n].
const reasoningList = []

function resolveModel(model) {
  return MODEL_MAP[model] ?? model
}

function injectReasoning(messages) {
  let aIdx = 0
  return messages.map(msg => {
    if (msg.role !== 'assistant') return msg
    const entry = reasoningList[aIdx]
    process.stderr.write(`[proxy] inject aIdx=${aIdx} has_entry=${!!entry}\n`)
    aIdx++
    if (!entry) return msg
    return { ...msg, reasoning_content: entry }
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
    try { body = JSON.parse(rawReq) } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: { message: 'Bad JSON', type: 'proxy_error' } }))
      return
    }

    const streaming = !!body.stream
    const data = buildPayload(body)
    const upstream = makeRequest(data, { streaming })

    upstream.on('response', upRes => {
      res.writeHead(upRes.statusCode, {
        'Content-Type': upRes.headers['content-type'] ?? 'application/json',
      })

      if (!streaming) {
        let raw = ''
        upRes.on('data', chunk => raw += chunk)
        upRes.on('end', () => {
          if (upRes.statusCode === 200) {
            try {
              const parsed = JSON.parse(raw)
              const msg = parsed.choices?.[0]?.message
              if (msg?.reasoning_content) {
                reasoningList.push(msg.reasoning_content)
                process.stderr.write(`[proxy] stored reasoning[${reasoningList.length - 1}] (non-stream) len=${msg.reasoning_content.length}\n`)
              }
            } catch {}
          }
          res.end(raw)
        })
        return
      }

      // Streaming: pass through in real time, accumulate for storage
      let accReasoning = ''

      upRes.on('data', chunk => {
        res.write(chunk)
        for (const line of chunk.toString().split('\n')) {
          if (!line.startsWith('data:')) continue
          const json = line.slice(5).trim()
          if (json === '[DONE]') continue
          try {
            const delta = JSON.parse(json).choices?.[0]?.delta
            if (delta?.reasoning_content) accReasoning += delta.reasoning_content
          } catch {}
        }
      })

      upRes.on('end', () => {
        if (accReasoning) {
          reasoningList.push(accReasoning)
          process.stderr.write(`[proxy] stored reasoning[${reasoningList.length - 1}] len=${accReasoning.length}\n`)
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
