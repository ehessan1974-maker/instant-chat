// ============================================================
// chat-service — Socket.IO chat mini-service (port 3003)
// + Legacy bridge for the old InstantChat APK (socket.io protocol)
// Contract: /home/z/my-project/worklog.md === CONTRACT v1 ===
// Schema:   /home/z/my-project/prisma/schema.prisma (shared SQLite)
// Reference: /home/z/my-project/examples/websocket/server.ts
// ============================================================
import { createServer } from 'http'
import { Server, type Socket } from 'socket.io'
import { PrismaClient } from '@prisma/client'

// ---------------------------------------------------------------------------
// Prisma — same DATABASE_URL as the Next.js main app (SQLite + WAL)
// ---------------------------------------------------------------------------
const prisma = new PrismaClient({ log: ['error', 'warn'] })

async function initSqlitePragmas(): Promise<void> {
  // NOTE: on Prisma 6.19.x SQLite, `PRAGMA x=...` returns a result row, so
  // $executeRawUnsafe rejects it ("Execute returned results"). $queryRawUnsafe
  // applies both pragmas correctly (verified: wal / 5000).
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;')
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000;')
  } catch (e) {
    console.error('[chat-service] failed to set sqlite pragmas:', e)
  }
}

type PublicRoom = { id: string }
let publicRoom: PublicRoom | null = null

async function ensurePublicRoom(): Promise<PublicRoom> {
  if (publicRoom) return publicRoom
  const conv = await prisma.conversation.upsert({
    where: { key: 'PUBLIC' },
    update: {},
    create: { type: 'group', name: 'الغرفة العامة', key: 'PUBLIC' },
    select: { id: true },
  })
  publicRoom = conv
  return conv
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Socket.IO server — path '/' (required by the Caddy gateway).
// NOTE: engine.io matches paths by PREFIX, so a server on '/' also accepts
// the socket.io DEFAULT path '/socket.io' — which is exactly what the old
// InstantChat APK uses with io(url). One server serves web + APK + custom
// reverse-proxy setups. DO NOT change to '/socket.io' or the gateway breaks.
// ---------------------------------------------------------------------------
const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

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

/**
 * Participant userIds of a conversation (fresh from DB — safe for
 * conversations created after the sockets authenticated).
 */
async function participantIds(conversationId: string): Promise<string[]> {
  const rows = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  })
  return rows.map((r) => r.userId)
}

/**
 * Emit to every online real participant of a conversation via their personal
 * `user:<id>` rooms (joined at auth, never stale), optionally excluding one user.
 */
function emitToParticipants(
  userIds: string[],
  event: string,
  payload: unknown,
  excludeUserId?: string
): void {
  const rooms = io.sockets.adapter.rooms
  for (const uid of userIds) {
    if (uid === excludeUserId) continue
    const room = `user:${uid}`
    if (rooms.has(room)) io.to(room).emit(event, payload)
  }
}

/**
 * Fan out a saved message: official shape → each real participant's personal
 * room; legacy shape → connected old-APK guests (public conversation only).
 * Using personal rooms instead of `conv:` rooms guarantees delivery even for
 * conversations created after the sockets authenticated.
 */
async function broadcastNewMessage(conversationId: string, m: DbMessage): Promise<void> {
  const userIds = await participantIds(conversationId)
  emitToParticipants(userIds, 'new_message', { message: officialMessage(m) })
  const pub = await ensurePublicRoom()
  if (conversationId === pub.id) {
    for (const sid of legacyOnline) {
      io.to(sid).emit('new_message', { message: legacyMessage(m) })
    }
  }
}

/** Emit an event only to web sockets currently inside room conv:<conversationId> */
function emitToWebInRoom(conversationId: string, event: string, payload: unknown): void {
  const room = io.sockets.adapter.rooms.get(`conv:${conversationId}`)
  if (!room) return
  for (const sid of room) {
    if (legacySockets.has(sid)) continue
    io.to(sid).emit(event, payload)
  }
}

