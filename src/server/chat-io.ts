// ============================================================
// خدمة المحادثة الحيّة — مدمجة داخل خادم Next.js (نفس المنفذ)
// ============================================================
// نُقل العقد حرفياً من mini-services/chat-service بعد دمجه في
// الخادم الرئيسي حتى تعمل الرسائل الحيّة في بيئة واحدة:
//   - المعاينة المحلية (نفس الأصل)
//   - Render (منفذ واحد فقط)
//   - تطبيق APK القديم (جسر Legacy بنفس الأحداث والأشكال)
//
// العقد (CONTRACT v1):
//   web:   auth{token} → auth_ok | auth_error, send_message, typing,
//          stop_typing, read, sync_read
//   legacy(APK): login(name) → your_info/previous_messages/online_users,
//          send_message (الغرفة العامة فقط)
//   بث:    new_message, user_typing, user_stopped_typing, messages_delivered,
//          messages_read, presence, user_joined, user_left, online_users

import type { Server, Socket } from 'socket.io'
import { db, ensurePublicRoom } from '@/lib/db'

type WebInfo = { kind: 'web'; userId: string; name: string; avatarColor: string }
type LegacyUser = { id: string; name: string; color: string; avatar: string }
type LegacyInfo = { kind: 'legacy'; user: LegacyUser }

/** web sockets: socketId -> info */
const webSockets = new Map<string, WebInfo>()
/** legacy (old APK) sockets: socketId -> info */
const legacySockets = new Map<string, LegacyInfo>()
/** real online users: userId -> set of socketIds (≥1 socket = online) */
const userSockets = new Map<string, Set<string>>()
/** connected legacy guests (socket ids) */
const legacyOnline = new Set<string>()

const WHATSAPP_COLORS = [
  '#00a884', '#128c7e', '#25d366', '#075e54', '#34b7f1', '#0ea5e9',
  '#7c5cff', '#e542a3', '#ff6b6b', '#f4b400', '#8b5cf6', '#14b8a6',
]

function rand3(): string {
  return Math.random().toString(36).slice(2, 5).padEnd(3, '0')
}

function avatarOf(name: string): string {
  return (name || '؟').trim().charAt(0).toUpperCase()
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function currentLegacyUsers(): LegacyUser[] {
  const out: LegacyUser[] = []
  for (const sid of legacyOnline) {
    const info = legacySockets.get(sid)
    if (info) out.push(info.user)
  }
  return out
}

function detachSocket(socketId: string): void {
  const web = webSockets.get(socketId)
  if (web) {
    webSockets.delete(socketId)
    const set = userSockets.get(web.userId)
    if (set) {
      set.delete(socketId)
      if (set.size === 0) userSockets.delete(web.userId)
    }
  }
  if (legacySockets.has(socketId)) {
    legacySockets.delete(socketId)
    legacyOnline.delete(socketId)
  }
}

type Sender = { id: string; name: string; avatarColor: string }
type DbMessage = {
  id: string
  conversationId: string
  senderId: string
  type: string
  text: string
  clientId: string | null
  createdAt: Date
  sender: Sender
}

/** Official (new web) message shape */
function officialMessage(m: DbMessage) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    type: m.type,
    text: m.text,
    clientId: m.clientId,
    createdAt: m.createdAt.toISOString(),
    sender: { id: m.sender.id, name: m.sender.name, avatarColor: m.sender.avatarColor },
  }
}

/** Legacy (old APK) message shape */
function legacyMessage(m: DbMessage) {
  return {
    id: m.id,
    userId: m.senderId,
    username: m.sender.name,
    color: m.sender.avatarColor,
    avatar: avatarOf(m.sender.name),
    text: m.text,
    time: hhmm(m.createdAt),
  }
}

/** Participant userIds of a conversation (fresh from DB) */
async function participantIds(conversationId: string): Promise<string[]> {
  const rows = await db.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  })
  return rows.map((r) => r.userId)
}

let ioRef: Server | null = null

/** Emit to every online real participant via personal `user:<id>` rooms */
function emitToParticipants(
  userIds: string[],
  event: string,
  payload: unknown,
  excludeUserId?: string
): void {
  if (!ioRef) return
  const rooms = ioRef.sockets.adapter.rooms
  for (const uid of userIds) {
    if (uid === excludeUserId) continue
    const room = `user:${uid}`
    if (rooms.has(room)) ioRef.to(room).emit(event, payload)
  }
}

/** Fan out a saved message to web participants + legacy APK guests */
async function broadcastNewMessage(conversationId: string, m: DbMessage): Promise<void> {
  if (!ioRef) return
  const userIds = await participantIds(conversationId)
  emitToParticipants(userIds, 'new_message', { message: officialMessage(m) })
  const pub = await ensurePublicRoom()
  if (conversationId === pub.id) {
    for (const sid of legacyOnline) {
      ioRef.to(sid).emit('new_message', { message: legacyMessage(m) })
    }
  }
}

