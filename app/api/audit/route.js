import { requireRole } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspace, findAccount, publicAccount } from '@/lib/workspace'
import { writeActivity } from '@/lib/activity'
import { loadAiSettings, resolveAi, completeText } from '@/lib/ai'
import { buildAudit, fallbackSummary } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST(request) {
  const { user, error } = await requireRole(['admin'])
  if (error) return error
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid request body' }, { status: 400 }) }
  const accountId = String(body.accountId || '').trim()
  if (!accountId) return Response.json({ error: 'accountId required' }, { status: 400 })

  const ws = await loadWorkspace()
  if (!ws || !ws.data) return Response.json({ error: 'Workspace is unavailable' }, { status: 503 })
  const account = findAccount(ws.data, accountId)
  if (!account) return Response.json({ error: 'Subaccount not found' }, { status: 404 })

  const settings = await loadAiSettings()
  const ai = resolveAi(settings)
  if (!ai.enabled || !ai.apiKey) {
    return Response.json({ error: 'AI is not connected. Add a key in Settings → AI Integration.', code: 'unconfigured' }, { status: 409 })
  }

  await writeActivity({
    user,
    accountId,
    type: 'ai_audit_started',
    description: 'AI audit started for ' + (account.name || accountId),
    actorType: 'ai',
    actorName: 'AI Agent',
  })

  const groups = Array.isArray(ws.data.GROUPS) ? ws.data.GROUPS : []
  const marks = ws.data.MARKS && ws.data.MARKS[accountId]
  const findings = (ws.data.FIND && ws.data.FIND[accountId]) || {}
  const judged = buildAudit(account, groups, marks, findings)

  let summary = fallbackSummary(account, judged)
  try {
    const packet = {
      subaccount: publicAccount(account),
      audit: {
        overall: judged.overall,
        completion: judged.completion,
        categories: judged.categories.map((c) => ({
          name: c.name,
          status: c.status,
          items: c.items.map((i) => ({ name: i.name, status: i.status, reason: i.reason, checklistChecked: i.checked })),
        })),
      },
    }
    const raw = await completeText({
      apiKey: ai.apiKey,
      model: ai.model,
      provider: ai.provider,
      accountId: ai.accountId,
      json: true,
      system: [
        'You write the narrative for a FenceOS onboarding audit.',
        'The JSON you receive is already judged. Do not change any status.',
        'A checklist tick is not proof that a requirement is done.',
        'If a category is unable, say it could not be verified because there is no live Communicator connection.',
        'Reply as JSON: {"summary":"..."} with 2-4 sentences about this subaccount only.',
      ].join(' '),
      user: JSON.stringify(packet),
    })
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()) {
      summary = parsed.summary.trim().slice(0, 1200)
    }
  } catch (e) {
    // The structured result still stands. The narrative falls back to the evidence summary.
  }

  const result = { ...judged, summary, auditor: 'AI Agent', model: ai.model }
  let saved
  try {
    const { rows } = await pool.query(
      `INSERT INTO audits
         (subaccount_id, auditor, overall, completion, verified, incomplete, blocked, needs_review, unable, summary, result)
       VALUES ($1,'AI Agent',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       RETURNING id, subaccount_id, created_at, auditor, overall, completion, verified, incomplete, blocked, needs_review, unable, summary, result`,
      [
        accountId, judged.overall, judged.completion, judged.verified, judged.incomplete,
        judged.blocked, judged.needsReview, judged.unable, summary, JSON.stringify(result),
      ]
    )
    saved = rows[0]
  } catch (e) {
    await writeActivity({
      user, accountId, type: 'ai_audit_failed', actorType: 'ai', actorName: 'AI Agent',
      description: 'AI audit could not be saved',
    })
    return Response.json({ error: 'Could not save the audit' }, { status: 503 })
  }

  let checklistUpdated = false
  if (ai.applyChecklist) {
    checklistUpdated = await applyVerifiedMarks(ws, accountId, judged)
  }

  await writeActivity({
    user,
    accountId,
    type: 'ai_audit_completed',
    actorType: 'ai',
    actorName: 'AI Agent',
    description: 'AI audit completed — ' + judged.completion + '% verified',
    metadata: {
      auditId: saved.id,
      overall: judged.overall,
      completion: judged.completion,
      issues: judged.incomplete,
      blockers: judged.blocked,
      needsReview: judged.needsReview,
      unable: judged.unable,
    },
  })

  return Response.json({ ok: true, audit: saved, checklistUpdated })
}

async function applyVerifiedMarks(ws, accountId, judged) {
  const keys = []
  judged.categories.forEach((c) => {
    c.items.forEach((item) => {
      if (item.status === 'verified') keys.push(item.key)
    })
  })
  if (!keys.length) return false
  const data = ws.data
  const marks = data.MARKS && typeof data.MARKS === 'object' ? data.MARKS : {}
  const current = marks[accountId] && Array.isArray(marks[accountId].__set) ? marks[accountId].__set.slice() : []
  const set = new Set(current)
  let changed = false
  keys.forEach((k) => { if (!set.has(k)) { set.add(k); changed = true } })
  if (!changed) return false
  marks[accountId] = { __set: [...set] }
  data.MARKS = marks
  try {
    const { rowCount } = await pool.query(
      `UPDATE app_state SET data = $2::jsonb, updated_at = now()
       WHERE key = 'workspace' AND updated_at = $1`,
      [ws.updatedAt, JSON.stringify(data)]
    )
    return rowCount > 0
  } catch (e) {
    return false
  }
}
