// ============================================================
// chat-service — Socket.IO chat mini-service (port 3003)
// + Legacy bridge for the old InstantChat APK (socket.io protocol)
// + Voice messages (MediaRecorder base64 → disk) + WebRTC call signaling
// + Group management (create_group / add_members / leave_group)
// Contract: /home/z/my-project/worklog.md === CONTRACT v2 ===
// Schema:   /home/z/my-project/prisma/schema.prisma (shared SQLite)
// Reference: /home/z/my-project/examples/websocket/server.ts
// ============================================================
import { createServer } from 'http'
import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
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

// ---------------------------------------------------------------------------
// Voice storage — files land in <project>/db/voice (shared with the Next.js
// media route which reads the same folder).
// ---------------------------------------------------------------------------
const VOICE_DIR = process.env.VOICE_DIR || path.resolve(process.cwd(), '../../db/voice')
/** decoded binary size cap per voice note */
const MAX_VOICE_BYTES = 10 * 1024 * 1024

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
// maxHttpBufferSize raised to carry base64 voice notes (≤ ~10MB binary).
// ---------------------------------------------------------------------------
const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 20e6,
})

type Sender = { id: string; name: string; avatarColor: string }
type DbMessage = {
  id: string
  conversationId: string
  senderId: string
  type: string
  text: string
  mediaUrl: string | null
  durationMs: number | null
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
    mediaUrl: m.mediaUrl,
    durationMs: m.durationMs,
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
    text: m.type === 'voice' ? '🎙️ رسالة صوتية' : m.text,
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

/** Emit to a user's personal room (no-op if offline). */
function emitToUser(userId: string, event: string, payload: unknown): void {
  if (userSockets.has(userId)) io.to(`user:${userId}`).emit(event, payload)
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

/** Join every live socket of the given users to the conversation room. */
function joinSocketsToConv(userIds: string[], conversationId: string): void {
  for (const uid of userIds) {
    const set = userSockets.get(uid)
    if (!set) continue
    for (const sid of set) io.sockets.sockets.get(sid)?.join(`conv:${conversationId}`)
  }
}

async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const p = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId },
    select: { id: true },
  })
  return !!p
}

/** Private-only: delivery receipts to online participants of a conversation. */
async function sendDeliveryReceipts(conversationId: string, senderId: string): Promise<void> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { type: true },
  })
  if (conv?.type !== 'private') return
  const ids = await participantIds(conversationId)
  const at = new Date().toISOString()
  for (const o of ids) {
    if (o === senderId) continue
    if (userSockets.has(o)) {
      emitToParticipants(ids, 'messages_delivered', { conversationId, userId: o, at }, o)
    }
  }
}

// ---------------------------------------------------------------------------
// Group summaries (shape matches GET /api/conversations for groups + members)
// ---------------------------------------------------------------------------
type MemberSummary = { id: string; name: string; avatarColor: string; phone: string }

async function loadMembers(conversationId: string): Promise<MemberSummary[]> {
  const rows = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    orderBy: { joinedAt: 'asc' },
    select: { user: { select: { id: true, name: true, avatarColor: true, phone: true } } },
  })
  return rows.map((r) => ({
    id: r.user.id,
    name: r.user.name,
    avatarColor: r.user.avatarColor,
    phone: r.user.phone,
  }))
}

const EPOCH = new Date(0)

