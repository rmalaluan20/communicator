import { getSessionUser, requireRole } from '@/lib/auth'
import { pool } from '@/lib/db'
import { writeActivity } from '@/lib/activity'

export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 })
  const url = new URL(request.url)
  const accountId = (url.searchParams.get('accountId') || '').trim()
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 40))
  try {
    const { rows } = accountId
      ? await pool.query(
          `SELECT id, subaccount_id, activity_type, actor_type, actor_name, description, metadata, created_at
           FROM activity_log WHERE subaccount_id = $1
           ORDER BY created_at DESC, id DESC LIMIT $2`,
          [accountId, limit]
        )
      : await pool.query(
          `SELECT id, subaccount_id, activity_type, actor_type, actor_name, description, metadata, created_at
           FROM activity_log ORDER BY created_at DESC, id DESC LIMIT $1`,
          [limit]
        )
    return Response.json({ activities: rows })
  } catch (e) {
    return Response.json({ activities: [], error: 'unavailable' })
  }
}

export async function POST(request) {
  const { user, error } = await requireRole(['admin'])
  if (error) return error
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid request body' }, { status: 400 }) }
  const description = String(body.description || '').trim()
  if (!description) return Response.json({ error: 'description required' }, { status: 400 })
  const row = await writeActivity({
    user,
    accountId: body.accountId || null,
    type: body.type,
    description,
    metadata: body.metadata,
  })
  if (!row) return Response.json({ error: 'Could not record activity' }, { status: 503 })
  return Response.json({ ok: true, activity: row })
}
