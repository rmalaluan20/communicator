import { pool } from '@/lib/db'

const GHL = 'https://services.leadconnectorhq.com'

export async function loadCommunicatorToken(accountId) {
  const { rows } = await pool.query(
    'SELECT api_key FROM communicator_tokens WHERE subaccount_id = $1',
    [accountId]
  )
  return rows[0] && rows[0].api_key ? String(rows[0].api_key) : ''
}

export async function saveCommunicatorToken(accountId, apiKey) {
  await pool.query(
    `INSERT INTO communicator_tokens (subaccount_id, api_key, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (subaccount_id) DO UPDATE SET api_key = EXCLUDED.api_key, updated_at = now()`,
    [accountId, apiKey]
  )
}

export async function clearCommunicatorToken(accountId) {
  await pool.query('DELETE FROM communicator_tokens WHERE subaccount_id = $1', [accountId])
}

const filled = (v) => String(v == null ? '' : v).trim().length > 1

function readPath(obj, path) {
  if (!obj || typeof obj !== 'object') return { known: false, value: '' }
  let cur = obj
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) {
      return { known: false, value: '' }
    }
    cur = cur[part]
  }
  return { known: true, value: cur }
}

function firstKnown(obj, paths) {
  let saw = false
  for (const path of paths) {
    const reading = readPath(obj, path)
    if (!reading.known) continue
    saw = true
    if (filled(reading.value)) return { known: true, value: reading.value }
  }
  return saw ? { known: true, value: '' } : { known: false, value: '' }
}

function setField(items, key, reading, presentReason, emptyReason) {
  if (!reading.known) return
  items[key] = filled(reading.value)
    ? { status: 'verified', reason: presentReason }
    : { status: 'incomplete', reason: emptyReason }
}

function listFrom(body, keys) {
  if (!body || typeof body !== 'object') return null
  for (const key of keys) {
    if (Array.isArray(body[key])) return body[key]
  }
  return null
}

async function ghlGet(token, path) {
  const res = await fetch(GHL + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      Version: '2021-07-28',
    },
    signal: AbortSignal.timeout(8000),
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body }
}

function locationItems(loc) {
  const items = {}
  const on = 'Present on the Communicator location.'
  const off = 'This value is empty on the Communicator location.'
  const pairs = [
    ['bn@biz', ['name', 'business.name'], on, off],
    ['bem@biz', ['email', 'business.email'], on, off],
    ['bph@biz', ['phone', 'business.phone'], on, off],
    ['bws@biz', ['website', 'business.website'], on, off],
    ['bad@biz', ['address', 'business.address'], on, off],
    ['bct@biz', ['city', 'business.city'], on, off],
    ['bst@biz', ['state', 'business.state'], on, off],
    ['bzp@biz', ['postalCode', 'business.postalCode'], on, off],
    ['bco@biz', ['country', 'business.country'], on, off],
    ['btz@biz', ['timezone', 'business.timezone'], on, off],
    ['bnc@biz', ['business.niche', 'niche', 'settings.niche'], on, off],
    ['ein@biz', ['ein', 'business.ein', 'settings.ein'], on, off],
  ]
  pairs.forEach(([key, paths, present, empty]) => setField(items, key, firstKnown(loc, paths), present, empty))
  const contact = firstKnown(loc, ['prospectInfo.firstName', 'firstName', 'business.firstName'])
  setField(items, 'pc@biz', contact, 'A primary contact is present on the Communicator location.', 'No primary contact is present on the Communicator location.')
  const friendly = readPath(loc, 'business.name')
  const legal = readPath(loc, 'name')
  if (friendly.known && legal.known && filled(friendly.value) && String(friendly.value).trim() !== String(legal.value).trim()) {
    items['fbn@biz'] = { status: 'verified', reason: 'Communicator has a business name distinct from the location name.' }
  }
  return items
}

function countItem(list, key, noun) {
  if (!Array.isArray(list)) return null
  if (list.length) {
    return { status: 'verified', reason: `Communicator returned ${list.length} ${noun}${list.length === 1 ? '' : 's'}.` }
  }
  return { status: 'incomplete', reason: `Communicator returned no ${noun}s.`, key }
}

function calendarActive(calendar) {
  if (!calendar || typeof calendar !== 'object') return null
  if (typeof calendar.isActive === 'boolean') return calendar.isActive
  if (typeof calendar.active === 'boolean') return calendar.active
  if (calendar.status) return String(calendar.status).toLowerCase() === 'active'
  return null
}

