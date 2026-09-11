'use client';

import { useMemo, useState } from 'react';
import { Check, CheckCheck, MessageCirclePlus, Search } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatAvatar } from '@/components/chat/avatar';
import { shortStamp, ts } from '@/lib/chat-utils';
import type { Conversation, Me } from '@/lib/chat-api';

interface ConversationListProps {
  conversations: Conversation[];
  me: Me;
  activeId: string | null;
  onlineIds: Set<string>;
  /** معرّفات محادثات بها "يكتب..." */
  typingConvIds: Set<string>;
  loading: boolean;
  onSelect: (c: Conversation) => void;
  onNewChat: () => void;
}

function displayName(c: Conversation): string {
  if (c.type === 'group') return c.name || 'مجموعة';
  return c.other?.name || 'مستخدم';
}

interface Preview {
  text: string;
  mine: boolean;
  /** لعرض ✓✓ في المعاينة للمحادثات الخاصة فقط */
  read: boolean;
}

function buildPreview(c: Conversation, me: Me): Preview | null {
  const lm = c.lastMessage;
  if (!lm) return null;
  const mine = lm.senderId === me.id;
  if (c.type === 'group') {
    if (lm.type === 'system') return { text: lm.text, mine: false, read: false };
    const prefix = mine ? 'أنا: ' : `${lm.senderName || 'شخص'}: `;
    const body = lm.type === 'voice' ? '🎙️ رسالة صوتية' : lm.text;
    return { text: `${prefix}${body}`, mine, read: false };
  }
  const read = ts(c.otherLastReadAt ?? c.other?.lastReadAt) > 0 && ts(lm.createdAt) <= ts(c.otherLastReadAt ?? c.other?.lastReadAt);
  const body = lm.type === 'voice' ? '🎙️ رسالة صوتية' : lm.text;
  return { text: `${mine ? 'أنا: ' : ''}${body}`, mine, read };
}

export function ConversationList({
  conversations,
  me,
  activeId,
  onlineIds,
  typingConvIds,
  loading,
  onSelect,
  onNewChat,
}: ConversationListProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return conversations;
    return conversations.filter((c) => displayName(c).includes(q));
  }, [conversations, query]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-white">
      {/* البحث */}
      <div className="shrink-0 p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8696a0]" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث في المحادثات..."
            aria-label="البحث في المحادثات"
            className="h-10 w-full rounded-lg bg-[#f0f2f5] ps-9 pe-3 text-sm text-[#111b21] outline-none placeholder:text-[#8696a0] focus:ring-2 focus:ring-[#00a884]/40"
          />
        </div>
      </div>

      {/* القائمة */}
      <div className="chat-scroll min-h-0 flex-1 overflow-y-auto pb-16" role="list" aria-label="قائمة المحادثات">
        {loading ? (
          <div className="flex flex-col gap-4 p-4" aria-label="جاري التحميل">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-2/5" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="text-4xl" aria-hidden="true">
              🎉
            </span>
            <p className="text-sm font-bold text-[#111b21]">لا محادثات بعد — ابدأ واحدة</p>
            <p className="text-xs text-[#667781]">اضغط زر المحادثة الجديدة بالأسفل</p>
          </div>
        ) : (
          filtered.map((c) => {
            const isTyping = typingConvIds.has(c.id);
            const preview = buildPreview(c, me);
            const online = c.type === 'private' && !!c.other && onlineIds.has(c.other.id);
            return (
              <button
                key={c.id}
                type="button"
                role="listitem"
                onClick={() => onSelect(c)}
                aria-current={activeId === c.id ? 'true' : undefined}
                className={`flex w-full items-center gap-3 border-b border-[#e9edef] px-3 py-3 text-start transition-colors hover:bg-black/[0.03] ${
                  activeId === c.id ? 'bg-[#f0f2f5]' : ''
                }`}
              >
                <div className="relative shrink-0">
                  <ChatAvatar
                    name={c.type === 'group' ? undefined : c.other?.name}
                    color={c.other?.avatarColor}
                    group={c.type === 'group'}
                    size={48}
                  />
                  {online && (
                    <span
                      className="absolute bottom-0 end-0 h-3 w-3 rounded-full border-2 border-white bg-[#25d366]"
                      aria-label="متصل الآن"
                    />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-bold text-[#111b21]">
                    {displayName(c)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-[13px] text-[#667781]">
                    {isTyping ? (
                      <span className="font-medium text-[#00a884]">يكتب...</span>
                    ) : (
                      <>
                        {preview?.mine && c.type === 'private' && (
                          preview.read ? (
                            <CheckCheck className="h-3.5 w-3.5 shrink-0 text-[#53bdeb]" aria-hidden="true" />
                          ) : (
                            <Check className="h-3.5 w-3.5 shrink-0 text-[#8696a0]" aria-hidden="true" />
                          )
                        )}
                        <span className="truncate">{preview ? preview.text : 'لا رسائل بعد'}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1">
                  {c.lastMessage && (
                    <span className="text-[11px] text-[#667781]">{shortStamp(c.lastMessage.createdAt)}</span>
                  )}
                  {c.unreadCount > 0 && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#25d366] px-1.5 text-[11px] font-bold text-white">
                      {c.unreadCount > 99 ? '99+' : c.unreadCount}
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* زر محادثة جديدة عائم — أسفل يسار القائمة */}
      <button
        type="button"
        onClick={onNewChat}
        aria-label="محادثة جديدة"
        className="absolute bottom-5 end-5 flex h-13 w-13 items-center justify-center rounded-full bg-[#00a884] text-white shadow-lg transition-all hover:bg-[#017561] active:scale-95"
      >
        <MessageCirclePlus className="h-6 w-6" />
      </button>
    </div>
  );
}
