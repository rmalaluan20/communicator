import { requireRole } from '@/lib/auth'
import { loadAiSettings, resolveAi, completeText } from '@/lib/ai'

export const dynamic = 'force-dynamic'

export async function POST() {
  const { error } = await requireRole(['admin'])
  if (error) return error
  const settings = await loadAiSettings()
  const ai = resolveAi(settings)
  if (!ai.apiKey || (ai.provider === 'cloudflare' && !ai.accountId)) {
    return Response.json({ ok: false, status: 'Connection Failed', error: 'The AI service is not configured.' })
  }
  try {
    const text = await completeText({
      apiKey: ai.apiKey,
      model: ai.model,
      provider: ai.provider,
      accountId: ai.accountId,
      system: 'Reply with exactly the word ok.',
      user: 'ping',
    })
    const ok = /ok/i.test(text)
    return Response.json({ ok, status: ok ? 'Connected' : 'Connection Failed' })
  } catch (e) {
    return Response.json({ ok: false, status: 'Connection Failed', error: 'The AI service rejected the request.' })
  }
}