async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const p = await prisma.conversationParticipant.findFirst({
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
    const session = await prisma.session.findUnique({
      where: { token },
      include: { user: true },
    })
    if (!session) {
      console.log(`[chat-service] auth failed (socket ${socket.id}): invalid token`)
      socket.emit('auth_error', { error: 'INVALID_TOKEN' })
      return
    }
    const user = session.user

    // re-auth safety: drop any previous identity of this socket
    detachSocket(socket.id)

    // join personal room + rooms of his conversations
    socket.join(`user:${user.id}`)
    const convs = await prisma.conversationParticipant.findMany({
      where: { userId: user.id },
      select: { conversationId: true, conversation: { select: { type: true } } },
    })
    for (const c of convs) socket.join(`conv:${c.conversationId}`)

    // defensive: always join the public room so live legacy events reach him
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

    // presence online → other real users only (legacy guests are a separate world)
    for (const uid of userSockets.keys()) {
      if (uid === user.id) continue
      io.to(`user:${uid}`).emit('presence', { userId: user.id, online: true })
    }

    // delivery receipts: tell the others (per conversation) that my messages reached me
    const at = new Date().toISOString()
    for (const c of convs) {
      const ids = await participantIds(c.conversationId)
      emitToParticipants(ids, 'messages_delivered', { conversationId: c.conversationId, userId: user.id, at }, user.id)
    }

    // self-healing read state: replay each conversation's other-participants
    // lastReadAt so check marks converge even if read events were missed
    // while this user's socket was reconnecting.
    for (const c of convs) {
      if (c.conversation.type !== 'private') continue
      const others = await prisma.conversationParticipant.findMany({
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

    console.log(`[chat-service] web user online: ${user.name} (${user.id}) sockets=${set.size}`)
  } catch (e) {
    console.error('[chat-service] auth error:', e)
    try {
      socket.emit('auth_error', { error: 'SERVER_ERROR' })
    } catch {}
  }
}

// ---- legacy guest: login (string name or {name}) ----
async function handleLegacyLogin(socket: Socket, data: any): Promise<void> {
  try {
    if (webSockets.has(socket.id)) return // already authenticated as web client

    const rawName =
      typeof data === 'string' ? data : data && typeof data === 'object' ? String(data.name ?? '') : ''
    const name = rawName.trim().slice(0, 20) || 'ضيف'

    // re-login safety on the same socket
    if (legacySockets.has(socket.id)) detachSocket(socket.id)

    const pub = await ensurePublicRoom()
    const user = await prisma.user.create({
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

    const msgs = await prisma.message.findMany({
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

    // other legacy guests only
    for (const sid of legacyOnline) {
      if (sid === socket.id) continue
      io.to(sid).emit('user_joined', { user: legacyUser, onlineUsers: currentLegacyUsers() })
    }

    // web clients in the public room (system "joined" message)
    emitToWebInRoom(pub.id, 'user_joined', {
      conversationId: pub.id,
      user: { id: legacyUser.id, name: legacyUser.name, avatarColor: legacyUser.color },
    })

    console.log(`[chat-service] legacy guest joined: ${name} (${legacyUser.id})`)
  } catch (e) {
    console.error('[chat-service] login error:', e)
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
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { key: true },
    })
    if (conv?.key === 'PUBLIC') {
      for (const sid of legacyOnline) {
        io.to(sid).emit(typing ? 'user_typing' : 'user_stopped_typing', {
          username: web.name,
        })
      }
    }
  } catch (e) {
    console.error('[chat-service] typing error:', e)
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
      const m = await prisma.message.create({
        data: { conversationId: pub.id, senderId: legacy.user.id, type: 'text', text, clientId: null },
        include: { sender: { select: { id: true, name: true, avatarColor: true } } },
      })
      broadcastNewMessage(pub.id, m as unknown as DbMessage).catch((e) =>
        console.error('[chat-service] legacy broadcast error:', e)
      )
      console.log(`[chat-service] legacy message from ${legacy.user.name} (${text.length} chars)`)
    } catch (e) {
      console.error('[chat-service] legacy send_message error:', e)
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
        `[chat-service] send_message rejected (not a participant): user=${web.userId} conv=${conversationId}`
      )
      return
    }
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { type: true },
    })
    const m = await prisma.message.create({
      data: {
        conversationId,
        senderId: web.userId,
        type: 'text',
        text,
        clientId: d.clientId ?? null,
      },
      include: { sender: { select: { id: true, name: true, avatarColor: true } } },
    })
    // personal rooms of every participant (sender included for confirmation echo)
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
    console.error('[chat-service] send_message error:', e)
  }
}

// ---- web client: read {conversationId} ----
async function handleRead(socket: Socket, data: any): Promise<void> {
  try {
    const web = webSockets.get(socket.id)
    if (!web) return
    const conversationId = String(data?.conversationId ?? '')
    if (!conversationId) return
    const participant = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId: web.userId },
      select: { id: true },
    })
    if (!participant) return
    const now = new Date()
    await prisma.conversationParticipant.update({
      where: { id: participant.id },
      data: { lastReadAt: now },
    })
    // every participant (reader included — ✓✓ turns blue on senders' side)
    const ids = await participantIds(conversationId)
    emitToParticipants(ids, 'messages_read', {
      conversationId,
      userId: web.userId,
      at: now.toISOString(),
    })
  } catch (e) {
    console.error('[chat-service] read error:', e)
  }
}