export async function readCommunicator({ token, locationId }) {
  if (!token) {
    return { connected: false, reason: 'No Communicator API token is saved for this subaccount.', items: {} }
  }
  if (!locationId || !/^[A-Za-z0-9_-]{3,80}$/.test(locationId)) {
    return { connected: false, reason: 'Add the Communicator location link before the audit can read this subaccount.', items: {} }
  }
  const id = encodeURIComponent(locationId)
  let location
  try {
    location = await ghlGet(token, `/locations/${id}`)
  } catch (e) {
    return { connected: false, reason: 'Communicator did not respond for this location.', items: {} }
  }
  if (!location.ok) {
    const reason = location.status === 401 || location.status === 403
      ? 'Communicator rejected the API token for this subaccount.'
      : location.status === 404
        ? 'Communicator could not find this location ID.'
        : 'Communicator did not return this location.'
    return { connected: false, reason, items: {} }
  }
  const loc = (location.body && location.body.location) || location.body || {}
  const items = locationItems(loc)
  const calls = await Promise.all([
    ghlGet(token, `/calendars/?locationId=${id}`).catch(() => ({ ok: false })),
    ghlGet(token, `/users/?locationId=${id}`).catch(() => ({ ok: false })),
    ghlGet(token, `/phone-system/numbers/location/${id}`).catch(() => ({ ok: false })),
    ghlGet(token, `/locations/${id}/customValues`).catch(() => ({ ok: false })),
    ghlGet(token, `/locations/${id}/customFields`).catch(() => ({ ok: false })),
    ghlGet(token, `/opportunities/pipelines?locationId=${id}`).catch(() => ({ ok: false })),
    ghlGet(token, `/funnels/funnel/list?locationId=${id}`).catch(() => ({ ok: false })),
  ])
  const [calendars, users, phones, values, fields, pipelines, funnels] = calls
  if (calendars.ok) {
    const list = listFrom(calendars.body, ['calendars'])
    const counted = countItem(list, 'cex@cal', 'calendar')
    if (counted) items['cex@cal'] = counted
    if (Array.isArray(list) && list.length) {
      const flags = list.map(calendarActive)
      if (flags.every((flag) => flag !== null)) {
        items['cact@cal'] = flags.every(Boolean)
          ? { status: 'verified', reason: 'Every calendar returned by Communicator is active.' }
          : { status: 'incomplete', reason: 'Communicator returned a calendar that is not active.' }
      }
    }
  }
  if (users.ok) {
    const list = listFrom(users.body, ['users'])
    const counted = countItem(list, 'uown@users', 'user')
    if (counted) items['uown@users'] = { ...counted, reason: counted.status === 'verified' ? counted.reason : 'Communicator returned no users.' }
  }
  if (phones.ok) {
    const list = listFrom(phones.body, ['numbers', 'phoneNumbers', 'data'])
    if (Array.isArray(list)) {
      const hit = list.length
        ? { status: 'verified', reason: 'A phone number is attached to this Communicator location.' }
        : { status: 'incomplete', reason: 'No phone number is attached to this Communicator location.' }
      items['pbuy@phone'] = hit
      items['pcon@phone'] = hit
    }
  }
  if (values.ok) {
    const list = listFrom(values.body, ['customValues'])
    if (Array.isArray(list)) {
      const any = list.some((row) => filled(row && (row.value || row.fieldValue || row.field_value)))
      items['kval@crm'] = any
        ? { status: 'verified', reason: 'Communicator returned custom values with content.' }
        : { status: 'incomplete', reason: 'Communicator returned no filled custom values.' }
    }
  }
  if (fields.ok) {
    const list = listFrom(fields.body, ['customFields'])
    const counted = countItem(list, 'kfld@crm', 'custom field')
    if (counted) items['kfld@crm'] = counted.status === 'verified'
      ? { status: 'verified', reason: 'Custom fields are defined on this Communicator location.' }
      : { status: 'incomplete', reason: 'Communicator returned no custom fields.' }
  }
  if (pipelines.ok) {
    const list = listFrom(pipelines.body, ['pipelines'])
    const counted = countItem(list, 'kpipe@crm', 'pipeline')
    if (counted) items['kpipe@crm'] = counted.status === 'verified'
      ? counted
      : { status: 'incomplete', reason: 'Communicator returned no pipelines.' }
  }
  if (funnels.ok) {
    const list = listFrom(funnels.body, ['funnels'])
    const counted = countItem(list, 'afun@assets', 'funnel')
    if (counted) items['afun@assets'] = counted.status === 'verified'
      ? { status: 'verified', reason: 'Communicator returned an appointment funnel.' }
      : { status: 'incomplete', reason: 'Communicator returned no funnels.' }
  }
  return { connected: true, reason: '', items }
}
