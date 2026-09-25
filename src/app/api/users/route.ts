import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

/**
 * GET /api/users?q=<query>
 * → { users: [{ id, phone, name, avatarColor, about, lastSeen }] }
 * All real (non-guest) users except me, ordered by name.
 * Optional `q` filters by name OR phone (users are uniquely identified
 * by their phone number — searchable by both).
 */
export async function GET(req: Request) {
  try {
    const me = await getSessionUser(req)
    if (!me) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    }

    const q = (new URL(req.url).searchParams.get('q') ?? '').trim()

    const users = await db.user.findMany({
      where: {
        isGuest: false,
        id: { not: me.id },
        ...(q
          ? {
              OR: [
                { name: { contains: q } },
                { phone: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        phone: true,
        name: true,
        avatarColor: true,
        about: true,
        lastSeen: true,
      },
    })

    return NextResponse.json({ users })
  } catch (error) {
    console.error('[users] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