/** Emit an event only to web sockets currently inside room conv:<conversationId> */
function emitToWebInRoom(conversationId: string, event: string, payload: unknown): void {
  if (!ioRef) return
  const room = ioRef.sockets.adapter.rooms.get(`conv:${conversationId}`)
  if (!room) return
  for (const sid of room) {
    if (legacySockets.has(sid)) continue
    ioRef.to(sid).emit(event, payload)
  }
}

async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const p = await db.conversationParticipant.findFirst({
    where: { conversationId, userId },
    select: { id: true },
  })
  return !!p
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// ---- web client: auth {token} ----
async function handleAuth(socket: Socket, data: any): Promise<void> {
  try {
    const token = typeof data?.token === 'string' ? data.token : ''
    if (!token) {
      socket.emit('auth_error', { error: 'MISSING_TOKEN' })
      return
    }
    const session = await db.session.findUnique({
      where: { token },
      include: { user: true },
    })
    if (!session) {
      console.log(`[chat-io] auth failed (socket ${socket.id}): invalid token`)
      socket.emit('auth_error', { error: 'INVALID_TOKEN' })
      return
    }
    const user = session.user

    // re-auth safety: drop any previous identity of this socket
    detachSocket(socket.id)

    // join personal room + rooms of his conversations
    socket.join(`user:${user.id}`)
    const convs = await db.conversationParticipant.findMany({
      where: { userId: user.id },
      select: { conversationId: true, conversation: { select: { type: true } } },
    })
    for (const c of convs) socket.join(`conv:${c.conversationId}`)

    // defensive: always join the public room
    const pub = await ensurePublicRoom()
    socket.join(`conv:${pub.id}`)

    webSockets.set(socket.id, {
      kind: 'web',
      userId: user.id,
      name: user.name,
      avatarColor: user.avatarColor,
    })
    const set = userSockets.get(user.id) ?? new Set<string>()
    set.add(socket.id)
    userSockets.set(user.id, set)

    socket.emit('auth_ok', {
      user: {
        id: user.id,
        name: user.name,
        avatarColor: user.avatarColor,
        phone: user.phone,
        about: user.about,
      },
      onlineUserIds: [...userSockets.keys()],
    })

    // presence online → other real users only
    for (const uid of userSockets.keys()) {
      if (uid === user.id) continue
      ioRef?.to(`user:${uid}`).emit('presence', { userId: user.id, online: true })
    }

    // delivery receipts for my conversations
    const at = new Date().toISOString()
    for (const c of convs) {
      const ids = await participantIds(c.conversationId)
      emitToParticipants(ids, 'messages_delivered', { conversationId: c.conversationId, userId: user.id, at }, user.id)
    }

    // self-healing read state (private conversations)
    for (const c of convs) {
      if (c.conversation.type !== 'private') continue
      const others = await db.conversationParticipant.findMany({
        where: { conversationId: c.conversationId, NOT: { userId: user.id } },
        select: { userId: true, lastReadAt: true },
      })
      for (const r of others) {
        if (!r.lastReadAt) continue
        socket.emit('messages_read', {
          conversationId: c.conversationId,
          userId: r.userId,
          at: r.lastReadAt.toISOString(),
        })
      }
    }

    console.log(`[chat-io] web user online: ${user.name} (${user.id}) sockets=${set.size}`)
  } catch (e) {
    console.error('[chat-io] auth error:', e)
    try {
      socket.emit('auth_error', { error: 'SERVER_ERROR' })
    } catch {}
  }
}

