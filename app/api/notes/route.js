import { pool } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { writeActivity } from '@/lib/activity'

export const dynamic = 'force-dynamic'

// GET /api/notes — all notes (any signed-in user can read).
export async function GET() {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    const { rows } = await pool.query(
      'SELECT id, account_id, text, author, created_at FROM notes ORDER BY created_at ASC, id ASC'
    )
    return Response.json({ notes: rows })
  } catch (e) {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
}

// POST /api/notes — add a note (allowed for BOTH owner and invited members).
// This is the only mutation members are permitted; it cannot change anything
// other than appending a note.
export async function POST(request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 })
  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const accountId = String(body.accountId || '').trim()
  let text = String(body.text || '').trim()
  if (!accountId) return Response.json({ error: 'accountId required' }, { status: 400 })
  if (!text) return Response.json({ error: 'Note text required' }, { status: 400 })
  if (text.length > 2000) text = text.slice(0, 2000)

  const author = user.name || user.email || 'Unknown'
  try {
    const { rows } = await pool.query(
      `INSERT INTO notes (account_id, text, author, author_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, account_id, text, author, created_at`,
      [accountId, text, author, Number.isInteger(user.uid) ? user.uid : null]
    )
    // Keep the guest's audit row fresh so the owner sees recent activity.
    if (user.guest && user.sid) {
      try {
        await pool.query('UPDATE guest_sessions SET last_seen_at = now() WHERE sid = $1', [user.sid])
      } catch (e) {}
    }
    await writeActivity({
      user,
      accountId,
      type: 'note_added',
      description: 'Note added',
      metadata: { noteId: rows[0].id },
    })
    return Response.json({ ok: true, note: rows[0] })
  } catch (e) {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
}