async function loadGroupSummary(conversationId: string, forUserId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      participants: { select: { userId: true, lastReadAt: true } },
      messages: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        include: { sender: { select: { name: true } } },
      },
    },
  })
  if (!conv || conv.type !== 'group') return null
  const mine = conv.participants.find((p) => p.userId === forUserId)
  if (!mine) return null
  const lastRow = conv.messages[0] ?? null
  const unreadCount = await prisma.message.count({
    where: {
      conversationId,
      senderId: { not: forUserId },
      createdAt: { gt: mine.lastReadAt ?? EPOCH },
    },
  })
  const members = await loadMembers(conversationId)
  return {
    id: conv.id,
    type: 'group',
    name: conv.name,
    creatorId: conv.creatorId,
    unreadCount,
    myLastReadAt: (mine.lastReadAt ?? null)?.toISOString() ?? null,
    members,
    ...(lastRow
      ? {
          lastMessage: {
            id: lastRow.id,
            text: lastRow.text,
            createdAt: lastRow.createdAt.toISOString(),
            senderId: lastRow.senderId,
            senderName: lastRow.sender.name,
            type: lastRow.type,
            mediaUrl: lastRow.mediaUrl,
            durationMs: lastRow.durationMs,
          },
        }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Call signaling state (1:1 WebRTC — audio or video)
// ---------------------------------------------------------------------------
type CallKind = 'audio' | 'video'
interface CallInfo {
  id: string
  callerId: string
  calleeId: string
  kind: CallKind
  state: 'ringing' | 'connecting' | 'active'
  /** السوكيت الذي قبل المكالمة — يُستخدم لعزل إشارات أجهزة أخرى لنفس الحساب */
  acceptSocketId: string | null
  ringTimer: ReturnType<typeof setTimeout> | null
  createdAt: Date
}

const calls = new Map<string, CallInfo>()
const callByUser = new Map<string, string>() // userId -> callId (both parties)
const RING_TIMEOUT_MS = 45000

function cleanupCall(callId: string): void {
  const c = calls.get(callId)
  if (!c) return
  if (c.ringTimer) clearTimeout(c.ringTimer)
  calls.delete(callId)
  if (callByUser.get(c.callerId) === callId) callByUser.delete(c.callerId)
  if (callByUser.get(c.calleeId) === callId) callByUser.delete(c.calleeId)
}

function getCall(callId: string): CallInfo | null {
  const c = calls.get(callId)
  return c ?? null
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
        text: m.type === 'voice' ? '🎙️ رسالة صوتية' : m.text,
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
    await sendDeliveryReceipts(conversationId, web.userId)
  } catch (e) {
    console.error('[chat-service] send_message error:', e)
  }
}

// ---------------------------------------------------------------------------
// Voice messages — send_voice {conversationId, clientId, durationMs, mime,
// audioBase64} → server writes file to VOICE_DIR, stores Message type='voice'
// with mediaUrl `/api/media/voice/<file>` and broadcasts like a normal message.
// ---------------------------------------------------------------------------
function voiceExt(mime: string): string {
  const m = (mime || '').toLowerCase()
  if (m.includes('webm')) return 'webm'
  if (m.includes('mp4') || m.includes('m4a')) return 'mp4'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('aac')) return 'aac'
  if (m.includes('wav')) return 'wav'
  if (m.includes('opus')) return 'opus'
  return 'webm'
}

function handleSendVoice(socket: Socket, data: any, ack?: unknown): void {
  const respond = (r: Record<string, unknown>) => {
    if (typeof ack === 'function') {
      try {
        ;(ack as (x: unknown) => void)(r)
      } catch {}
    }
  }
  const web = webSockets.get(socket.id)
  if (!web) return respond({ ok: false, error: 'UNAUTHORIZED' })

  void (async () => {
    try {
      const conversationId = String(data?.conversationId ?? '')
      const b64 = typeof data?.audioBase64 === 'string' ? data.audioBase64 : ''
      if (!conversationId || !b64) return respond({ ok: false, error: 'BAD_PAYLOAD' })
      // base64 inflates by 4/3 → reject early before decoding
      if (b64.length > Math.ceil(MAX_VOICE_BYTES * 1.4)) return respond({ ok: false, error: 'TOO_LARGE' })
      if (!(await isParticipant(conversationId, web.userId))) {
        return respond({ ok: false, error: 'FORBIDDEN' })
      }

      const durationMs = Math.max(0, Math.min(600000, Math.round(Number(data?.durationMs ?? 0)) || 0))
      const mime = String(data?.mime ?? 'audio/webm').slice(0, 100)
      const clientId = typeof data?.clientId === 'string' ? data.clientId.slice(0, 64) : null

      const buf = Buffer.from(b64, 'base64')
      if (buf.length === 0 || buf.length > MAX_VOICE_BYTES) return respond({ ok: false, error: 'TOO_LARGE' })

      await mkdir(VOICE_DIR, { recursive: true })
      const filename = `${randomUUID()}.${voiceExt(mime)}`
      await writeFile(path.join(VOICE_DIR, filename), buf)

      const m = await prisma.message.create({
        data: {
          conversationId,
          senderId: web.userId,
          type: 'voice',
          text: '',
          mediaUrl: `/api/media/voice/${filename}`,
          durationMs,
          clientId,
        },
        include: { sender: { select: { id: true, name: true, avatarColor: true } } },
      })
      await broadcastNewMessage(conversationId, m as unknown as DbMessage)
      await sendDeliveryReceipts(conversationId, web.userId)

      respond({ ok: true, message: officialMessage(m as unknown as DbMessage) })
      console.log(
        `[chat-service] voice message from ${web.name} (${Math.round(buf.length / 1024)}KB, ${durationMs}ms)`
      )
    } catch (e) {
      console.error('[chat-service] send_voice error:', e)
      respond({ ok: false, error: 'SERVER_ERROR' })
    }
  })()
}