// ---- legacy guest (old APK): login (string name or {name}) ----
async function handleLegacyLogin(socket: Socket, data: any): Promise<void> {
  try {
    if (webSockets.has(socket.id)) return

    const rawName =
      typeof data === 'string' ? data : data && typeof data === 'object' ? String(data.name ?? '') : ''
    const name = rawName.trim().slice(0, 20) || 'ضيف'

    if (legacySockets.has(socket.id)) detachSocket(socket.id)

    const pub = await ensurePublicRoom()
    const user = await db.user.create({
      data: {
        phone: `guest_${Date.now()}_${rand3()}`,
        name,
        isGuest: true,
        avatarColor: WHATSAPP_COLORS[Math.floor(Math.random() * WHATSAPP_COLORS.length)],
      },
    })
    const legacyUser: LegacyUser = {
      id: user.id,
      name: user.name,
      color: user.avatarColor,
      avatar: avatarOf(user.name),
    }

    socket.join(`conv:${pub.id}`)
    legacySockets.set(socket.id, { kind: 'legacy', user: legacyUser })
    legacyOnline.add(socket.id)

    // old shapes, literally
    socket.emit('your_info', { user: legacyUser })

    const msgs = await db.message.findMany({
      where: { conversationId: pub.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { sender: { select: { id: true, name: true, avatarColor: true } } },
    })
    msgs.reverse()
    socket.emit('previous_messages', {
      messages: msgs.map((m) => ({
        id: m.id,
        userId: m.senderId,
        username: m.sender.name,
        color: m.sender.avatarColor,
        avatar: avatarOf(m.sender.name),
        text: m.text,
        time: hhmm(m.createdAt),
      })),
    })

    socket.emit('online_users', { onlineUsers: currentLegacyUsers() })

    for (const sid of legacyOnline) {
      if (sid === socket.id) continue
      ioRef?.to(sid).emit('user_joined', { user: legacyUser, onlineUsers: currentLegacyUsers() })
    }

    emitToWebInRoom(pub.id, 'user_joined', {
      conversationId: pub.id,
      user: { id: legacyUser.id, name: legacyUser.name, avatarColor: legacyUser.color },
    })

    console.log(`[chat-io] legacy guest joined: ${name} (${legacyUser.id})`)
  } catch (e) {
    console.error('[chat-io] login error:', e)
  }
}

// ---- typing / stop_typing (unified shape serves both kinds) ----
async function handleTyping(socket: Socket, data: any, typing: boolean): Promise<void> {
  try {
    const legacy = legacySockets.get(socket.id)
    if (legacy) {
      const pub = await ensurePublicRoom()
      const payload = {
        conversationId: pub.id,
        userId: legacy.user.id,
        name: legacy.user.name,
        username: legacy.user.name,
      }
      socket.to(`conv:${pub.id}`).emit(typing ? 'user_typing' : 'user_stopped_typing', payload)
      return
    }
    const web = webSockets.get(socket.id)
    if (!web) return
    const conversationId = String(data?.conversationId ?? '')
    if (!conversationId) return
    if (!(await isParticipant(conversationId, web.userId))) return
    const payload = {
      conversationId,
      userId: web.userId,
      name: web.name,
      username: web.name,
    }
    const ids = await participantIds(conversationId)
    emitToParticipants(ids, typing ? 'user_typing' : 'user_stopped_typing', payload, web.userId)

    // old APK guests also see typing of web users in the public room
    const conv = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { key: true },
    })
    if (conv?.key === 'PUBLIC') {
      for (const sid of legacyOnline) {
        ioRef?.to(sid).emit(typing ? 'user_typing' : 'user_stopped_typing', {
          username: web.name,
        })
      }
    }
  } catch (e) {
    console.error('[chat-io] typing error:', e)
  }
}

// ---- send_message (branches by identity: legacy guest vs web user) ----
async function handleSendMessage(socket: Socket, data: any): Promise<void> {
  const d = (data ?? {}) as { conversationId?: string; text?: string; clientId?: string | null }

  // legacy guest → public room only, ≤500 chars
  const legacy = legacySockets.get(socket.id)
  if (legacy) {
    try {
      const text = String(d.text ?? '').trim().slice(0, 500)
      if (!text) return
      const pub = await ensurePublicRoom()
      const m = await db.message.create({
        data: { conversationId: pub.id, senderId: legacy.user.id, type: 'text', text, clientId: null },
        include: { sender: { select: { id: true, name: true, avatarColor: true } } },
      })
      broadcastNewMessage(pub.id, m as unknown as DbMessage).catch((e) =>
        console.error('[chat-io] legacy broadcast error:', e)
      )
      console.log(`[chat-io] legacy message from ${legacy.user.name} (${text.length} chars)`)
    } catch (e) {
      console.error('[chat-io] legacy send_message error:', e)
    }
    return
  }

  // web user
  const web = webSockets.get(socket.id)
  if (!web) return // not authenticated
  try {
    const conversationId = String(d.conversationId ?? '')
    const text = String(d.text ?? '').trim().slice(0, 4000)
    if (!conversationId || !text) return
    if (!(await isParticipant(conversationId, web.userId))) {
      console.log(
        `[chat-io] send_message rejected (not a participant): user=${web.userId} conv=${conversationId}`
      )
      return
    }
    const conv = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { type: true },
    })
    const m = await db.message.create({
      data: {
        conversationId,
        senderId: web.userId,
        type: 'text',
        text,
        clientId: d.clientId ?? null,
      },
      include: { sender: { select: { id: true, name: true, avatarColor: true } } },
    })
    await broadcastNewMessage(conversationId, m as unknown as DbMessage)

    // private only: delivery receipts for online participants
    if (conv?.type === 'private') {
      const ids = await participantIds(conversationId)
      const at = new Date().toISOString()
      for (const o of ids) {
        if (o === web.userId) continue
        if (userSockets.has(o)) {
          emitToParticipants(ids, 'messages_delivered', { conversationId, userId: o, at }, o)
        }
      }
    }
  } catch (e) {
    console.error('[chat-io] send_message error:', e)
  }
}

