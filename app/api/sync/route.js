import { getSessionUser } from '@/lib/auth'
import { pool } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    const { rows } = await pool.query('SELECT updated_at FROM sync_signal WHERE id = 1')
    return Response.json({ at: rows[0] ? rows[0].updated_at : null })
  } catch (e) {
    return Response.json({ at: null })
  }
}
