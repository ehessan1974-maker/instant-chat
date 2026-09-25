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
        ...(m.mediaUrl !== null ? { mediaUrl: m.mediaUrl } : {}),
        ...(m.durationMs !== null ? { durationMs: m.durationMs } : {}),
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

/**
 * POST /api/conversations/[id]/messages
 * body: { text, clientId? }
 * → { message: {...} }
 * بديل REST لإرسال الرسائل (تستخدمه النسخة الخفيفة legacy.html للمتصفحات
 * القديمة التي لا تشغّل socket.io) — نفس قواعد السوكيت: نص ≤4000 حرف ومشاركة مطلوبة.
 */
export async function POST(
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

    let body: { text?: unknown; clientId?: unknown } = {}
    try {
      const raw = await req.text()
      if (raw) body = JSON.parse(raw) as { text?: unknown; clientId?: unknown }
    } catch {
      return NextResponse.json({ error: 'BAD_JSON' }, { status: 400 })
    }

    // نفس حدود السوكيت: نص فقط، حتى 4000 حرف
    const text = String(body?.text ?? '').trim().slice(0, 4000)
    if (!text) {
      return NextResponse.json({ error: 'EMPTY_MESSAGE' }, { status: 400 })
    }
    const clientId =
      typeof body?.clientId === 'string' && body.clientId
        ? body.clientId.slice(0, 64)
        : null

    const conv = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { type: true },
    })
    if (!conv) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
    }

    const m = await db.message.create({
      data: {
        conversationId,
        senderId: me.id,
        type: 'text',
        text,
        clientId,
      },
      include: {
        sender: { select: { id: true, name: true, avatarColor: true } },
      },
    })

    // الإرسال عبر REST يعني قراءة فعليّة لما قبله في هذه المحادثة
    await db.conversationParticipant.update({
      where: { id: membership.id },
      data: { lastReadAt: new Date() },
    })

    return NextResponse.json({
      message: {
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        type: m.type,
        text: m.text,
        clientId: m.clientId,
        createdAt: m.createdAt,
        sender: {
          id: m.sender.id,
          name: m.sender.name,
          avatarColor: m.sender.avatarColor,
        },
      },
    })
  } catch (error) {
    console.error('[messages POST] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}

/**
 * PATCH /api/conversations/[id]/read
 * يحدّث lastReadAt لمشاركة المستخدم الحالي — بديل REST لحدث السوكيت 'read'
 * (تستخدمه النسخة الخفيفة حتى يتصفّر عدّاد غير المقروء على الخادم).
 */
export async function PATCH(
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

    await db.conversationParticipant.update({
      where: { id: membership.id },
      data: { lastReadAt: new Date() },
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[messages PATCH read] failed:', error)
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 })
  }
}