// ---------------------------------------------------------------------------
// Groups — create_group / add_members / leave_group (all with acks).
// Members are chosen by the group creator from real (non-guest) users.
// System messages document every change and are broadcast as new_message.
// ---------------------------------------------------------------------------
function handleCreateGroup(socket: Socket, data: any, ack?: unknown): void {
  const respond = (r: Record<string, unknown>) => {
    if (typeof ack === 'function') {
      try {
        ;(ack as (x: unknown) => void)(r)
      } catch {}
    }
  }
  const web = webSockets.get(socket.id)
  if (!web) return respond({ ok: false, error: 'UNAUTHORIZED' })

  void (async () => {
    try {
      const name = String(data?.name ?? '').trim().slice(0, 60)
      if (!name) return respond({ ok: false, error: 'NAME_REQUIRED' })

      const rawIds: string[] = Array.isArray(data?.memberIds)
        ? data.memberIds.map((x: unknown) => String(x ?? '').trim()).filter(Boolean)
        : []
      const uniqueIds = [...new Set(rawIds)].filter((id) => id !== web.userId).slice(0, 100)
      if (uniqueIds.length === 0) return respond({ ok: false, error: 'MEMBERS_REQUIRED' })

      const members = await prisma.user.findMany({
        where: { id: { in: uniqueIds }, isGuest: false },
        select: { id: true },
      })
      if (members.length === 0) return respond({ ok: false, error: 'MEMBERS_REQUIRED' })

      const conv = await prisma.conversation.create({
        data: {
          type: 'group',
          name,
          creatorId: web.userId,
          participants: {
            create: [{ userId: web.userId }, ...members.map((u) => ({ userId: u.id }))],
          },
        },
        select: { id: true },
      })

      const allIds = [web.userId, ...members.map((u) => u.id)]
      joinSocketsToConv(allIds, conv.id)

      const sys = await prisma.message.create({
        data: {
          conversationId: conv.id,
          senderId: web.userId,
          type: 'system',
          text: `${web.name} أنشأ المجموعة «${name}»`,
        },
        include: { sender: { select: { id: true, name: true, avatarColor: true } } },
      })
      await broadcastNewMessage(conv.id, sys as unknown as DbMessage)

      for (const uid of allIds) {
        const summary = await loadGroupSummary(conv.id, uid)
        if (summary) emitToUser(uid, 'group_created', { conversation: summary })
      }

      const mySummary = await loadGroupSummary(conv.id, web.userId)
      respond({ ok: true, conversation: mySummary })
      console.log(`[chat-service] group created: «${name}» by ${web.name} (${members.length} members)`)
    } catch (e) {
      console.error('[chat-service] create_group error:', e)
      respond({ ok: false, error: 'SERVER_ERROR' })
    }
  })()
}

