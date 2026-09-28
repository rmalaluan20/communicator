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
  const guest = user.role === 'guest' || user.guest
  const named = guest ? null : accountNamedIn(question, accounts)
  const open = accountId ? findAccount(ws.data, accountId) : null
  if (!guest && !named && isPortfolioQuestion(question)) {
    return answerPortfolio({ ai, question, accounts, ws })
  }
  const account = named || open
  if (!account) {
    return Response.json({ error: 'Name a subaccount, or open one, so the assistant knows which company you mean.' }, { status: 400 })
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

const NAME_STOP = new Set(['fence', 'fencing', 'fences', 'company', 'inc', 'co', 'the', 'and', 'supply', 'llc', 'corp'])

function accountNamedIn(question, accounts) {
  const q = String(question || '').toLowerCase()
  const full = accounts
    .filter((a) => a && a.name && q.includes(String(a.name).toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)
  if (full.length) return full[0]
  const scored = accounts.map((a) => {
    const words = String(a && a.name || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !NAME_STOP.has(w))
    const n = words.filter((w) => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(q)).length
    return { a, n }
  }).filter((x) => x.n > 0).sort((x, y) => y.n - x.n)
  if (!scored.length) return null
  if (scored.length === 1 || scored[0].n > scored[1].n) return scored[0].a
  return null
}

function isPortfolioQuestion(question) {
  return /\b(all accounts|every account|overall|which accounts|furthest|behind|compare|worst)\b/i.test(question)
}

function checklistPercent(judged) {
  let done = 0
  let total = 0
  for (const cat of judged.categories || []) {
    for (const item of cat.items || []) {
      total += 1
      if (item.checked) done += 1
    }
  }
  return total ? Math.round((done / total) * 100) : 0
}

async function answerPortfolio({ ai, question, accounts, ws }) {
  const groups = Array.isArray(ws.data.GROUPS) ? ws.data.GROUPS : []
  const roster = accounts.filter((a) => a && a.name).map((a) => {
    const judged = buildAudit(a, groups, ws.data.MARKS && ws.data.MARKS[a.id], (ws.data.FIND && ws.data.FIND[a.id]) || {})
    return {
      name: a.name,
      checklistPercent: checklistPercent(judged),
      verifiedPercent: judged.completion,
      overall: judged.overall,
      incomplete: judged.issues.incomplete,
      blocked: judged.issues.blocked,
    }
  })
  try {
    const answer = await completeText({
      apiKey: ai.apiKey,
      model: ai.model,
      provider: ai.provider,
      accountId: ai.accountId,
      system: [
        'You are the FenceOS onboarding assistant.',
        'The JSON roster is every subaccount. Answer only from it.',
        'checklistPercent is how many checklist boxes are ticked. It is not proof the work is done.',
        'verifiedPercent is how many main categories the portal could verify. A tick is not verification.',
        'When asked who is furthest behind, use the lowest checklistPercent.',
        'Do not invent companies, and do not include contact details, logos, or notes.',
        'Keep the answer to a short paragraph and a few bullets.',
      ].join(' '),
      user: JSON.stringify({ question, roster }),
    })
    return Response.json({ ok: true, answer, accountId: null, accountName: null })
  } catch (e) {
    return Response.json({ error: 'The AI service did not respond. Try again.' }, { status: 502 })
  }
}
