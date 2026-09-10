'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  Check,
  CheckCheck,
  Clock,
  Loader2,
  Mic,
  RotateCcw,
  Send,
  Smile,
} from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatAvatar } from '@/components/chat/avatar';
import { EmojiPicker } from '@/components/chat/emoji-picker';
import { emitSocket } from '@/lib/chat-socket';
import { ApiError, fetchMessages, type ChatMessage, type Conversation, type Me, type MsgStatus } from '@/lib/chat-api';
import { dayLabel, formatTime, lastSeenLabel, newClientId, ts } from '@/lib/chat-utils';
import { playSent } from '@/lib/sounds';

interface ChatViewProps {
  conversation: Conversation;
  me: Me;
  socket: Socket | null;
  onlineIds: Set<string>;
  isMobile: boolean;
  onBack: () => void;
}

interface SocketMessagePayload {
  message?: ChatMessage;
}

interface DeliveryPayload {
  conversationId?: string;
  userId?: string;
  at?: string;
}

interface TypingPayload {
  conversationId?: string;
  userId?: string;
  name?: string;
  username?: string;
}

interface JoinedPayload {
  conversationId?: string;
  user?: { id?: string; name?: string; username?: string; avatarColor?: string; color?: string };
}

const MESSAGES_PAGE = 50;

function isMine(m: ChatMessage, me: Me): boolean {
  return m.senderId === me.id;
}

function messageKey(m: ChatMessage): string {
  return m.clientId || m.id;
}

function cmpTime(a: string, b: string): number {
  return ts(a) - ts(b);
}

/** علامات الوصول داخل الفقاعة */
function Ticks({ status, isPrivate }: { status: MsgStatus | undefined; isPrivate: boolean }) {
  if (status === 'pending') {
    return <Clock className="h-3 w-3 text-[#8696a0]" aria-label="بانتظار الإرسال" />;
  }
  if (status === 'failed') {
    return <AlertCircle className="h-3 w-3 text-red-500" aria-label="فشل الإرسال" />;
  }
  if (status === undefined) return null;
  if (!isPrivate || status === 'sent') {
    return <Check className="h-3.5 w-3.5 text-[#8696a0]" aria-label="مرسلة" />;
  }
  if (status === 'delivered') {
    return <CheckCheck className="h-3.5 w-3.5 text-[#8696a0]" aria-label="وصلت" />;
  }
  return <CheckCheck className="h-3.5 w-3.5 text-[#53bdeb]" aria-label="تمت القراءة" />;
}

interface BubbleProps {
  msg: ChatMessage;
  me: Me;
  isGroup: boolean;
  status: MsgStatus | undefined;
  animate: boolean;
  onRetry: (m: ChatMessage) => void;
}

