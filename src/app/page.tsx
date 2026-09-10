'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, LogOut, MessageCircle } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { ChatAvatar } from '@/components/chat/avatar';
import { ChatView } from '@/components/chat/chat-view';
import { ConversationList } from '@/components/chat/conversation-list';
import { LoginScreen } from '@/components/chat/login-screen';
import { NewChatDialog } from '@/components/chat/new-chat-dialog';
import {
  ApiError,
  apiLogout,
  clearStoredMe,
  clearToken,
  fetchConversations,
  fetchMe,
  getToken,
  type ChatMessage,
  type Conversation,
  type Me,
} from '@/lib/chat-api';
import { connectChatSocket, disconnectChatSocket } from '@/lib/chat-socket';
import { ts } from '@/lib/chat-utils';
import { ensureAudio, playIncoming } from '@/lib/sounds';
import { useIsMobile } from '@/hooks/use-mobile';

type Phase = 'boot' | 'login' | 'main';

/** ترتيب القائمة: الغرفة العامة أولاً، ثم بحسب آخر رسالة تنازلياً، ثم بلا رسائل */
function sortConversations(list: Conversation[]): Conversation[] {
  const pub = list.filter((c) => c.type === 'group');
  const rest = list.filter((c) => c.type !== 'group');
  const withMsg = rest
    .filter((c) => !!c.lastMessage)
    .sort((a, b) => ts(b.lastMessage?.createdAt) - ts(a.lastMessage?.createdAt));
  const without = rest.filter((c) => !c.lastMessage);
  return [...pub, ...withMsg, ...without];
}

interface NewMessagePayload {
  message?: ChatMessage;
}

interface PresencePayload {
  userId?: string;
  online?: boolean;
  lastSeen?: string | null;
}

interface AuthOkPayload {
  user?: { id: string; name: string; avatarColor: string; phone?: string; about?: string | null };
  onlineUserIds?: string[];
}

interface TypingPayload {
  conversationId?: string;
  userId?: string;
  name?: string;
  username?: string;
}

