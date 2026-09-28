import { getSessionUser } from '@/lib/auth'
import { pool } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_request, { params }) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 })
  const { id } = await params
  try {
    const { rows } = await pool.query(
      `SELECT id, subaccount_id, created_at, auditor, overall, completion, verified, incomplete, blocked, needs_review, unable, summary, result
       FROM audits WHERE id = $1`,
      [id]
    )
    if (!rows.length) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json({ audit: rows[0] })
  } catch (e) {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
}
