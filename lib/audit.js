import { asSet } from '@/lib/workspace'

// Fields the portal actually stores. A checklist tick is not evidence.
const PORTAL_FIELDS = {
  bn: 'name',
  bem: 'email',
  bph: 'phone',
  bws: 'web',
  bad: 'addr',
  bct: 'locality',
  bst: 'state',
  bzp: 'zip',
  btz: 'tz',
  bnc: 'industry',
  pc: 'city',
}

const FILLED = (v) => String(v || '').trim().length > 1

function findingFor(findings, itemKey) {
  const f = findings && findings[itemKey]
  if (!Array.isArray(f) || !f.length) return null
  return { verdict: f[0], text: String(f[1] || '') }
}

function itemStatus(account, groupId, item, findings, live) {
  const k = item.id + '@' + groupId
  if (live && live.items && live.items[k]) return live.items[k]
  const field = groupId === 'biz' ? PORTAL_FIELDS[item.id] : null
  if (field) {
    if (FILLED(account[field])) {
      return { status: 'verified', reason: 'Present on the subaccount record.' }
    }
    return { status: 'incomplete', reason: 'This value is not on the subaccount record.' }
  }
  const found = findingFor(findings, k)
  if (found && found.text) {
    if (found.verdict === 'client') return { status: 'blocked', reason: found.text }
    if (found.verdict === 'missing') return { status: 'incomplete', reason: found.text }
    if (found.verdict === 'mismatch') return { status: 'needs_review', reason: found.text }
  }
  if (live && live.connected) {
    return {
      status: 'unable',
      reason: 'Communicator was read, but this item is not exposed by the API. A checklist tick was not treated as proof.',
    }
  }
  return {
    status: 'unable',
    reason: (live && live.reason) || 'The portal has no live connection to verify this in Communicator. A checklist tick was not treated as proof.',
  }
}

function rollup(items) {
  const has = (s) => items.some((i) => i.status === s)
  if (has('incomplete')) return 'incomplete'
  if (has('blocked')) return 'blocked'
  if (has('needs_review')) return 'needs_review'
  if (has('unable')) return items.every((i) => i.status === 'unable') ? 'unable' : 'needs_review'
  if (items.length && items.every((i) => i.status === 'verified')) return 'verified'
  return 'unable'
}

const OVERALL = {
  incomplete: 'Needs Attention',
  blocked: 'Blocked',
  needs_review: 'Needs Review',
  unable: 'Unable to Verify',
  verified: 'Verified Complete',
}

export function buildAudit(account, groups, marks, findings, live) {
  const checked = asSet(marks)
  const cats = (Array.isArray(groups) ? groups : []).map((g) => {
    const items = (g.items || []).map((it) => {
      const judged = itemStatus(account, g.id, it, findings || {}, live)
      return {
        id: it.id,
        name: it.n,
        key: it.id + '@' + g.id,
        checked: checked.has(it.id + '@' + g.id),
        status: judged.status,
        reason: judged.reason,
      }
    })
    return {
      id: g.id,
      name: g.n,
      status: rollup(items),
      items,
    }
  })
  const count = (s) => cats.filter((c) => c.status === s).length
  const verified = count('verified')
  const incomplete = count('incomplete')
  const blocked = count('blocked')
  const needsReview = count('needs_review')
  const unable = count('unable')
  const total = cats.length || 1
  const completion = Math.round((verified / total) * 100)
  let overall = 'Needs Attention'
  if (incomplete) overall = OVERALL.incomplete
  else if (blocked) overall = OVERALL.blocked
  else if (needsReview) overall = OVERALL.needs_review
  else if (unable && !verified) overall = OVERALL.unable
  else if (verified === cats.length && cats.length) overall = OVERALL.verified
  else overall = OVERALL.needs_review

  const issues = {
    incomplete: cats.filter((c) => c.status === 'incomplete').map((c) => c.name),
    blocked: cats.filter((c) => c.status === 'blocked').map((c) => c.name),
    needsReview: cats.filter((c) => c.status === 'needs_review').map((c) => c.name),
    unable: cats.filter((c) => c.status === 'unable').map((c) => c.name),
    verified: cats.filter((c) => c.status === 'verified').map((c) => c.name),
  }
  return { overall, completion, verified, incomplete, blocked, needsReview, unable, categories: cats, issues }
}

export function fallbackSummary(account, audit) {
  const name = account.name || 'This subaccount'
  const bits = []
  if (audit.issues.incomplete.length) bits.push('Incomplete: ' + audit.issues.incomplete.join(', '))
  if (audit.issues.blocked.length) bits.push('Blocked: ' + audit.issues.blocked.join(', '))
  if (audit.issues.needsReview.length) bits.push('Needs review: ' + audit.issues.needsReview.join(', '))
  if (audit.issues.unable.length) bits.push('Unable to verify: ' + audit.issues.unable.join(', '))
  if (!bits.length) return name + ' — every main checklist category that the portal can see is verified.'
  return name + ' is ' + audit.completion + '% verified. ' + bits.join('. ') + '.'
}