function handleAddMembers(socket: Socket, data: any, ack?: unknown): void {
  const respond = (r: Record<string, unknown>) => {
    if (typeof ack === 'function') {
      try {
        ;(ack as (x: unknown) => void)(r)
      } catch {}
    }
  }
  const web = webSockets.get(socket.id)
  if (!web) return respond({ ok: false, error: 'UNAUTHORIZED' })

  void (async () => {
    try {
      const conversationId = String(data?.conversationId ?? '')
      if (!conversationId) return respond({ ok: false, error: 'BAD_PAYLOAD' })
      if (!(await isParticipant(conversationId, web.userId))) {
        return respond({ ok: false, error: 'FORBIDDEN' })
      }
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { type: true },
      })
      if (!conv || conv.type !== 'group') return respond({ ok: false, error: 'NOT_FOUND' })

      const rawIds: string[] = Array.isArray(data?.memberIds)
        ? data.memberIds.map((x: unknown) => String(x ?? '').trim()).filter(Boolean)
        : []
      const uniqueIds = [...new Set(rawIds)].slice(0, 100)
      if (uniqueIds.length === 0) return respond({ ok: false, error: 'MEMBERS_REQUIRED' })

      const existing = await prisma.conversationParticipant.findMany({
        where: { conversationId },
        select: { userId: true },
      })
      const existingSet = new Set(existing.map((e) => e.userId))

      const candidates = await prisma.user.findMany({
        where: { id: { in: uniqueIds }, isGuest: false },
        select: { id: true, name: true },
      })
      const toAdd = candidates.filter((u) => !existingSet.has(u.id))
      if (toAdd.length === 0) return respond({ ok: false, error: 'NO_NEW_MEMBERS' })

      await prisma.conversationParticipant.createMany({
        data: toAdd.map((u) => ({ conversationId, userId: u.id })),
      })
      joinSocketsToConv(toAdd.map((u) => u.id), conversationId)

      const sys = await prisma.message.create({
        data: {
          conversationId,
          senderId: web.userId,
          type: 'system',
          text: `${web.name} أضاف ${toAdd.map((u) => u.name).join('، ')}`,
        },
        include: { sender: { select: { id: true, name: true, avatarColor: true } } },
      })

      // first: full summary to the newly added (their client learns about the group)
      for (const u of toAdd) {
        const summary = await loadGroupSummary(conversationId, u.id)
        if (summary) emitToUser(u.id, 'group_created', { conversation: summary })
      }
      // then: the system message to everyone (preview + open chat append)
      await broadcastNewMessage(conversationId, sys as unknown as DbMessage)
      // member list update to existing members
      const members = await loadMembers(conversationId)
      emitToParticipants(
        existing.map((e) => e.userId),
        'group_members_changed',
        { conversationId, members, added: toAdd.map((u) => ({ id: u.id, name: u.name })) }
      )

      respond({ ok: true, added: toAdd.map((u) => ({ id: u.id, name: u.name })) })
      console.log(`[chat-service] group ${conversationId}: +${toAdd.length} member(s) by ${web.name}`)
    } catch (e) {
      console.error('[chat-service] add_members error:', e)
      respond({ ok: false, error: 'SERVER_ERROR' })
    }
  })()
}

function handleLeaveGroup(socket: Socket, data: any, ack?: unknown): void {
  const respond = (r: Record<string, unknown>) => {
    if (typeof ack === 'function') {
      try {
        ;(ack as (x: unknown) => void)(r)
      } catch {}
    }
  }
  const web = webSockets.get(socket.id)
  if (!web) return respond({ ok: false, error: 'UNAUTHORIZED' })

  void (async () => {
    try {
      const conversationId = String(data?.conversationId ?? '')
      if (!conversationId) return respond({ ok: false, error: 'BAD_PAYLOAD' })

      const p = await prisma.conversationParticipant.findFirst({
        where: { conversationId, userId: web.userId },
        select: { id: true },
      })
      if (!p) return respond({ ok: false, error: 'NOT_MEMBER' })
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { type: true },
      })
      if (!conv || conv.type !== 'group') return respond({ ok: false, error: 'NOT_FOUND' })

      await prisma.conversationParticipant.delete({ where: { id: p.id } })

      const sys = await prisma.message.create({
        data: {
          conversationId,
          senderId: web.userId,
          type: 'system',
          text: `${web.name} غادر المجموعة`,
        },
        include: { sender: { select: { id: true, name: true, avatarColor: true } } },
      })

      const remaining = await participantIds(conversationId)
      // everyone except the leaver
      emitToParticipants(remaining, 'new_message', { message: officialMessage(sys as unknown as DbMessage) }, web.userId)
      emitToParticipants(
        remaining,
        'group_members_changed',
        {
          conversationId,
          members: await loadMembers(conversationId),
          left: { id: web.userId, name: web.name },
        },
        web.userId
      )
      // the leaver removes the conversation from his list
      emitToUser(web.userId, 'group_left', { conversationId })

      // empty group → delete conversation (messages cascade)
      if (remaining.length === 0) {
        await prisma.conversation.delete({ where: { id: conversationId } }).catch(() => {})
      }

      respond({ ok: true })
      console.log(`[chat-service] group ${conversationId}: ${web.name} left`)
    } catch (e) {
      console.error('[chat-service] leave_group error:', e)
      respond({ ok: false, error: 'SERVER_ERROR' })
    }
  })()
}