// ---- web client: sync_read {conversationId} — replay the other side's lastReadAt ----
async function handleSyncRead(socket: Socket, data: any): Promise<void> {
  try {
    const web = webSockets.get(socket.id)
    if (!web) return
    const conversationId = String(data?.conversationId ?? '')
    if (!conversationId) return
    if (!(await isParticipant(conversationId, web.userId))) return
    const others = await prisma.conversationParticipant.findMany({
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
    console.error('[chat-service] sync_read error:', e)
  }
}

// ---- disconnect (web user vs legacy guest) ----
async function handleDisconnect(socket: Socket): Promise<void> {
  try {
    const web = webSockets.get(socket.id)
    if (web) {
      detachSocket(socket.id)
      if (!userSockets.has(web.userId)) {
        // last socket of this real user → lastSeen + offline presence
        const now = new Date()
        try {
          await prisma.user.update({ where: { id: web.userId }, data: { lastSeen: now } })
        } catch (e) {
          console.error('[chat-service] lastSeen update failed:', e)
        }
        const payload = { userId: web.userId, online: false, lastSeen: now.toISOString() }
        for (const uid of userSockets.keys()) {
          io.to(`user:${uid}`).emit('presence', payload)
        }
      }
      console.log(`[chat-service] web user socket closed: ${web.name} (${web.userId})`)
      return
    }

    const legacy = legacySockets.get(socket.id)
    if (legacy) {
      detachSocket(socket.id)
      // NOTE: per task decision — never delete the guest User row.
      // Message.senderId has no onDelete → deletion would fail for guests
      // with messages. We just detach from memory and mark lastSeen.
      try {
        await prisma.user.update({ where: { id: legacy.user.id }, data: { lastSeen: new Date() } })
      } catch {}
      const onlineUsers = currentLegacyUsers()
      for (const sid of legacyOnline) {
        io.to(sid).emit('user_left', { username: legacy.user.name, onlineUsers })
      }
      console.log(`[chat-service] legacy guest left: ${legacy.user.name}`)
    }
  } catch (e) {
    console.error('[chat-service] disconnect error:', e)
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
io.on('connection', (socket: Socket) => {
  socket.on('error', (err) => console.error(`[chat-service] socket error (${socket.id}):`, err))

  socket.on('auth', (data: unknown) => void handleAuth(socket, data))
  socket.on('login', (data: unknown) => void handleLegacyLogin(socket, data))
  socket.on('send_message', (data: unknown) => void handleSendMessage(socket, data))
  socket.on('typing', (data: unknown) => void handleTyping(socket, data, true))
  socket.on('stop_typing', (data: unknown) => void handleTyping(socket, data, false))
  socket.on('read', (data: unknown) => void handleRead(socket, data))
  socket.on('sync_read', (data: unknown) => void handleSyncRead(socket, data))

  socket.on('disconnect', (reason: string) => {
    void handleDisconnect(socket)
  })
})

// ---------------------------------------------------------------------------
// Boot — DB errors must never kill the process
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('[chat-service] uncaughtException (server kept alive):', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[chat-service] unhandledRejection (server kept alive):', reason)
})

// specific port for this mini service (overridable for custom deployments)
const PORT = Number(process.env.CHAT_PORT || 3003)

async function main(): Promise<void> {
  await initSqlitePragmas()
  try {
    const pub = await ensurePublicRoom()
    console.log(`[chat-service] public room ready (${pub.id})`)
  } catch (e) {
    console.error('[chat-service] ensurePublicRoom failed at boot (will retry on demand):', e)
  }
  httpServer.listen(PORT, () => {
    console.log(`[chat-service] Socket.IO chat service listening on :${PORT} (path '/' — serves web + legacy APK)`)
  })
}

void main()

function shutdown(signal: string): void {
  console.log(`[chat-service] received ${signal}, shutting down...`)
  httpServer.close(() => {
    void prisma.$disconnect()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
