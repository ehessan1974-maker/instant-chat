import { randomInt } from 'node:crypto'
import { NextResponse } from 'next/server'
import { db, ensurePublicRoom } from '@/lib/db'
import {
  AVATAR_COLORS,
  generateSessionToken,
  normalizePhone,
  readJsonRecord,
} from '@/lib/auth'

const NAME_MAX_LENGTH = 30

/**
 * POST /api/auth/verify
 * body: { phone, code, name? }
 * → { token, user: { id, phone, name, avatarColor, about } }
 * 400 INVALID_CODE | 422 NAME_REQUIRED (OTP is not consumed so the client can retry)
 */
export async function POST(req: Request) {
  try {
    const body = await readJsonRecord(req)
    const phoneRaw = typeof body?.phone === 'string' ? body.phone : null
    const codeRaw = typeof body?.code === 'string' ? body.code : null
    if (!phoneRaw || !codeRaw) {
      return NextResponse.json(
        { error: 'PHONE_AND_CODE_REQUIRED' },
        { status: 400 }
      )
    }

    const phone = normalizePhone(phoneRaw)
    if (!phone) {
      return NextResponse.json({ error: 'PHONE_INVALID' }, { status: 400 })
    }
    const code = codeRaw.trim()

    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const existingUser = await db.user.findUnique({ where: { phone } })

    // New user without a name: reject BEFORE consuming the OTP so the client
    // can collect the name and retry with the same code.
    if (!existingUser && !name) {
      return NextResponse.json({ error: 'NAME_REQUIRED' }, { status: 422 })
    }

    const otp = await db.otpCode.findFirst({
      where: {
        phone,
        code,
        used: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (!otp) {
      return NextResponse.json({ error: 'INVALID_CODE' }, { status: 400 })
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

    // Auto-join the public room so it always appears in the user's list.
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
      console.error('[auth/verify] public-room join failed:', e)
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
    console.error('[auth/verify] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
