import { randomInt } from 'node:crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizePhone, readJsonRecord } from '@/lib/auth'
import { isSmsConfigured, sendSms } from '@/lib/sms'

const OTP_TTL_MS = 10 * 60 * 1000 // صلاحية الرمز: 10 دقائق
const RESEND_COOLDOWN_MS = 60 * 1000 // دقيقة بين كل طلبين لنفس الرقم
const PER_PHONE_HOURLY_MAX = 8 // أقصى عدد رموز/ساعة لكل رقم
const GLOBAL_HOURLY_MAX = 60 // سقف عام/ساعة — يحمي رصيد مزود SMS المدفوع من الإساءة

// عدادات ساعية بذاكرة العملية (كافية لأن الخادم عملية واحدة على Render)
const HOUR_MS = 3_600_000
const hourBucket = () => Math.floor(Date.now() / HOUR_MS)
const perPhoneSends = new Map<string, { bucket: number; count: number }>()
let globalBucket = hourBucket()
let globalCount = 0

function globalLimitExceeded(): boolean {
  const bucket = hourBucket()
  if (globalBucket !== bucket) {
    globalBucket = bucket
    globalCount = 0
  }
  return globalCount >= GLOBAL_HOURLY_MAX
}

function phoneLimitExceeded(phone: string): boolean {
  const bucket = hourBucket()
  const entry = perPhoneSends.get(phone)
  if (!entry || entry.bucket !== bucket) return false
  return entry.count >= PER_PHONE_HOURLY_MAX
}

function recordSend(phone: string): void {
  const bucket = hourBucket()
  if (globalBucket !== bucket) {
    globalBucket = bucket
    globalCount = 0
  }
  globalCount += 1
  const entry = perPhoneSends.get(phone)
  if (!entry || entry.bucket !== bucket) {
    perPhoneSends.set(phone, { bucket, count: 1 })
  } else {
    entry.count += 1
  }
  // تنظيف دوري خفيف
  if (perPhoneSends.size > 10_000) {
    for (const [key, value] of perPhoneSends) {
      if (value.bucket !== bucket) perPhoneSends.delete(key)
    }
  }
}

/**
 * POST /api/auth/request-otp
 * body: { phone }
 *
 * مع مزود SMS مضبوط (SMS_PROVIDER): يرسل رمزاً حقيقياً بالرسالة النصية
 * ولا يعيد الرمز في الاستجابة إطلاقاً.
 * بلا مزود: وضع تجريبي — يعيد الرمز ليظهر في الواجهة.
 */
export async function POST(req: Request) {
  try {
    const body = await readJsonRecord(req)
    const phoneRaw = typeof body?.phone === 'string' ? body.phone : null
    if (!phoneRaw) {
      return NextResponse.json({ error: 'PHONE_REQUIRED' }, { status: 400 })
    }

    const phone = normalizePhone(phoneRaw)
    if (!phone) {
      return NextResponse.json({ error: 'PHONE_INVALID' }, { status: 400 })
    }

    // كولداون دقيقة لكل رقم (قاعدة بيانات — يبقى رغم إعادة التشغيل)
    const recent = await db.otpCode.findFirst({
      where: {
        phone,
        createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
      },
      select: { id: true },
    })
    if (recent) {
      return NextResponse.json({ error: 'OTP_COOLDOWN' }, { status: 429 })
    }

    // حدود ساعية لحماية رصيد المزود
    if (globalLimitExceeded() || phoneLimitExceeded(phone)) {
      return NextResponse.json({ error: 'OTP_RATE_LIMITED' }, { status: 429 })
    }

    const code = String(randomInt(0, 10000)).padStart(4, '0')
    await db.otpCode.create({
      data: {
        phone,
        code,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    })
    recordSend(phone)

    const existing = await db.user.findUnique({
      where: { phone },
      select: { id: true },
    })

    // الإرسال الحقيقي: رسالة نصية للرقم بلا أي كشف للرمز في الاستجابة
    if (isSmsConfigured()) {
      const template = process.env.OTP_MESSAGE_TEMPLATE || 'رمز الدخول لمحادثة فورية: {code}'
      const text = template.replace('{code}', code).slice(0, 160)
      const result = await sendSms(phone, text)
      if (!result.ok) {
        // لا نفشل العملية إجمالاً؟ — فشل الإرسال يجب أن يمنع الدخول (تحقق حقيقي)
        console.error('[auth/request-otp] SMS send failed:', result.error)
        return NextResponse.json({ error: 'SMS_FAILED' }, { status: 502 })
      }
      return NextResponse.json({ ok: true, delivered: true, isNew: !existing })
    }

    // وضع تجريبي بلا مزود — نعيد الرمز للواجهة كما كان
    return NextResponse.json({ ok: true, code, isNew: !existing, delivered: false })
  } catch (error) {
    console.error('[auth/request-otp] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
