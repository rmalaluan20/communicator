import { requireRole } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadAiSettings, publicAi, resolveAi, normalizeAiInput } from '@/lib/ai'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireRole(['admin'])
  if (error) return error
  const settings = await loadAiSettings()
  return Response.json(publicAi(settings))
}

export async function PUT(request) {
  const { error } = await requireRole(['admin'])
  if (error) return error
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid request body' }, { status: 400 }) }
  const { provider, model } = normalizeAiInput(body)
  const enabled = !!body.enabled
  const applyChecklist = !!body.applyChecklist
  const keyIn = typeof body.apiKey === 'string' ? body.apiKey.trim() : null
  try {
    if (keyIn) {
      await pool.query(
        `INSERT INTO ai_settings (id, provider, model, enabled, api_key, apply_checklist, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, now())
         ON CONFLICT (id) DO UPDATE SET
           provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           enabled = EXCLUDED.enabled,
           api_key = EXCLUDED.api_key,
           apply_checklist = EXCLUDED.apply_checklist,
           updated_at = now()`,
        [provider, model, enabled, keyIn, applyChecklist]
      )
    } else {
      await pool.query(
        `INSERT INTO ai_settings (id, provider, model, enabled, apply_checklist, updated_at)
         VALUES (1, $1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET
           provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           enabled = EXCLUDED.enabled,
           apply_checklist = EXCLUDED.apply_checklist,
           updated_at = now()`,
        [provider, model, enabled, applyChecklist]
      )
    }
    const settings = await loadAiSettings()
    return Response.json({ ok: true, ...publicAi(settings), resolved: resolveAi(settings).enabled })
  } catch (e) {
    return Response.json({ error: 'Could not save AI settings' }, { status: 503 })
  }
}