// ---- web client: read {conversationId} ----
async function handleRead(socket: Socket, data: any): Promise<void> {
  try {
    const web = webSockets.get(socket.id)
    if (!web) return
    const conversationId = String(data?.conversationId ?? '')
    if (!conversationId) return
    const participant = await db.conversationParticipant.findFirst({
      where: { conversationId, userId: web.userId },
      select: { id: true },
    })
    if (!participant) return
    const now = new Date()
    await db.conversationParticipant.update({
      where: { id: participant.id },
      data: { lastReadAt: now },
    })
    const ids = await participantIds(conversationId)
    emitToParticipants(ids, 'messages_read', {
      conversationId,
      userId: web.userId,
      at: now.toISOString(),
    })
  } catch (e) {
    console.error('[chat-io] read error:', e)
  }
}

// ---- web client: sync_read {conversationId} — replay other side's lastReadAt ----
async function handleSyncRead(socket: Socket, data: any): Promise<void> {
  try {
    const web = webSockets.get(socket.id)
    if (!web) return
    const conversationId = String(data?.conversationId ?? '')
    if (!conversationId) return
    if (!(await isParticipant(conversationId, web.userId))) return
    const others = await db.conversationParticipant.findMany({
      where: { conversationId, NOT: { userId: web.userId } },
      select: { userId: true, lastReadAt: true },
    })
    for (const r of others) {
      if (!r.lastReadAt) continue
      socket.emit('messages_read', {
        conversationId,
        userId: r.userId,
        at: r.lastReadAt.toISOString(),
      })
    }
  } catch (e) {
    console.error('[chat-io] sync_read error:', e)
  }
}

// ---- disconnect ----
async function handleDisconnect(socket: Socket): Promise<void> {
  try {
    const web = webSockets.get(socket.id)
    if (web) {
      detachSocket(socket.id)
      if (!userSockets.has(web.userId)) {
        // last socket of this real user → lastSeen + offline presence
        const now = new Date()
        try {
          await db.user.update({ where: { id: web.userId }, data: { lastSeen: now } })
        } catch (e) {
          console.error('[chat-io] lastSeen update failed:', e)
        }
        const payload = { userId: web.userId, online: false, lastSeen: now.toISOString() }
        for (const uid of userSockets.keys()) {
          ioRef?.to(`user:${uid}`).emit('presence', payload)
        }
      }
      console.log(`[chat-io] web user socket closed: ${web.name} (${web.userId})`)
      return
    }

    const legacy = legacySockets.get(socket.id)
    if (legacy) {
      detachSocket(socket.id)
      // NOTE: never delete the guest User row — Message.senderId would block it.
      try {
        await db.user.update({ where: { id: legacy.user.id }, data: { lastSeen: new Date() } })
      } catch {}
      const onlineUsers = currentLegacyUsers()
      for (const sid of legacyOnline) {
        ioRef?.to(sid).emit('user_left', { username: legacy.user.name, onlineUsers })
      }
      console.log(`[chat-io] legacy guest left: ${legacy.user.name}`)
    }
  } catch (e) {
    console.error('[chat-io] disconnect error:', e)
  }
}

/**
 * ربط منطق المحادثة بخادم HTTP لخادم Next المخصص — يُستدعى مرة واحدة من server.ts
 * المسار: /socket.io (يخدم الويب نفس الأصل + APK القديم io(url) الافتراضي)
 */
export function initChatIo(io: Server): void {
  ioRef = io

  io.on('connection', (socket: Socket) => {
    socket.on('error', (err) => console.error(`[chat-io] socket error (${socket.id}):`, err))

    socket.on('auth', (data: unknown) => void handleAuth(socket, data))
    socket.on('login', (data: unknown) => void handleLegacyLogin(socket, data))
    socket.on('send_message', (data: unknown) => void handleSendMessage(socket, data))
    socket.on('typing', (data: unknown) => void handleTyping(socket, data, true))
    socket.on('stop_typing', (data: unknown) => void handleTyping(socket, data, false))
    socket.on('read', (data: unknown) => void handleRead(socket, data))
    socket.on('sync_read', (data: unknown) => void handleSyncRead(socket, data))

    socket.on('disconnect', () => {
      void handleDisconnect(socket)
    })
  })

  // الغرفة العامة جاهزة عند الإقلاع (يعاد إنشاؤها عند الطلب إن فشلت)
  ensurePublicRoom()
    .then((pub) => console.log(`[chat-io] public room ready (${pub.id})`))
    .catch((e) => console.error('[chat-io] ensurePublicRoom failed at boot (will retry on demand):', e))

  console.log('[chat-io] Socket.IO chat merged into Next server (path /socket.io)')
}
