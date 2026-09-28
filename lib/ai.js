import { pool } from '@/lib/db'

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
  const envKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || ''
  const savedKey = settings && settings.api_key ? String(settings.api_key) : ''
  const apiKey = envKey || savedKey
  const provider = (settings && settings.provider) || 'openai'
  const model = (settings && settings.model) || process.env.AI_MODEL || 'gpt-4o-mini'
  const enabled = settings ? settings.enabled !== false && !!apiKey : !!apiKey
  return {
    provider,
    model,
    apiKey,
    enabled: !!apiKey && enabled,
    hasKey: !!apiKey,
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
    source: r.source,
    applyChecklist: r.applyChecklist,
    connected: r.enabled,
  }
}

export async function completeText({ apiKey, model, system, user, json }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = (body && body.error && body.error.message) || 'AI request failed'
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content
  return String(text || '').trim()
}
