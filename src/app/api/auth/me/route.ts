import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'

/**
 * GET /api/auth/me
 * → { user: { id, phone, name, avatarColor, about, lastSeen } } | 401
 */
export async function GET(req: Request) {
  try {
    const user = await getSessionUser(req)
    if (!user) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    }
    return NextResponse.json({
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        avatarColor: user.avatarColor,
        about: user.about,
        lastSeen: user.lastSeen,
      },
    })
  } catch (error) {
    console.error('[auth/me] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
