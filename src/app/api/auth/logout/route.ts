import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { extractBearerToken } from '@/lib/auth'

/**
 * POST /api/auth/logout
 * Deletes the current session (no-op safe) → { ok: true }
 */
export async function POST(req: Request) {
  try {
    const token = extractBearerToken(req)
    if (!token) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    }
    // deleteMany (not delete) so an already-removed session is fine.
    await db.session.deleteMany({ where: { token } })
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[auth/logout] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
