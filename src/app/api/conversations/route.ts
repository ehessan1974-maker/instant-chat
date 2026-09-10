import { NextResponse } from 'next/server'
import { db, ensurePublicRoom } from '@/lib/db'
import { getSessionUser, readJsonRecord } from '@/lib/auth'

interface OtherUser {
  id: string
  name: string
  avatarColor: string
  lastSeen: Date | null
  lastReadAt?: Date | null
}

interface LastMessage {
  id: string
  text: string
  createdAt: Date
  senderId: string
  senderName: string
  type: string
}

interface ConversationSummary {
  id: string
  type: string
  name?: string
  other?: OtherUser
  lastMessage?: LastMessage
  unreadCount: number
  myLastReadAt: Date | null
  otherLastReadAt?: Date | null
}

const EPOCH = new Date(0)

/**
 * GET /api/conversations
 * → { conversations: [...] } ordered by last-message time desc,
 *   conversations without messages at the end.
 */
export async function GET(req: Request) {
  try {
    const me = await getSessionUser(req)
    if (!me) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    }

    // Defensive auto-join: guarantee the public room is always in my list,
    // even for sessions created before verify-time auto-join existed.
    try {
      const publicRoom = await ensurePublicRoom()
      const joined = await db.conversationParticipant.findFirst({
        where: { conversationId: publicRoom.id, userId: me.id },
        select: { id: true },
      })
      if (!joined) {
        await db.conversationParticipant.create({
          data: { conversationId: publicRoom.id, userId: me.id },
        })
      }
    } catch (e) {
      console.error('[conversations] public-room auto-join failed:', e)
    }

    const participations = await db.conversationParticipant.findMany({
      where: { userId: me.id },
      include: {
        conversation: {
          include: {
            participants: { include: { user: true } },
            messages: {
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
              include: { sender: { select: { name: true } } },
            },
          },
        },
      },
    })

    const summaries: ConversationSummary[] = await Promise.all(
      participations.map(async (p) => {
        const conv = p.conversation
        const lastRow = conv.messages[0] ?? null
        const otherRow =
          conv.type === 'private'
            ? (conv.participants.find((x) => x.userId !== me.id) ?? null)
            : null
        const otherUser = otherRow?.user ?? null

        const unreadCount = await db.message.count({
          where: {
            conversationId: conv.id,
            senderId: { not: me.id },
            createdAt: { gt: p.lastReadAt ?? EPOCH },
          },
        })

        const summary: ConversationSummary = {
          id: conv.id,
          type: conv.type,
          unreadCount,
          myLastReadAt: p.lastReadAt,
        }
        if (conv.type === 'group' && conv.name) summary.name = conv.name
        if (otherUser) {
          summary.other = {
            id: otherUser.id,
            name: otherUser.name,
            avatarColor: otherUser.avatarColor,
            lastSeen: otherUser.lastSeen,
            lastReadAt: otherRow?.lastReadAt ?? null,
          }
          // top-level alias so clients can compute initial ✓✓ states
          summary.otherLastReadAt = otherRow?.lastReadAt ?? null
        }
        if (lastRow) {
          summary.lastMessage = {
            id: lastRow.id,
            text: lastRow.text,
            createdAt: lastRow.createdAt,
            senderId: lastRow.senderId,
            senderName: lastRow.sender.name,
            type: lastRow.type,
          }
        }
        return summary
      })
    )

    summaries.sort((a, b) => {
      const ta = a.lastMessage ? a.lastMessage.createdAt.getTime() : null
      const tb = b.lastMessage ? b.lastMessage.createdAt.getTime() : null
      if (ta === null && tb === null) return 0
      if (ta === null) return 1 // no messages → end of the list
      if (tb === null) return -1
      return tb - ta // descending by last message time
    })

    return NextResponse.json({ conversations: summaries })
  } catch (error) {
    console.error('[conversations GET] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}

/**
 * POST /api/conversations
 * body: { userId }
 * → { conversation: { id, type: 'private', other: {...} } }
 */
export async function POST(req: Request) {
  try {
    const me = await getSessionUser(req)
    if (!me) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    }

    const body = await readJsonRecord(req)
    const targetId = typeof body?.userId === 'string' ? body.userId.trim() : ''
    if (!targetId) {
      return NextResponse.json({ error: 'USER_ID_REQUIRED' }, { status: 400 })
    }
    if (targetId === me.id) {
      return NextResponse.json({ error: 'USER_NOT_FOUND' }, { status: 404 })
    }

    const target = await db.user.findUnique({ where: { id: targetId } })
    if (!target || target.isGuest) {
      return NextResponse.json({ error: 'USER_NOT_FOUND' }, { status: 404 })
    }

    const pairKey = [me.id, target.id].sort().join('|')
    const conversation = await db.conversation.upsert({
      where: { key: pairKey },
      update: {},
      create: {
        type: 'private',
        key: pairKey,
        participants: { create: [{ userId: me.id }, { userId: target.id }] },
      },
      include: { participants: { include: { user: true } } },
    })

    const otherRow =
      conversation.participants.find((p) => p.userId !== me.id)?.user ?? target

    return NextResponse.json({
      conversation: {
        id: conversation.id,
        type: 'private',
        other: {
          id: otherRow.id,
          name: otherRow.name,
          avatarColor: otherRow.avatarColor,
          lastSeen: otherRow.lastSeen,
        },
      },
    })
  } catch (error) {
    console.error('[conversations POST] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
