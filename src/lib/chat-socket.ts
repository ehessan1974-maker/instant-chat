'use client';

// سينغلتون Socket.IO للاتصال بخدمة المحادثة.
// قابل للتهيئة عبر متغيرات البيئة:
//  - NEXT_PUBLIC_SOCKET_URL  عنوان الخدمة (فارغ = نفس الدومين)
//      بيئة بوابة Caddy:  /?XTransformPort=3003
//      نشر مباشر:          http://IP:3003
//  - NEXT_PUBLIC_SOCKET_PATH مسار socket.io (الافتراضي /socket.io كما في APK)
//      بيئة البوابة تحتاج: /
// ملاحظة StrictMode: connectChatSocket يقطع الاتصال القديم قبل إنشاء الجديد
// حتى لا تتكرر المستمعات أو تتكدس الاتصالات عند تشغيل التأثيرات مرتين.

import { io, type Socket } from 'socket.io-client';

const RAW_URL = (process.env.NEXT_PUBLIC_SOCKET_URL ?? '').trim();
const SOCKET_PATH = (process.env.NEXT_PUBLIC_SOCKET_PATH ?? '/socket.io').trim() || '/socket.io';

let socket: Socket | null = null;
let currentToken: string | null = null;

export function connectChatSocket(token: string): Socket {
  currentToken = token;

  // قطع الاتصال/المستمعات القديمة قبل إنشاء اتصال جديد (حماية من التكرار)
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  const opts = {
    path: SOCKET_PATH,
    transports: ['websocket', 'polling'] as const,
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
  };

  socket = RAW_URL ? io(RAW_URL, opts) : io(opts);

  // إرسال الهوية عند كل اتصال ناجح (أول مرة وعند إعادة الاتصال)
  socket.on('connect', () => {
    socket?.emit('auth', { token: currentToken });
  });

  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function emitSocket(event: string, payload?: unknown): void {
  socket?.emit(event, payload);
}

export function disconnectChatSocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  currentToken = null;
}
