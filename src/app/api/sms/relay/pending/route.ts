import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { SETTING_KEYS, loadSettings, getCachedSetting } from '@/lib/settings'

const MAX_ATTEMPTS = 3 // بعد 3 سحبات بلا تأكيد تُسقط الرسالة (يمنع التكرار اللانهائي)
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20

/** توكن البوابة: البيئة أولاً ثم إعدادات قاعدة البيانات (معالج التهيئة) */
async function relayToken(): Promise<string> {
  const fromEnv = (process.env.SMS_RELAY_TOKEN || '').trim()
  if (fromEnv) return fromEnv
  await loadSettings()
  return (getCachedSetting(SETTING_KEYS.smsRelayToken) || '').trim()
}

/**
 * GET /api/sms/relay/pending?limit=5
 * المصادقة: Authorization: Bearer <SMS_RELAY_TOKEN>
 * يستدعيها هاتف البوابة (Termux) لسحب الرسائل المنتظرة وإرسالها من شريحته.
 * كل سحبة ترفع عدّاد المحاولات — والرسائل المستنزفة تُسقط تلقائياً.
 */
export async function GET(req: Request) {
  const token = await relayToken()
  if (!token) {
    return NextResponse.json({ error: 'RELAY_DISABLED' }, { status: 404 })
  }

  const provided = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!provided || provided !== token) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  try {
    const url = new URL(req.url)
    const limitRaw = Number(url.searchParams.get('limit') || DEFAULT_LIMIT)
    const limit = Math.min(Math.max(Math.floor(limitRaw) || DEFAULT_LIMIT, 1), MAX_LIMIT)

    // إسقاط الرسائل التي استُنزفت محاولاتها (بلا تأكيد وصول متكرر)
    await db.smsOutbox.updateMany({
      where: { status: 'pending', attempts: { gte: MAX_ATTEMPTS } },
      data: { status: 'dropped', error: 'max_attempts_exceeded' },
    })

    const pending = await db.smsOutbox.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, phone: true, text: true, attempts: true },
    })

    // رفع عدّاد المحاولات للرسائل المسحوبة
    if (pending.length) {
      await db.smsOutbox.updateMany({
        where: { id: { in: pending.map((m) => m.id) } },
        data: { attempts: { increment: 1 } },
      })
    }

    return NextResponse.json({ ok: true, messages: pending })
  } catch (error) {
    console.error('[sms/relay/pending] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
