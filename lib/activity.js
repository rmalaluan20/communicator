import { pool } from '@/lib/db'

const TYPES = new Set([
  'ai_audit_started',
  'ai_audit_completed',
  'ai_audit_failed',
  'checklist_completed',
  'checklist_reopened',
  'checklist_updated',
  'status_changed',
  'subaccount_updated',
  'subaccount_created',
  'subaccount_removed',
  'note_added',
  'logo_updated',
  'link_updated',
  'blocker_added',
  'blocker_resolved',
])

export function actorFrom(user) {
  if (!user) return { type: 'system', id: null, name: 'System' }
  if (user.guest) return { type: 'guest', id: user.sid || null, name: user.name || 'Guest' }
  if (user.role === 'admin') return { type: 'admin', id: user.uid != null ? String(user.uid) : null, name: user.name || 'Owner' }
  return { type: 'member', id: user.uid != null ? String(user.uid) : null, name: user.name || 'Member' }
}

export async function writeActivity({ user, accountId, type, description, metadata, actorName, actorType }) {
  const kind = TYPES.has(type) ? type : 'subaccount_updated'
  const actor = user ? actorFrom(user) : { type: actorType || 'system', id: null, name: actorName || 'System' }
  const name = actorName || actor.name
  const desc = String(description || '').slice(0, 500)
  const meta = metadata && typeof metadata === 'object' ? metadata : {}
  try {
    const { rows } = await pool.query(
      `INSERT INTO activity_log
         (subaccount_id, activity_type, actor_type, actor_id, actor_name, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, subaccount_id, activity_type, actor_type, actor_name, description, metadata, created_at`,
      [
        accountId || null,
        kind,
        actorType || actor.type,
        actor.id,
        name,
        desc,
        JSON.stringify(meta),
      ]
    )
    return rows[0]
  } catch (e) {
    return null
  }
}
