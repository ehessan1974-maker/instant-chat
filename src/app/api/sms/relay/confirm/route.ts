import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

interface ConfirmResult {
  id?: unknown
  ok?: unknown
  error?: unknown
}

/**
 * POST /api/sms/relay/confirm
 * body: { results: [{ id, ok, error? }] }
 * المصادقة: Authorization: Bearer <SMS_RELAY_TOKEN>
 * يثبّت هاتف البوابة نتيجة الإرسال لكل رسالة سحبها.
 */
export async function POST(req: Request) {
  const token = (process.env.SMS_RELAY_TOKEN || '').trim()
  if (!token) {
    return NextResponse.json({ error: 'RELAY_DISABLED' }, { status: 404 })
  }

  const provided = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!provided || provided !== token) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  try {
    const body: unknown = await req.json().catch(() => null)
    const results = (body as { results?: unknown } | null)?.results
    if (!Array.isArray(results)) {
      return NextResponse.json({ error: 'RESULTS_REQUIRED' }, { status: 400 })
    }

    let confirmed = 0
    for (const raw of results.slice(0, 50)) {
      const item = raw as ConfirmResult
      if (typeof item?.id !== 'string' || !item.id) continue
      const success = item.ok === true
      const errorText =
        typeof item.error === 'string' && item.error ? item.error.slice(0, 200) : null
      try {
        await db.smsOutbox.update({
          where: { id: item.id },
          data: success
            ? { status: 'sent', sentAt: new Date(), error: null }
            : { status: 'failed', error: errorText || 'send_failed' },
        })
        confirmed += 1
      } catch {
        // معرف غير موجود — نتجاهله بصمت
      }
    }

    return NextResponse.json({ ok: true, confirmed })
  } catch (error) {
    console.error('[sms/relay/confirm] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
