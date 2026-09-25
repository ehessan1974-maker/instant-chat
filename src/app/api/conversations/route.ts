import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser, readJsonRecord } from '@/lib/auth'

interface OtherUser {
  id: string
  name: string
  avatarColor: string
  lastSeen: Date | null
  lastReadAt?: Date | null
}

interface MemberUser {
  id: string
  name: string
  avatarColor: string
  phone: string
}

interface LastMessage {
  id: string
  text: string
  createdAt: Date
  senderId: string
  senderName: string
  type: string
  mediaUrl?: string | null
  durationMs?: number | null
}

interface ConversationSummary {
  id: string
  type: string
  name?: string
  creatorId?: string | null
  other?: OtherUser
  members?: MemberUser[]
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
 * The legacy public room (key='PUBLIC') is hidden from the web app —
 * it only serves the old APK guests.
 */
export async function GET(req: Request) {
  try {
    const me = await getSessionUser(req)
    if (!me) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
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

    const summaries: ConversationSummary[] = []
    for (const p of participations) {
      const conv = p.conversation
      // hide the legacy public room from the web app
      if (conv.key === 'PUBLIC') continue
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
      if (conv.type === 'group') {
        if (conv.name) summary.name = conv.name
        summary.creatorId = conv.creatorId
        summary.members = conv.participants.map((m) => ({
          id: m.user.id,
          name: m.user.name,
          avatarColor: m.user.avatarColor,
          phone: m.user.phone,
        }))
      }
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
          mediaUrl: lastRow.mediaUrl,
          durationMs: lastRow.durationMs,
        }
      }
      summaries.push(summary)
    }

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