// ---------------------------------------------------------------------------
// WebRTC call signaling (1:1)
//   caller → server: call_invite{to,kind}(ack) · call_cancel{callId}
//                    call_offer{callId,sdp} · call_ice{callId,candidate}
//                    call_end{callId}
//   callee → server: call_accept{callId} · call_reject{callId}
//                    call_answer{callId,sdp} · call_ice{callId,candidate}
//                    call_end{callId}
//   server → caller: call_accepted · call_rejected{reason} · call_ended{reason}
//                    call_ice · call_answer{sdp}
//   server → callee: call_incoming{callId,from,kind} · call_cancelled{reason}
//                    call_offer{sdp} · call_ended{reason} · call_ice
// ---------------------------------------------------------------------------
function handleCallInvite(socket: Socket, data: any, ack?: unknown): void {
  const respond = (r: Record<string, unknown>) => {
    if (typeof ack === 'function') {
      try {
        ;(ack as (x: unknown) => void)(r)
      } catch {}
    }
  }
  const web = webSockets.get(socket.id)
  if (!web) return respond({ ok: false, error: 'UNAUTHORIZED' })

  const to = String(data?.to ?? '').trim()
  const kind: CallKind = data?.kind === 'video' ? 'video' : 'audio'
  if (!to || to === web.userId) return respond({ ok: false, error: 'BAD_TARGET' })
  if (callByUser.has(web.userId)) return respond({ ok: false, error: 'IN_CALL' })

  void (async () => {
    try {
      const target = await prisma.user.findUnique({
        where: { id: to },
        select: { id: true, name: true, isGuest: true },
      })
      if (!target || target.isGuest) return respond({ ok: false, error: 'UNAVAILABLE' })
      if (!userSockets.has(to)) return respond({ ok: false, error: 'OFFLINE' })
      if (callByUser.has(to)) return respond({ ok: false, error: 'BUSY' })

      const callId = randomUUID()
      const info: CallInfo = {
        id: callId,
        callerId: web.userId,
        calleeId: to,
        kind,
        state: 'ringing',
        acceptSocketId: null,
        ringTimer: null,
        createdAt: new Date(),
      }
      info.ringTimer = setTimeout(() => {
        const c = calls.get(callId)
        if (!c || c.state !== 'ringing') return
        emitToUser(c.callerId, 'call_ended', { callId, reason: 'no-answer' })
        emitToUser(c.calleeId, 'call_cancelled', { callId, reason: 'timeout' })
        cleanupCall(callId)
      }, RING_TIMEOUT_MS)
      calls.set(callId, info)
      callByUser.set(web.userId, callId)
      callByUser.set(to, callId)

      io.to(`user:${to}`).emit('call_incoming', {
        callId,
        from: { id: web.userId, name: web.name, avatarColor: web.avatarColor },
        kind,
      })
      respond({ ok: true, callId })
      console.log(`[chat-service] call ringing: ${web.name} → ${target.name} (${kind})`)
    } catch (e) {
      console.error('[chat-service] call_invite error:', e)
      respond({ ok: false, error: 'SERVER_ERROR' })
    }
  })()
}

