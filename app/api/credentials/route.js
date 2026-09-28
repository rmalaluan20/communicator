import { requireRole } from '@/lib/auth'
import { pool } from '@/lib/db'
import { saveCommunicatorToken, clearCommunicatorToken } from '@/lib/ghl'
import { writeActivity } from '@/lib/activity'

export const dynamic = 'force-dynamic'

function accountIdOf(value) {
  const id = String(value || '').trim()
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return ''
  return id
}

export async function GET(request) {
  const { error } = await requireRole(['admin'])
  if (error) return error
  const accountId = accountIdOf(new URL(request.url).searchParams.get('accountId'))
  if (!accountId) return Response.json({ error: 'accountId required' }, { status: 400 })
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM communicator_tokens WHERE subaccount_id = $1',
      [accountId]
    )
    return Response.json({ hasKey: rows.length > 0 })
  } catch (e) {
    return Response.json({ error: 'Could not read Communicator access' }, { status: 503 })
  }
}

export async function PUT(request) {
  const { user, error } = await requireRole(['admin'])
  if (error) return error
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid request body' }, { status: 400 }) }
  const accountId = accountIdOf(body.accountId)
  if (!accountId) return Response.json({ error: 'accountId required' }, { status: 400 })
  const clear = !!body.clear
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!clear && !apiKey) return Response.json({ error: 'Paste a token, or remove the saved one.' }, { status: 400 })
  if (apiKey.length > 2000) return Response.json({ error: 'That token is too long.' }, { status: 400 })
  try {
    if (clear || !apiKey) await clearCommunicatorToken(accountId)
    else await saveCommunicatorToken(accountId, apiKey)
    await writeActivity({
      user,
      accountId,
      type: 'link_updated',
      description: clear || !apiKey ? 'Communicator API token removed' : 'Communicator API token saved',
    })
    return Response.json({ ok: true, hasKey: !(clear || !apiKey) })
  } catch (e) {
    return Response.json({ error: 'Could not save the Communicator token' }, { status: 503 })
  }
}

export async function DELETE(request) {
  const { error } = await requireRole(['admin'])
  if (error) return error
  const accountId = accountIdOf(new URL(request.url).searchParams.get('accountId'))
  if (!accountId) return Response.json({ error: 'accountId required' }, { status: 400 })
  try {
    await clearCommunicatorToken(accountId)
    return Response.json({ ok: true, hasKey: false })
  } catch (e) {
    return Response.json({ error: 'Could not remove the Communicator token' }, { status: 503 })
  }
}