export default function HomePage() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [me, setMe] = useState<Me | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convLoading, setConvLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [typingPreviews, setTypingPreviews] = useState<Record<string, { name: string; ts: number }>>({});

  const isMobile = useIsMobile();

  const meRef = useRef<Me | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  useEffect(() => {
    meRef.current = me;
    activeIdRef.current = activeId;
    conversationsRef.current = conversations;
  }, [me, activeId, conversations]);

  /* -------------------------- الإقلاع: استعادة الجلسة -------------------------- */
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setPhase('login');
      return;
    }
    fetchMe()
      .then((res) => {
        setMe(res.user);
        setPhase('main');
      })
      .catch(() => {
        clearToken();
        clearStoredMe();
        setPhase('login');
      });
  }, []);

  /* ------------------- تفعيل الصوت عند أول تفاعل (سياسات المتصفح) ------------------- */
  useEffect(() => {
    const prime = () => ensureAudio();
    window.addEventListener('pointerdown', prime, { once: true });
    window.addEventListener('keydown', prime, { once: true });
    return () => {
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
    };
  }, []);

  /* -------------------------- تحميل قائمة المحادثات -------------------------- */
  const refreshConversations = useCallback(async () => {
    setConvLoading(true);
    try {
      const res = await fetchConversations();
      setConversations(sortConversations(res.conversations ?? []));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        clearToken();
        clearStoredMe();
        setMe(null);
        setPhase('login');
      }
    } finally {
      setConvLoading(false);
    }
  }, []);

  useEffect(() => {
    if (phase === 'main') void refreshConversations();
  }, [phase, refreshConversations]);

  /* -------------------------- أحداث السوكيت -------------------------- */
  useEffect(() => {
    if (phase !== 'main' || !me) return;
    const token = getToken();
    if (!token) {
      clearToken();
      clearStoredMe();
      setMe(null);
      setPhase('login');
      return;
    }

    const s = connectChatSocket(token);
    setSocket(s);
    setConnected(false);

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    const onAuthOk = (payload: AuthOkPayload) => {
      setConnected(true);
      setOnlineIds(new Set(payload?.onlineUserIds ?? []));
    };

    const onNewMessage = (payload: NewMessagePayload) => {
      const msg = payload?.message;
      if (!msg) return;
      const conv = conversationsRef.current.find((c) => c.id === msg.conversationId);
      const isOpen = activeIdRef.current === msg.conversationId;
      const isMine = msg.senderId === meRef.current?.id;

      if (conv) {
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === msg.conversationId);
          if (idx === -1) return prev;
          const c = prev[idx];
          const updated: Conversation = {
            ...c,
            lastMessage: {
              id: msg.id,
              text: msg.text,
              createdAt: msg.createdAt,
              senderId: msg.senderId,
              senderName: msg.sender?.name ?? null,
              type: msg.type,
            },
            unreadCount: isMine || isOpen ? 0 : c.unreadCount + 1,
          };
          const next = prev.slice();
          next[idx] = updated;
          return sortConversations(next);
        });
      } else {
        // محادثة غير معروفة (أول رسالة من طرف آخر) — تحديث كامل للقائمة
        void refreshConversations();
      }

      if (!isMine && !isOpen) playIncoming();
    };

    const onPresence = (payload: PresencePayload) => {
      const userId = payload?.userId;
      if (!userId) return;
      setOnlineIds((prev) => {
        const next = new Set(prev);
        if (payload.online) next.add(userId);
        else next.delete(userId);
        return next;
      });
      setConversations((prev) =>
        prev.map((c) =>
          c.other && c.other.id === userId
            ? { ...c, other: { ...c.other, lastSeen: payload.online ? c.other.lastSeen : payload.lastSeen ?? new Date().toISOString() } }
            : c
        )
      );
    };

    const onTyping = (payload: TypingPayload) => {
      const convId = payload?.conversationId;
      if (!convId || payload.userId === meRef.current?.id) return;
      setTypingPreviews((prev) => ({
        ...prev,
        [convId]: { name: payload.name || payload.username || 'شخص ما', ts: Date.now() },
      }));
    };

    const onStopTyping = (payload: TypingPayload) => {
      const convId = payload?.conversationId;
      if (!convId) return;
      setTypingPreviews((prev) => {
        if (!(convId in prev)) return prev;
        const next = { ...prev };
        delete next[convId];
        return next;
      });
    };

    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('auth_ok', onAuthOk);
    s.on('new_message', onNewMessage);
    s.on('presence', onPresence);
    s.on('user_typing', onTyping);
    s.on('user_stopped_typing', onStopTyping);

    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('auth_ok', onAuthOk);
      s.off('new_message', onNewMessage);
      s.off('presence', onPresence);
      s.off('user_typing', onTyping);
      s.off('user_stopped_typing', onStopTyping);
    };
  }, [phase, me, refreshConversations]);

  /* ------------------- انتهاء صلاحية مؤشرات "يكتب..." (أمان) ------------------- */
  useEffect(() => {
    if (phase !== 'main') return;
    const iv = setInterval(() => {
      setTypingPreviews((prev) => {
        const now = Date.now();
        const next: Record<string, { name: string; ts: number }> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (now - v.ts < 4500) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(iv);
  }, [phase]);

  /* -------------------------- عنوان الصفحة بعدد غير المقروء -------------------------- */
  useEffect(() => {
    const total = conversations.reduce(
      (sum, c) => sum + (c.id === activeId ? 0 : c.unreadCount),
      0
    );
    document.title = total > 0 ? `(${total}) محادثة فورية` : 'محادثة فورية';
  }, [conversations, activeId]);

  /* -------------------------- تفاعلات -------------------------- */
  const handleSelect = useCallback((c: Conversation) => {
    setActiveId(c.id);
    setConversations((prev) => prev.map((x) => (x.id === c.id ? { ...x, unreadCount: 0 } : x)));
  }, []);

  const handleCreated = useCallback((conv: Conversation) => {
    setConversations((prev) =>
      prev.some((c) => c.id === conv.id) ? sortConversations(prev) : sortConversations([conv, ...prev])
    );
    setActiveId(conv.id);
    setNewChatOpen(false);
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // تجاهل — نمسح محلياً على أي حال
    }
    disconnectChatSocket();
    setSocket(null);
    clearToken();
    clearStoredMe();
    setMe(null);
    setConversations([]);
    setOnlineIds(new Set());
    setTypingPreviews({});
    setActiveId(null);
    setConnected(false);
    setPhase('login');
    document.title = 'محادثة فورية';
  }, []);

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  );
  const typingConvIds = useMemo(() => new Set(Object.keys(typingPreviews)), [typingPreviews]);

  /* -------------------------- العرض -------------------------- */
  if (phase === 'boot') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-gradient-to-b from-[#075e54] to-[#008069]">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white/15">
          <MessageCircle className="h-10 w-10 text-white" strokeWidth={1.8} />
        </div>
        <p className="text-lg font-bold text-white">محادثة فورية</p>
        <Loader2 className="h-6 w-6 animate-spin text-white/80" aria-label="جاري التحميل" />
      </main>
    );
  }

  if (phase === 'login') {
    return (
      <LoginScreen
        onAuthenticated={(user) => {
          setMe(user);
          setPhase('main');
        }}
      />
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#f0f2f5]">
      {/* الشريط العلوي */}
      <header className="flex h-14 shrink-0 items-center gap-2.5 bg-[#008069] px-3 text-white sm:px-4">
        <MessageCircle className="h-6 w-6 shrink-0" aria-hidden="true" />
        <h1 className="text-lg font-extrabold">محادثة فورية</h1>

        <div className="ms-auto flex min-w-0 items-center gap-2.5">
          {me && (
            <>
              <div className="flex min-w-0 items-center gap-2" title={me.name}>
                <ChatAvatar name={me.name} color={me.avatarColor} size={34} />
                <span className="hidden truncate text-sm font-medium sm:block">{me.name}</span>
              </div>
              <button
                type="button"
                onClick={() => void handleLogout()}
                aria-label="تسجيل الخروج"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10"
              >
                <LogOut className="h-5 w-5" />
              </button>
            </>
          )}
        </div>
      </header>

      {/* بانر انقطاع الاتصال */}
      {!connected && (
        <div
          role="status"
          className="shrink-0 bg-amber-100 px-3 py-1 text-center text-xs font-bold text-amber-900"
        >
          غير متصل — جاري إعادة الاتصال...
        </div>
      )}

      {/* الشقّان */}
      <div className="flex min-h-0 flex-1">
        <aside
          className={`${
            activeId ? 'hidden lg:flex' : 'flex'
          } h-full w-full shrink-0 flex-col border-e border-black/10 bg-white lg:w-[360px]`}
        >
          <ConversationList
            conversations={conversations}
            me={me as Me}
            activeId={activeId}
            onlineIds={onlineIds}
            typingConvIds={typingConvIds}
            loading={convLoading && conversations.length === 0}
            onSelect={handleSelect}
            onNewChat={() => setNewChatOpen(true)}
          />
        </aside>

        <section
          className={`${
            activeId ? 'flex' : 'hidden lg:flex'
          } min-w-0 flex-1 flex-col bg-[#efeae2]`}
        >
          {activeConv && me ? (
            <ChatView
              key={activeConv.id}
              conversation={activeConv}
              me={me}
              socket={socket}
              onlineIds={onlineIds}
              isMobile={!!isMobile}
              onBack={() => setActiveId(null)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#f0f2f5] px-6 text-center">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#00a884]/10">
                <MessageCircle className="h-10 w-10 text-[#00a884]" strokeWidth={1.6} />
              </div>
              <p className="text-lg font-bold text-[#111b21]">محادثة فورية</p>
              <p className="text-sm text-[#667781]">اختر محادثة للبدء</p>
              <p className="max-w-xs text-xs leading-relaxed text-[#8696a0]">
                رسائلك تُنقل عبر اتصال مباشر آمن — ابدأ محادثة خاصة أو انضم للغرفة العامة
              </p>
            </div>
          )}
        </section>
      </div>

      {/* حوار محادثة جديدة */}
      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        onlineIds={onlineIds}
        onCreated={handleCreated}
      />
    </div>
  );
}
