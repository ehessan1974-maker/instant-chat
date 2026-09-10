import { randomInt } from 'node:crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizePhone, readJsonRecord } from '@/lib/auth'

const OTP_TTL_MS = 10 * 60 * 1000 // 10 minutes

/**
 * POST /api/auth/request-otp
 * body: { phone }
 * → { ok: true, code, isNew }   (code is exposed for the demo UI only)
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

    const code = String(randomInt(0, 10000)).padStart(4, '0')
    await db.otpCode.create({
      data: {
        phone,
        code,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    })

    const existing = await db.user.findUnique({
      where: { phone },
      select: { id: true },
    })

    return NextResponse.json({ ok: true, code, isNew: !existing })
  } catch (error) {
    console.error('[auth/request-otp] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
