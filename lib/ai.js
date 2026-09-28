import { pool } from '@/lib/db'

export const CLOUDFLARE_MODEL = '@cf/openai/gpt-oss-120b'

export async function loadAiSettings() {
  try {
    const { rows } = await pool.query(
      'SELECT provider, model, enabled, api_key, apply_checklist, updated_at FROM ai_settings WHERE id = 1'
    )
    return rows[0] || null
  } catch (e) {
    return null
  }
}

export function resolveAi(settings) {
  const requested = (settings && settings.provider) || process.env.AI_PROVIDER || 'openai'
  const provider = requested === 'cloudflare' ? 'cloudflare' : 'openai'
  const envKey = provider === 'cloudflare'
    ? (process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY || '')
    : (process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '')
  const savedKey = settings && settings.api_key ? String(settings.api_key) : ''
  const apiKey = envKey || savedKey
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()
  const fallbackModel = provider === 'cloudflare' ? CLOUDFLARE_MODEL : 'gpt-4o-mini'
  let model = (settings && settings.model) || process.env.AI_MODEL || fallbackModel
  if (provider === 'cloudflare' && (!model || model === 'gpt-4o-mini')) model = CLOUDFLARE_MODEL
  const hasConnection = provider === 'cloudflare' ? !!(apiKey && accountId) : !!apiKey
  const turnedOn = settings ? !!settings.enabled : hasConnection
  return {
    provider,
    model,
    apiKey,
    accountId,
    enabled: hasConnection && turnedOn,
    hasKey: !!apiKey,
    hasAccount: provider !== 'cloudflare' || !!accountId,
    source: envKey ? 'environment' : savedKey ? 'saved' : null,
    applyChecklist: !!(settings && settings.apply_checklist),
  }
}

export function publicAi(settings) {
  const r = resolveAi(settings)
  return {
    provider: r.provider,
    model: r.model,
    enabled: settings ? !!settings.enabled : false,
    hasKey: r.hasKey,
    hasAccount: r.hasAccount,
    source: r.source,
    applyChecklist: r.applyChecklist,
    connected: r.enabled,
  }
}

export function normalizeAiInput(body) {
  const provider = body && body.provider === 'cloudflare' ? 'cloudflare' : 'openai'
  let model = String((body && body.model) || '').trim()
  if (provider === 'cloudflare') {
    if (!model || model === 'gpt-4o-mini' || !/^@cf\/[A-Za-z0-9._/-]+$/.test(model)) model = CLOUDFLARE_MODEL
    model = model.slice(0, 160)
  } else {
    model = (model || 'gpt-4o-mini').slice(0, 80)
  }
  return { provider, model }
}

function cloudflareText(body) {
  const result = body && body.result !== undefined ? body.result : body
  if (!result) return ''
  if (typeof result === 'string') return result
  if (typeof result.response === 'string') return result.response
  const choice = result.choices && result.choices[0]
  const content = choice && choice.message && choice.message.content
  if (typeof content === 'string') return content
  if (typeof result.output === 'string') return result.output
  return ''
}

function asJsonText(text) {
  const trimmed = String(text || '').trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = (fenced ? fenced[1] : trimmed).trim()
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const first = parsed.find((item) => item && typeof item === 'object' && !Array.isArray(item))
      if (first) return JSON.stringify(first)
    }
  } catch (e) {}
  return raw
}

async function postJson(url, headers, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}))
  return { res, body }
}

function failed(body, status, fallback) {
  const cf = body && body.errors && body.errors[0] && body.errors[0].message
  const openai = body && body.error && body.error.message
  const err = new Error(cf || openai || fallback)
  err.status = status
  return err
}

async function completeCloudflare({ apiKey, accountId, model, system, user, json }) {
  if (!/^[a-f0-9]{32}$/i.test(accountId || '')) {
    const err = new Error('Cloudflare account id is not configured.')
    err.status = 400
    throw err
  }
  if (!/^@cf\/[A-Za-z0-9._/-]+$/.test(model || '')) {
    const err = new Error('Cloudflare model name is not valid.')
    err.status = 400
    throw err
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: json ? 1600 : 2000,
  }
  if (json) payload.response_format = { type: 'json_object' }
  let { res, body } = await postJson(url, headers, payload)
  if (json && (!res.ok || body.success === false)) {
    delete payload.response_format
    ;({ res, body } = await postJson(url, headers, payload))
  }
  if (!res.ok || body.success === false) throw failed(body, res.status, 'AI request failed')
  const text = cloudflareText(body)
  return json ? asJsonText(text) : String(text || '').trim()
}

async function completeOpenAI({ apiKey, model, system, user, json }) {
  const { res, body } = await postJson('https://api.openai.com/v1/chat/completions', {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }, {
    model: model || 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  })
  if (!res.ok) throw failed(body, res.status, 'AI request failed')
  const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content
  return String(text || '').trim()
}

export async function completeText({ apiKey, model, system, user, json, provider, accountId }) {
  if (provider === 'cloudflare') {
    return completeCloudflare({ apiKey, model, system, user, json, accountId })
  }
  return completeOpenAI({ apiKey, model, system, user, json })
}