function Bubble({ msg, me, isGroup, status, animate, onRetry }: BubbleProps) {
  if (msg.type === 'system') {
    return (
      <div className="my-1.5 flex justify-center px-6">
        <span className="rounded-lg bg-[#ffeecd] px-3 py-1 text-center text-[11px] font-medium text-[#54656f]">
          {msg.text}
        </span>
      </div>
    );
  }

  const mine = isMine(msg, me);
  const failed = status === 'failed';

  return (
    <motion.div
      initial={animate ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={`flex px-1.5 sm:px-2 ${mine ? 'justify-start' : 'justify-end'}`}
    >
      <div
        className={`max-w-[80%] rounded-2xl px-2.5 py-1.5 shadow-sm sm:max-w-[65%] ${
          mine
            ? `rounded-bl-none ${failed ? 'bg-[#fbe3e3] ring-1 ring-red-300/70' : 'bg-[#d9fdd3]'}`
            : 'rounded-br-none bg-white'
        }`}
      >
        {isGroup && !mine && msg.sender?.name && (
          <div
            className="mb-0.5 text-xs font-bold"
            style={{ color: msg.sender.avatarColor || '#008069' }}
          >
            {msg.sender.name}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <span
            dir="auto"
            className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${
              failed ? 'text-[#7a2b2b]' : 'text-[#111b21]'
            }`}
          >
            {msg.text}
          </span>
          <span
            dir="ltr"
            className="mb-px flex shrink-0 items-center gap-0.5 text-[10px] leading-none text-[#667781]"
          >
            {formatTime(msg.createdAt)}
            {mine && <Ticks status={status} isPrivate={!isGroup} />}
            {mine && failed && (
              <button
                type="button"
                onClick={() => onRetry(msg)}
                aria-label="إعادة إرسال الرسالة"
                className="ms-0.5 text-red-500 transition-colors hover:text-red-600"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

export function ChatView({ conversation, me, socket, onlineIds, isMobile, onBack }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, MsgStatus>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [typingName, setTypingName] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [newCount, setNewCount] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const nearBottomRef = useRef(true);
  const restoreScrollRef = useRef<{ h: number; top: number } | null>(null);
  const pendingBottomRef = useRef<ScrollBehavior | null>(null);
  const failTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const loadingOlderRef = useRef(false);
  const [animatedKeys, setAnimatedKeys] = useState<Set<string>>(() => new Set());
  const typingSentAtRef = useRef(0);
  const stopTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // أحدث نسخة من الحالة داخل المستمعات (تفادي الإغلاق القديم)
  const messagesRef = useRef<ChatMessage[]>([]);
  const conversationRef = useRef(conversation);
  const meRef = useRef(me);
  useEffect(() => {
    messagesRef.current = messages;
    conversationRef.current = conversation;
    meRef.current = me;
  }, [messages, conversation, me]);

  const isGroup = conversation.type === 'group';
  const other = conversation.other;
  const otherLastReadTs = ts(conversation.otherLastReadAt ?? other?.lastReadAt);

  function markAnimated(key: string): void {
    setAnimatedKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  function clearFailTimer(id: string): void {
    const t = failTimersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      failTimersRef.current.delete(id);
    }
  }

  function scrollToBottom(behavior: ScrollBehavior): void {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }

  /** الحالة الأولية لرسائلي: مقروءة إن كانت قبل آخر قراءة للطرف الآخر، وإلا "مرسلة" */
  function computeInitialStatuses(list: ChatMessage[]): Record<string, MsgStatus> {
    const map: Record<string, MsgStatus> = {};
    for (const m of list) {
      if (m.type !== 'text' || m.senderId !== meRef.current.id) continue;
      map[m.id] = otherLastReadTs > 0 && ts(m.createdAt) <= otherLastReadTs ? 'read' : 'sent';
    }
    return map;
  }

  /* -------------------------- تحميل الرسائل -------------------------- */
  // المكوّن يُعاد تركيبه لكل محادثة (key=conversation.id) لذا الحالات الأولية تكفي
  useEffect(() => {
    let cancelled = false;
    nearBottomRef.current = true;
    pendingBottomRef.current = 'auto';

    fetchMessages(conversation.id)
      .then(({ messages: list }) => {
        if (cancelled) return;
        setMessages(list);
        setStatusMap(computeInitialStatuses(list));
        setHasOlder(list.length >= MESSAGES_PAGE);
        // تصحيح حالات المرسل القديمة + تصفير شارتي
        emitSocket('read', { conversationId: conversation.id });
        // مطابقة حالة القراءة للطرف الآخر (شفاء العلامات بعد انقطاع/إعادة اتصال)
        emitSocket('sync_read', { conversationId: conversation.id });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof ApiError ? e.message : 'تعذر تحميل الرسائل');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  /* --------------------- تمرير: أول تحميل + استعادة موضع الأقدم --------------------- */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (restoreScrollRef.current) {
      const { h, top } = restoreScrollRef.current;
      el.scrollTop = el.scrollHeight - h + top;
      restoreScrollRef.current = null;
      return;
    }
    if (pendingBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      pendingBottomRef.current = null;
    }
  }, [messages, loading]);

  /* -------------------------- إصدار read عند التركيز -------------------------- */
  useEffect(() => {
    const onFocus = () => emitSocket('read', { conversationId: conversation.id });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [conversation.id]);

  /* -------------------------- أحداث السوكيت -------------------------- */
  useEffect(() => {
    if (!socket) return;

    function onNewMessage(payload: SocketMessagePayload) {
      const msg = payload?.message;
      if (!msg || msg.conversationId !== conversationRef.current.id) return;
      const meId = meRef.current.id;
      const prev = messagesRef.current;

      // صدى الإرسال المتفائل: استبدال الفقاعة المؤقتة بالنهائية
      const echoIdx = msg.clientId ? prev.findIndex((m) => m.clientId === msg.clientId) : -1;
      if (echoIdx >= 0) {
        const tmpId = prev[echoIdx].id;
        clearFailTimer(tmpId);
        setMessages((cur) =>
          cur.map((m) => (msg.clientId && m.clientId === msg.clientId ? { ...msg } : m))
        );
        setStatusMap((sm) => {
          const nm = { ...sm };
          delete nm[tmpId];
          nm[msg.id] = 'sent';
          return nm;
        });
        pendingBottomRef.current = 'smooth';
        return;
      }

      // مكرر (وصل بنفس المعرّف النهائي سابقاً)
      if (prev.some((m) => m.id === msg.id)) return;

      // إضافة رسالة جديدة (updater نقي بلا تأثيرات جانبية)
      const isMineMsg = msg.senderId === meId;
      const otherRead = ts(conversationRef.current.otherLastReadAt ?? conversationRef.current.other?.lastReadAt);
      setMessages((cur) => [...cur, { ...msg }].sort((a, b) => cmpTime(a.createdAt, b.createdAt)));
      markAnimated(messageKey(msg));
      if (!isMineMsg && msg.type === 'text') {
        setStatusMap((sm) => ({
          ...sm,
          [msg.id]: otherRead > 0 && ts(msg.createdAt) <= otherRead ? 'read' : 'sent',
        }));
      }
      if (isMineMsg) {
        pendingBottomRef.current = 'smooth';
      } else {
        // المحادثة مفتوحة: تصفير الشارة محلياً + إبلاغ الآخرين بالقراءة
        emitSocket('read', { conversationId: conversationRef.current.id });
        if (nearBottomRef.current) {
          pendingBottomRef.current = 'smooth';
        } else {
          setNewCount((c) => c + 1);
          setShowJump(true);
        }
      }
    }

    function upgradeStatuses(
      atIso: string | undefined,
      target: Extract<MsgStatus, 'delivered' | 'read'>
    ) {
      const conv = conversationRef.current;
      // الغرفة العامة: ✓ فقط (لا delivered/read)
      if (conv.type === 'group') return;
      const at = atIso ? ts(atIso) : Date.now();
      setStatusMap((prev) => {
        let changed = false;
        const next: Record<string, MsgStatus> = { ...prev };
        for (const m of messagesRef.current) {
          if (m.type !== 'text' || m.senderId !== meRef.current.id) continue;
          const cur = next[m.id];
          if (cur === 'pending' || cur === 'failed' || cur === undefined) continue;
          const rank: Record<string, number> = { sent: 1, delivered: 2, read: 3 };
          if (ts(m.createdAt) <= at && (rank[cur] ?? 0) < rank[target]) {
            next[m.id] = target;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }

    function onDelivered(payload: DeliveryPayload) {
      if (!payload || payload.conversationId !== conversationRef.current.id) return;
      if (payload.userId === meRef.current.id) return;
      upgradeStatuses(payload.at, 'delivered');
    }

    function onRead(payload: DeliveryPayload) {
      if (!payload || payload.conversationId !== conversationRef.current.id) return;
      if (payload.userId === meRef.current.id) return;
      upgradeStatuses(payload.at, 'read');
    }

    function onTyping(payload: TypingPayload) {
      if (!payload || payload.conversationId !== conversationRef.current.id) return;
      if (payload.userId === meRef.current.id) return;
      setTypingName(payload.name || payload.username || 'شخص ما');
      if (typingHideTimerRef.current) clearTimeout(typingHideTimerRef.current);
      typingHideTimerRef.current = setTimeout(() => setTypingName(null), 4000);
    }

    function onStoppedTyping(payload: TypingPayload) {
      if (!payload || payload.conversationId !== conversationRef.current.id) return;
      if (payload.userId && payload.userId === meRef.current.id) return;
      setTypingName(null);
    }

    function onUserJoined(payload: JoinedPayload) {
      if (!payload || payload.conversationId !== conversationRef.current.id) return;
      const name = payload.user?.name || payload.user?.username;
      if (!name) return;
      const sys: ChatMessage = {
        id: `sys-joined-${payload.user?.id ?? name}-${Date.now()}`,
        conversationId: conversationRef.current.id,
        senderId: '',
        type: 'system',
        text: `${name} انضم إلى الغرفة`,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, sys]);
      markAnimated(messageKey(sys));
    }

    socket.on('new_message', onNewMessage);
    socket.on('messages_delivered', onDelivered);
    socket.on('messages_read', onRead);
    socket.on('user_typing', onTyping);
    socket.on('user_stopped_typing', onStoppedTyping);
    socket.on('user_joined', onUserJoined);

    return () => {
      socket.off('new_message', onNewMessage);
      socket.off('messages_delivered', onDelivered);
      socket.off('messages_read', onRead);
      socket.off('user_typing', onTyping);
      socket.off('user_stopped_typing', onStoppedTyping);
      socket.off('user_joined', onUserJoined);
    };
  }, [socket]);

  /* -------------------------- تنظيف المؤقتات عند الإلغاء -------------------------- */
  useEffect(() => {
    const failTimers = failTimersRef.current;
    return () => {
      failTimers.forEach((t) => clearTimeout(t));
      failTimers.clear();
      if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
      if (typingHideTimerRef.current) clearTimeout(typingHideTimerRef.current);
      if (typingSentAtRef.current) {
        emitSocket('stop_typing', { conversationId: conversationRef.current.id });
      }
    };
  }, []);

  /* -------------------------- الكتابة -------------------------- */
  const stopTyping = useCallback(() => {
    if (stopTypingTimerRef.current) {
      clearTimeout(stopTypingTimerRef.current);
      stopTypingTimerRef.current = null;
    }
    if (typingSentAtRef.current) {
      emitSocket('stop_typing', { conversationId: conversationRef.current.id });
      typingSentAtRef.current = 0;
    }
  }, []);

  function autoresizeTextarea(): void {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 58)}px`;
  }

  function handleDraftChange(v: string): void {
    setDraft(v);
    autoresizeTextarea();
    const convId = conversationRef.current.id;
    if (v.trim()) {
      const now = Date.now();
      if (now - typingSentAtRef.current > 1500) {
        emitSocket('typing', { conversationId: convId });
        typingSentAtRef.current = now;
      }
      if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
      stopTypingTimerRef.current = setTimeout(() => {
        emitSocket('stop_typing', { conversationId: convId });
        typingSentAtRef.current = 0;
      }, 1500);
    } else {
      stopTyping();
    }
  }

  /* -------------------------- الإرسال -------------------------- */
  function scheduleFailTimer(tmpId: string): void {
    clearFailTimer(tmpId);
    const t = setTimeout(() => {
      setStatusMap((prev) => (prev[tmpId] === 'pending' ? { ...prev, [tmpId]: 'failed' } : prev));
      failTimersRef.current.delete(tmpId);
    }, 8000);
    failTimersRef.current.set(tmpId, t);
  }

  function sendText(text: string, replaceId?: string): void {
    const convId = conversationRef.current.id;
    const clientId = newClientId();
    const tmpId = `tmp-${clientId}`;
    const temp: ChatMessage = {
      id: tmpId,
      conversationId: convId,
      senderId: meRef.current.id,
      type: 'text',
      text,
      clientId,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => {
      const base = replaceId ? prev.filter((m) => m.id !== replaceId) : prev;
      return [...base, temp].sort((a, b) => cmpTime(a.createdAt, b.createdAt));
    });
    markAnimated(messageKey(temp));
    setStatusMap((prev) => {
      const next = { ...prev };
      if (replaceId) delete next[replaceId];
      next[tmpId] = 'pending';
      return next;
    });
    scheduleFailTimer(tmpId);
    emitSocket('send_message', { conversationId: convId, text, clientId });
    playSent();
    pendingBottomRef.current = 'smooth';
    nearBottomRef.current = true;
    setShowJump(false);
    setNewCount(0);
  }

  function handleSend(): void {
    const text = draft.trim();
    if (!text) return;
    stopTyping();
    setDraft('');
    setEmojiOpen(false);
    if (draftRef.current) draftRef.current.style.height = 'auto';
    sendText(text);
  }

  function handleRetry(msg: ChatMessage): void {
    sendText(msg.text, msg.id);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }

  /* -------------------------- التمرير وتحميل الأقدم -------------------------- */
  function loadOlder(): void {
    if (loadingOlderRef.current || !hasOlder) return;
    const oldest = messagesRef.current[0];
    const el = scrollRef.current;
    if (!oldest || !el) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    restoreScrollRef.current = { h: el.scrollHeight, top: el.scrollTop };
    fetchMessages(conversationRef.current.id, oldest.createdAt)
      .then(({ messages: older }) => {
        setMessages((prev) => {
          const known = new Set(prev.map((m) => m.id));
          const fresh = older.filter((m) => !known.has(m.id));
          return [...fresh, ...prev].sort((a, b) => cmpTime(a.createdAt, b.createdAt));
        });
        setStatusMap((prev) => {
          const next = { ...prev };
          for (const m of older) {
            if (m.type !== 'text' || m.senderId !== meRef.current.id || next[m.id]) continue;
            next[m.id] = otherLastReadTs > 0 && ts(m.createdAt) <= otherLastReadTs ? 'read' : 'sent';
          }
          return next;
        });
        setHasOlder(older.length >= MESSAGES_PAGE);
      })
      .catch(() => {
        restoreScrollRef.current = null;
      })
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = distance < 120;
    if (nearBottomRef.current && (showJump || newCount > 0)) {
      setShowJump(false);
      setNewCount(0);
    }
    if (el.scrollTop < 60) loadOlder();
  }

  /* -------------------------- سطر حالة الرأس -------------------------- */
  function headerStatus(): ReactNode {
    if (typingName) {
      return <span className="font-medium text-[#c9f7d6]">{isGroup ? `${typingName} يكتب...` : 'يكتب...'}</span>;
    }
    if (isGroup) {
      const n = onlineIds.size;
      return `${conversation.name || 'الغرفة العامة'} — ${n} متصل`;
    }
    if (other && onlineIds.has(other.id)) {
      return <span className="font-medium text-[#c9f7d6]">متصل الآن</span>;
    }
    const label = lastSeenLabel(other?.lastSeen);
    return label ?? '';
  }

  /* -------------------------- التجميع للعرض -------------------------- */
  const rendered: ReactNode[] = [];
  let lastDay = '';
  for (const m of messages) {
    const label = dayLabel(m.createdAt);
    if (label !== lastDay) {
      lastDay = label;
      rendered.push(
        <div key={`day-${label}-${m.id}`} className="my-2 flex justify-center">
          <span className="rounded-lg bg-white px-3 py-1 text-[11px] font-medium text-[#54656f] shadow-sm">
            {label}
          </span>
        </div>
      );
    }
    const key = messageKey(m);
    rendered.push(
      <Bubble
        key={key}
        msg={m}
        me={me}
        isGroup={isGroup}
        status={statusMap[m.id] ?? (isMine(m, me) && m.type === 'text' ? 'sent' : undefined)}
        animate={animatedKeys.has(key)}
        onRetry={handleRetry}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* رأس المحادثة */}
      <header className="flex h-14 shrink-0 items-center gap-2.5 bg-[#008069] px-2.5 text-white sm:px-3">
        {isMobile && (
          <button
            type="button"
            onClick={onBack}
            aria-label="رجوع إلى قائمة المحادثات"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10"
          >
            <ArrowRight className="h-6 w-6" />
          </button>
        )}
        <ChatAvatar
          name={isGroup ? undefined : other?.name}
          color={other?.avatarColor}
          group={isGroup}
          size={38}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">
            {isGroup ? conversation.name || 'الغرفة العامة' : other?.name || 'مستخدم'}
          </div>
          <div className="truncate text-xs text-white/85" aria-live="polite">
            {headerStatus()}
          </div>
        </div>
      </header>

      {/* جسم المحادثة */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          role="log"
          aria-label="سجل الرسائل"
          className="chat-scroll h-full overflow-y-auto bg-[#efeae2] px-1 py-3"
          style={{
            backgroundImage:
              'radial-gradient(rgba(0,0,0,0.025) 1px, transparent 1.2px)',
            backgroundSize: '18px 18px',
          }}
        >
          {loadingOlder && (
            <div className="flex justify-center py-2">
              <Loader2 className="h-5 w-5 animate-spin text-[#8696a0]" aria-label="جاري تحميل الرسائل الأقدم" />
            </div>
          )}

          {loading ? (
            <div className="flex flex-col gap-3 px-2 pt-2" aria-label="جاري تحميل الرسائل">
              <Skeleton className="mx-auto h-5 w-20 rounded-lg bg-black/10" />
              <div className="flex justify-start px-1">
                <Skeleton className="h-10 w-2/5 rounded-2xl rounded-br-none bg-black/10" />
              </div>
              <div className="flex justify-end px-1">
                <Skeleton className="h-12 w-1/2 rounded-2xl rounded-bl-none bg-black/10" />
              </div>
              <div className="flex justify-start px-1">
                <Skeleton className="h-9 w-1/3 rounded-2xl rounded-br-none bg-black/10" />
              </div>
              <div className="flex justify-end px-1">
                <Skeleton className="h-14 w-3/5 rounded-2xl rounded-bl-none bg-black/10" />
              </div>
            </div>
          ) : loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <AlertCircle className="h-8 w-8 text-[#8696a0]" />
              <p className="text-sm font-bold text-[#111b21]">{loadError}</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6">
              <p className="rounded-xl bg-white/80 px-4 py-2 text-center text-sm text-[#54656f] shadow-sm">
                لا رسائل بعد — ابدأ المحادثة 👋
              </p>
            </div>
          ) : (
            rendered
          )}
        </div>

        {/* زر النزول للأسفل مع عدّاد الرسائل الجديدة */}
        {showJump && (
          <button
            type="button"
            onClick={() => {
              scrollToBottom('smooth');
              setShowJump(false);
              setNewCount(0);
            }}
            aria-label={`النزول للرسائل الجديدة (${newCount})`}
            className="absolute bottom-4 end-4 flex h-10 w-10 items-center justify-center rounded-full bg-white text-[#54656f] shadow-lg transition-transform hover:scale-105 active:scale-95"
          >
            <ArrowDown className="h-5 w-5" />
            {newCount > 0 && (
              <span className="absolute -top-1 start-0 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#25d366] px-1 text-[10px] font-bold text-white">
                {newCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* شريط الإدخال */}
      <div
        className="relative shrink-0 border-t border-black/5 bg-[#f0f2f5]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {emojiOpen && (
          <EmojiPicker
            onPick={(emoji) => {
              setDraft((d) => d + emoji);
              requestAnimationFrame(() => {
                autoresizeTextarea();
                draftRef.current?.focus();
              });
            }}
            onClose={() => setEmojiOpen(false)}
          />
        )}
        <div className="flex items-end gap-1.5 p-2">
          <button
            type="button"
            data-emoji-toggle
            onClick={() => setEmojiOpen((o) => !o)}
            aria-label="إظهار قائمة الإيموجي"
            aria-expanded={emojiOpen}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#54656f] transition-colors hover:bg-black/5"
          >
            <Smile className="h-6 w-6" />
          </button>

          <textarea
            ref={draftRef}
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder="اكتب رسالة"
            aria-label="نص الرسالة"
            className="max-h-[58px] min-h-[44px] flex-1 resize-none rounded-2xl bg-white px-4 py-2.5 text-sm leading-relaxed text-[#111b21] outline-none placeholder:text-[#8696a0] focus:ring-2 focus:ring-[#00a884]/30"
          />

          {draft.trim() ? (
            <button
              type="button"
              onClick={handleSend}
              aria-label="إرسال الرسالة"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#00a884] text-white shadow transition-all hover:bg-[#017561] active:scale-95"
            >
              <Send className="h-5 w-5 -scale-x-100" />
            </button>
          ) : (
            <button
              type="button"
              disabled
              aria-label="تسجيل صوتي — ميزة قادمة"
              className="flex h-11 w-11 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-[#8696a0]"
            >
              <Mic className="h-6 w-6" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
