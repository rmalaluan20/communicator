import { getSessionUser } from '@/lib/auth'
import { pool } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 })
  const accountId = (new URL(request.url).searchParams.get('accountId') || '').trim()
  try {
    const { rows } = accountId
      ? await pool.query(
          `SELECT id, subaccount_id, created_at, auditor, overall, completion, verified, incomplete, blocked, needs_review, unable, summary
           FROM audits WHERE subaccount_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30`,
          [accountId]
        )
      : await pool.query(
          `SELECT id, subaccount_id, created_at, auditor, overall, completion, verified, incomplete, blocked, needs_review, unable, summary
           FROM audits ORDER BY created_at DESC, id DESC LIMIT 30`
        )
    return Response.json({ audits: rows })
  } catch (e) {
    return Response.json({ audits: [] })
  }
}
