import { getSessionUser } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspace, findAccount, publicAccount } from '@/lib/workspace'
import { loadAiSettings, resolveAi, completeText } from '@/lib/ai'
import { buildAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Not authenticated' }, { status: 401 })
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid request body' }, { status: 400 }) }
  const question = String(body.question || '').trim().slice(0, 2000)
  const accountId = String(body.accountId || '').trim()
  if (!question) return Response.json({ error: 'Ask a question about this subaccount.' }, { status: 400 })

  const settings = await loadAiSettings()
  const ai = resolveAi(settings)
  if (!ai.enabled || !ai.apiKey) {
    return Response.json({
      error: 'AI is not connected. An owner can connect it in Settings → AI Integration.',
      code: 'unconfigured',
    }, { status: 409 })
  }

  const ws = await loadWorkspace()
  if (!ws || !ws.data) return Response.json({ error: 'Workspace is unavailable' }, { status: 503 })
  const accounts = Array.isArray(ws.data.ACCOUNTS) ? ws.data.ACCOUNTS : []
  let account = accountId ? findAccount(ws.data, accountId) : null
  if (!account && user.role === 'admin') {
    const q = question.toLowerCase()
    account = accounts.find((a) => a && a.name && q.includes(String(a.name).toLowerCase())) || null
  }
  if (!account) {
    return Response.json({ error: 'Open a subaccount first so the assistant knows which company you mean.' }, { status: 400 })
  }

  const groups = Array.isArray(ws.data.GROUPS) ? ws.data.GROUPS : []
  const judged = buildAudit(account, groups, ws.data.MARKS && ws.data.MARKS[account.id], (ws.data.FIND && ws.data.FIND[account.id]) || {})
  let latest = null
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, overall, completion, summary, incomplete, blocked, needs_review, unable
       FROM audits WHERE subaccount_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [account.id]
    )
    latest = rows[0] || null
  } catch (e) {}

  const context = {
    subaccount: publicAccount(account),
    checklistReadinessNote: 'Checklist ticks are what a person marked. They are not verification.',
    mainCategories: judged.categories.map((c) => ({
      name: c.name,
      auditStatus: c.status,
      checked: c.items.filter((i) => i.checked).length,
      total: c.items.length,
    })),
    latestAudit: latest,
  }

  const guest = user.role === 'guest' || user.guest
  try {
    const answer = await completeText({
      apiKey: ai.apiKey,
      model: ai.model,
      provider: ai.provider,
      accountId: ai.accountId,
      system: [
        'You are the FenceOS onboarding assistant.',
        'Answer only from the JSON context about the one subaccount provided.',
        'Do not mention other companies, API keys, or owner settings.',
        guest ? 'The person asking is a guest. Do not reveal anything that is not already in the context.' : 'The person asking is an authorized user of this portal.',
        'Distinguish a checklist tick from an AI verification.',
        'If there is no latest audit, say an AI audit has not been run yet.',
        'Keep the answer to a short paragraph and a few bullets when listing gaps.',
      ].join(' '),
      user: JSON.stringify({ question, context }),
    })
    return Response.json({ ok: true, answer, accountId: account.id, accountName: account.name })
  } catch (e) {
    return Response.json({ error: 'The AI service did not respond. Try again.' }, { status: 502 })
  }
}
