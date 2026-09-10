'use client';

import { useEffect, useState } from 'react';
import { Loader2, UserRoundSearch } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatAvatar } from '@/components/chat/avatar';
import { ApiError, createConversation, fetchUsers, type Conversation, type UserSummary } from '@/lib/chat-api';

interface NewChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onlineIds: Set<string>;
  onCreated: (conversation: Conversation) => void;
}

export function NewChatDialog({ open, onOpenChange, onlineIds, onCreated }: NewChatDialogProps) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchUsers()
      .then((res) => {
        if (!cancelled) setUsers(res.users ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'تعذر تحميل المستخدمين');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handlePick(user: UserSummary) {
    if (creatingId) return;
    setCreatingId(user.id);
    setError(null);
    try {
      const res = await createConversation(user.id);
      const c = res.conversation;
      onCreated({
        id: c.id,
        type: c.type === 'group' ? 'group' : 'private',
        name: c.name ?? null,
        other: c.other ?? {
          id: user.id,
          name: user.name,
          avatarColor: user.avatarColor,
          lastSeen: user.lastSeen ?? null,
        },
        unreadCount: 0,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'تعذر إنشاء المحادثة، حاول مجدداً');
    } finally {
      setCreatingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-0 overflow-hidden rounded-2xl p-0">
        <DialogHeader className="bg-[#008069] p-4 text-white sm:text-right">
          <DialogTitle className="text-base font-bold text-white">محادثة جديدة</DialogTitle>
          <DialogDescription className="text-xs text-white/80">
            اختر مستخدماً لبدء محادثة خاصة
          </DialogDescription>
        </DialogHeader>

        <div className="chat-scroll max-h-80 min-h-40 overflow-y-auto p-1.5" role="list" aria-label="قائمة المستخدمين">
          {loading ? (
            <div className="flex flex-col gap-4 p-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-1/3" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <UserRoundSearch className="h-8 w-8 text-[#8696a0]" />
              <p className="text-sm font-bold text-[#111b21]">لا يوجد مستخدمون بعد</p>
              <p className="text-xs text-[#667781]">عندما يسجّل مستخدمون آخرون الدخول ستظهر قائمتهم هنا</p>
            </div>
          ) : (
            users.map((u) => {
              const online = onlineIds.has(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  role="listitem"
                  disabled={creatingId !== null}
                  onClick={() => void handlePick(u)}
                  className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start transition-colors hover:bg-black/[0.04] disabled:opacity-60"
                >
                  <div className="relative shrink-0">
                    <ChatAvatar name={u.name} color={u.avatarColor} size={44} />
                    {online && (
                      <span
                        className="absolute bottom-0 end-0 h-3 w-3 rounded-full border-2 border-white bg-[#25d366]"
                        aria-label="متصل الآن"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-bold text-[#111b21]">{u.name}</div>
                    <div className="truncate text-xs text-[#667781]">{u.about || (online ? 'متصل الآن' : '')}</div>
                  </div>
                  {creatingId === u.id && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#00a884]" />}
                </button>
              );
            })
          )}
        </div>

        {error && (
          <p role="alert" className="px-4 pb-3 text-sm font-medium text-red-600">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