function handleCallCancel(socket: Socket, data: any, ack?: unknown): void {
  const respond = (r: Record<string, unknown>) => {
    if (typeof ack === 'function') {
      try {
        ;(ack as (x: unknown) => void)(r)
      } catch {}
    }
  }
  const web = webSockets.get(socket.id)
  if (!web) return respond({ ok: false, error: 'UNAUTHORIZED' })
  const callId = String(data?.callId ?? '')
  const c = getCall(callId)
  if (!c || c.callerId !== web.userId) return respond({ ok: false, error: 'NOT_FOUND' })
  if (c.state !== 'ringing') return respond({ ok: false, error: 'NOT_RINGING' })
  cleanupCall(callId)
  emitToUser(c.calleeId, 'call_cancelled', { callId, reason: 'cancel' })
  respond({ ok: true })
  console.log(`[chat-service] call cancelled by caller (${callId.slice(0, 8)})`)
}

function handleCallAccept(socket: Socket, data: any, ack?: unknown): void {
  const respond = (r: Record<string, unknown>) => {
    if (typeof ack === 'function') {
      try {
        ;(ack as (x: unknown) => void)(r)
      } catch {}
    }
  }
  const web = webSockets.get(socket.id)
  if (!web) return respond({ ok: false, error: 'UNAUTHORIZED' })
  const callId = String(data?.callId ?? '')
  const c = getCall(callId)
  if (!c || c.calleeId !== web.userId) return respond({ ok: false, error: 'NOT_FOUND' })
  if (c.state !== 'ringing') return respond({ ok: false, error: 'NOT_RINGING' })
  if (c.ringTimer) {
    clearTimeout(c.ringTimer)
    c.ringTimer = null
  }
  c.state = 'connecting'
  c.acceptSocketId = socket.id
  // أوقف الرنين على أجهزة أخرى لنفس الحساب (نفس المستخدم من متصفح/جهاز ثانٍ)
  socket.to(`user:${c.calleeId}`).emit('call_cancelled', { callId, reason: 'answered-elsewhere' })
  emitToUser(c.callerId, 'call_accepted', { callId, kind: c.kind })
  respond({ ok: true })
  console.log(`[chat-service] call accepted (${callId.slice(0, 8)})`)
}

function handleCallReject(socket: Socket, data: any, ack?: unknown): void {
  const respond = (r: Record<string, unknown>) => {
    if (typeof ack === 'function') {
      try {
        ;(ack as (x: unknown) => void)(r)
      } catch {}
    }
  }
  const web = webSockets.get(socket.id)
  if (!web) return respond({ ok: false, error: 'UNAUTHORIZED' })
  const callId = String(data?.callId ?? '')
  const c = getCall(callId)
  if (!c || c.calleeId !== web.userId) return respond({ ok: false, error: 'NOT_FOUND' })
  // حماية تعدد الأجهزة: بعد قبول جهازٍ ما للاتصال، رفض جهاز آخر لا يعني شيئاً
  if (c.state !== 'ringing') return respond({ ok: false, error: 'NOT_RINGING' })
  cleanupCall(callId)
  emitToUser(c.callerId, 'call_rejected', { callId, reason: 'declined' })
  respond({ ok: true })
  console.log(`[chat-service] call declined (${callId.slice(0, 8)})`)
}

function handleCallOffer(socket: Socket, data: any, ack?: unknown): void {
  const web = webSockets.get(socket.id)
  if (!web) return
  const callId = String(data?.callId ?? '')
  const sdp = typeof data?.sdp === 'string' ? data.sdp : ''
  if (!callId || !sdp) return
  const c = getCall(callId)
  if (!c || c.callerId !== web.userId) return
  emitToUser(c.calleeId, 'call_offer', { callId, sdp })
  if (typeof ack === 'function') {
    try {
      ;(ack as (x: unknown) => void)({ ok: true })
    } catch {}
  }
}

function handleCallAnswer(socket: Socket, data: any, ack?: unknown): void {
  const web = webSockets.get(socket.id)
  if (!web) return
  const callId = String(data?.callId ?? '')
  const sdp = typeof data?.sdp === 'string' ? data.sdp : ''
  if (!callId || !sdp) return
  const c = getCall(callId)
  if (!c || c.calleeId !== web.userId) return
  // حصر الـ SDP بجهاز القبول فقط (حماية تعدد الأجهزة لنفس الحساب)
  if (c.acceptSocketId && socket.id !== c.acceptSocketId) return
  c.state = 'active'
  emitToUser(c.callerId, 'call_answer', { callId, sdp })
  if (typeof ack === 'function') {
    try {
      ;(ack as (x: unknown) => void)({ ok: true })
    } catch {}
  }
}

