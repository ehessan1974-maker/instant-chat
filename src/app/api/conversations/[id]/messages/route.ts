import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

/**
 * GET /api/conversations/[id]/messages?before=<ISO datetime>&limit=<n>
 * → { messages: [...] } ascending by createdAt (latest `limit` messages,
 *   or the ones older than `before` for pagination).
 * 403 when I am not a participant of the conversation.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const me = await getSessionUser(req)
    if (!me) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    }

    const { id } = await params
    const conversationId = id.trim()
    if (!conversationId) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
    }

    const membership = await db.conversationParticipant.findUnique({
      where: {
        conversationId_userId: { conversationId, userId: me.id },
      },
      select: { id: true },
    })
    if (!membership) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
    }

    const url = new URL(req.url)

    const limitRaw = Number.parseInt(
      url.searchParams.get('limit') ?? '',
      10
    )
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, MAX_LIMIT)
        : DEFAULT_LIMIT

    const beforeRaw = url.searchParams.get('before')
    let before: Date | null = null
    if (beforeRaw) {
      const parsed = new Date(beforeRaw)
      if (!Number.isNaN(parsed.getTime())) before = parsed
    }

    const rows = await db.message.findMany({
      where: {
        conversationId,
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: {
        sender: { select: { id: true, name: true, avatarColor: true } },
      },
    })

    const messages = rows
      .reverse()
      .map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        type: m.type,
        text: m.text,
        ...(m.clientId !== null ? { clientId: m.clientId } : {}),
        createdAt: m.createdAt,
        sender: {
          id: m.sender.id,
          name: m.sender.name,
          avatarColor: m.sender.avatarColor,
        },
      }))

    return NextResponse.json({ messages })
  } catch (error) {
    console.error('[messages GET] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
