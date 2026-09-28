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

function ghlMessage(body) {
  const raw = body && (body.message || body.msg || (body.error && (body.error.message || body.error)))
  return String(raw || '').replace(/pit-[A-Za-z0-9_-]+/gi, 'token').replace(/\s+/g, ' ').trim().slice(0, 180)
}

async function ghlRequest(token, path, authorization, version) {
  const res = await fetch(GHL + path, {
    headers: {
      Authorization: authorization,
      Accept: 'application/json',
      Version: version,
    },
    signal: AbortSignal.timeout(8000),
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body, message: ghlMessage(body) }
}

async function ghlGet(token, path, auth) {
  try {
    return await ghlRequest(token, path, auth.authorization, auth.version)
  } catch (e) {
    return { ok: false, status: 0, body: {}, message: '' }
  }
}

async function discoverAuth(token, path) {
  const versions = ['2021-07-28', 'v3']
  const authorizations = [`Bearer ${token}`, token]
  let last = { ok: false, status: 0, body: {}, message: '' }
  for (const version of versions) {
    for (const authorization of authorizations) {
      const result = await ghlRequest(token, path, authorization, version)
      last = result
      if (result.ok || result.status === 403 || result.status === 404) {
        return { authorization, version, result }
      }
    }
  }
  return { authorization: `Bearer ${token}`, version: '2021-07-28', result: last }
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
  setField(items, 'logo@brand', firstKnown(loc, ['logoUrl', 'business.logoUrl']), 'A logo is uploaded on the Communicator location.', 'No logo is uploaded on the Communicator location.')
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
  let probe
  try {
    probe = await discoverAuth(token, `/locations/${id}`)
  } catch (e) {
    return { connected: false, reason: 'Communicator did not respond for this location.', items: {} }
  }
  const auth = { authorization: probe.authorization, version: probe.version }
  const location = probe.result
  const items = location.ok ? locationItems((location.body && location.body.location) || location.body || {}) : {}
  const calls = await Promise.all([
    ghlGet(token, `/calendars/?locationId=${id}`, auth),
    ghlGet(token, `/users/?locationId=${id}`, auth),
    ghlGet(token, `/phone-system/numbers/location/${id}`, auth),
    ghlGet(token, `/locations/${id}/customValues`, auth),
    ghlGet(token, `/locations/${id}/customFields`, auth),
    ghlGet(token, `/opportunities/pipelines?locationId=${id}`, auth),
    ghlGet(token, `/funnels/funnel/list?locationId=${id}`, auth),
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
  const anyOk = location.ok || calls.some((call) => call && call.ok)
  if (!anyOk) {
    const failed = [location].concat(calls).find((call) => call && call.status)
    const detail = failed && failed.message ? ` ${failed.message}` : ''
    const reason = failed && (failed.status === 401 || failed.status === 403)
      ? `Communicator rejected the API token for this subaccount.${detail} Create the token inside this location and include read access for Locations.`
      : failed && failed.status === 404
        ? 'Communicator could not find this location ID.'
        : 'Communicator did not return this location.'
    return { connected: false, reason, items: {} }
  }
  return { connected: true, reason: '', items }
}
