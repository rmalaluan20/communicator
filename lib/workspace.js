import { pool } from '@/lib/db'

export async function loadWorkspace() {
  const { rows } = await pool.query(
    'SELECT data, updated_at FROM app_state WHERE key = $1',
    ['workspace']
  )
  if (!rows.length) return null
  return { data: rows[0].data, updatedAt: rows[0].updated_at }
}

export function asSet(value) {
  if (!value) return new Set()
  if (Array.isArray(value)) return new Set(value)
  if (value && Array.isArray(value.__set)) return new Set(value.__set)
  return new Set()
}

export function findAccount(data, accountId) {
  const list = data && Array.isArray(data.ACCOUNTS) ? data.ACCOUNTS : []
  return list.find((a) => a && a.id === accountId) || null
}

export function publicAccount(a) {
  if (!a) return null
  const copy = { ...a }
  delete copy.logo
  return copy
}