function handleCallIce(socket: Socket, data: any, ack?: unknown): void {
  const web = webSockets.get(socket.id)
  if (!web) return
  const callId = String(data?.callId ?? '')
  if (!callId) return
  const c = getCall(callId)
  if (!c || (c.callerId !== web.userId && c.calleeId !== web.userId)) return
  // من جهة المستقبِل: حصر ICE بجهاز القبول فقط
  if (c.calleeId === web.userId && c.acceptSocketId && socket.id !== c.acceptSocketId) return
  const other = c.callerId === web.userId ? c.calleeId : c.callerId
  emitToUser(other, 'call_ice', { callId, candidate: data?.candidate ?? null })
  if (typeof ack === 'function') {
    try {
      ;(ack as (x: unknown) => void)({ ok: true })
    } catch {}
  }
}

function handleCallEnd(socket: Socket, data: any, ack?: unknown): void {
  const respond = (r: Record<string, unknown>) => {
    if (typeof ack === 'function') {
      try {
        ;(ack as (x: unknown) => void)(r)
      } catch {}
    }
  }
  const web = webSockets.get(socket.id)
  if (!web) return respond({ ok: false, error: 'UNAUTHORIZED' })
  const callId = String(data?.callId ?? '')
  const c = getCall(callId)
  if (!c || (c.callerId !== web.userId && c.calleeId !== web.userId)) {
    return respond({ ok: false, error: 'NOT_FOUND' })
  }
  const other = c.callerId === web.userId ? c.calleeId : c.callerId
  cleanupCall(callId)
  emitToUser(other, 'call_ended', { callId, reason: 'hangup' })
  respond({ ok: true })
  console.log(`[chat-service] call ended (${callId.slice(0, 8)})`)
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

      // abort any active/ringing call of this user
      const callId = callByUser.get(web.userId)
      if (callId) {
        const c = getCall(callId)
        if (c) {
          const other = c.callerId === web.userId ? c.calleeId : c.callerId
          cleanupCall(callId)
          emitToUser(other, 'call_ended', { callId, reason: 'disconnected' })
        }
      }

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

  // voice messages
  socket.on('send_voice', (data: unknown, ack?: unknown) => handleSendVoice(socket, data, ack))

  // groups
  socket.on('create_group', (data: unknown, ack?: unknown) => handleCreateGroup(socket, data, ack))
  socket.on('add_members', (data: unknown, ack?: unknown) => handleAddMembers(socket, data, ack))
  socket.on('leave_group', (data: unknown, ack?: unknown) => handleLeaveGroup(socket, data, ack))

  // calls (WebRTC signaling)
  socket.on('call_invite', (data: unknown, ack?: unknown) => handleCallInvite(socket, data, ack))
  socket.on('call_cancel', (data: unknown, ack?: unknown) => handleCallCancel(socket, data, ack))
  socket.on('call_accept', (data: unknown, ack?: unknown) => handleCallAccept(socket, data, ack))
  socket.on('call_reject', (data: unknown, ack?: unknown) => handleCallReject(socket, data, ack))
  socket.on('call_offer', (data: unknown, ack?: unknown) => handleCallOffer(socket, data, ack))
  socket.on('call_answer', (data: unknown, ack?: unknown) => handleCallAnswer(socket, data, ack))
  socket.on('call_ice', (data: unknown, ack?: unknown) => handleCallIce(socket, data, ack))
  socket.on('call_end', (data: unknown, ack?: unknown) => handleCallEnd(socket, data, ack))

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
    await mkdir(VOICE_DIR, { recursive: true })
  } catch (e) {
    console.error('[chat-service] voice dir creation failed:', e)
  }
  try {
    const pub = await ensurePublicRoom()
    console.log(`[chat-service] legacy public room ready (${pub.id})`)
  } catch (e) {
    console.error('[chat-service] ensurePublicRoom failed at boot (will retry on demand):', e)
  }
  httpServer.listen(PORT, () => {
    console.log(`[chat-service] Socket.IO chat service listening on :${PORT} (path '/' — web + legacy APK + voice + calls + groups)`)
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
