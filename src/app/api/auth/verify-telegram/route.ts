import { randomInt } from 'node:crypto'
import { NextResponse } from 'next/server'
import { db, ensurePublicRoom } from '@/lib/db'
import { AVATAR_COLORS, generateSessionToken, readJsonRecord } from '@/lib/auth'

const NAME_MAX_LENGTH = 30

/**
 * POST /api/auth/verify-telegram
 * body: { link, name? }
 * الدخول بضغطة «تأكيد الدخول» من تيليجرام — بلا كتابة الرمز إطلاقاً.
 * يعمل فقط بعد شرطين معاً (أمنهما معاً):
 *   1) deliveredAt: وصل الرمز فعلاً لشات تيليجرام خاص
 *   2) approvedAt: صاحب الشات ضغط زر «تأكيد الدخول» في تلك الرسالة
 * → { token, user } | 400 INVALID_CODE | 422 NAME_REQUIRED (لا يُستهلك الطلب)
 */
export async function POST(req: Request) {
  try {
    const body = await readJsonRecord(req)
    const link = typeof body?.link === 'string' ? body.link.trim() : ''
    if (!/^[a-f0-9]{48}$/i.test(link)) {
      return NextResponse.json({ error: 'INVALID_CODE' }, { status: 400 })
    }

    const otp = await db.otpCode.findUnique({ where: { linkCode: link } })
    if (
      !otp ||
      otp.used ||
      otp.expiresAt.getTime() < Date.now() ||
      !otp.deliveredAt || // بلا تسليم فعلي → لا دخول (معرفة الرابط وحده لا تكفي)
      !otp.approvedAt // بلا موافقة صاحب الشات → لا دخول
    ) {
      return NextResponse.json({ error: 'INVALID_CODE' }, { status: 400 })
    }

    const phone = otp.phone
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const existingUser = await db.user.findUnique({ where: { phone } })

    // مستخدم جديد بلا اسم: نرفض قبل استهلاك الطلب ليجمع العميل الاسم ويعيد بنفس الرابط
    if (!existingUser && !name) {
      return NextResponse.json({ error: 'NAME_REQUIRED' }, { status: 422 })
    }

    await db.otpCode.update({ where: { id: otp.id }, data: { used: true } })

    const user =
      existingUser ??
      (await db.user.create({
        data: {
          phone,
          name: name.slice(0, NAME_MAX_LENGTH),
          avatarColor: AVATAR_COLORS[randomInt(0, AVATAR_COLORS.length)],
        },
      }))

    const token = generateSessionToken()
    await db.session.create({ data: { token, userId: user.id } })

    // الانضمام التلقائي للغرفة العامة
    try {
      const publicRoom = await ensurePublicRoom()
      await db.conversationParticipant.upsert({
        where: {
          conversationId_userId: {
            conversationId: publicRoom.id,
            userId: user.id,
          },
        },
        update: {},
        create: { conversationId: publicRoom.id, userId: user.id },
      })
    } catch (e) {
      console.error('[auth/verify-telegram] public-room join failed:', e)
    }

    return NextResponse.json({
      token,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        avatarColor: user.avatarColor,
        about: user.about,
      },
    })
  } catch (error) {
    console.error('[auth/verify-telegram] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
