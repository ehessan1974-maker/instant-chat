'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Search, UserRoundSearch, Users } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatAvatar } from '@/components/chat/avatar';
import { getSocket } from '@/lib/chat-socket';
import {
  ApiError,
  createConversation,
  fetchUsers,
  type Conversation,
  type UserSummary,
} from '@/lib/chat-api';

type Tab = 'private' | 'group';

/** ردّ الخادم على create_group (ack) */
interface CreateGroupAck {
  ok?: boolean;
  error?: string;
  conversation?: Conversation;
}

interface NewChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onlineIds: Set<string>;
  onCreated: (conversation: Conversation) => void;
}

function groupErrorText(code?: string): string {
  switch (code) {
    case 'NAME_REQUIRED':
      return 'يرجى إدخال اسم للمجموعة';
    case 'MEMBERS_REQUIRED':
      return 'يرجى اختيار عضو واحد على الأقل';
    default:
      return 'تعذر إنشاء المجموعة، حاول مجدداً';
  }
}

/** فلترة محلية بالاسم أو الهاتف (غير حساسة لحالة الأحرف) */
function matchesQuery(u: UserSummary, q: string): boolean {
  if (!q) return true;
  const name = (u.name || '').toLowerCase();
  const phone = (u.phone || '').replace(/[\s-]/g, '');
  const needle = q.toLowerCase();
  return name.includes(needle) || phone.includes(q.replace(/[\s-]/g, ''));
}

export function NewChatDialog({ open, onOpenChange, onlineIds, onCreated }: NewChatDialogProps) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>('private');

  // خطأ تحميل قائمة المستخدمين (يظهر في كلا التبويبين)
  const [fetchError, setFetchError] = useState<string | null>(null);

  // تبويب المحادثة الخاصة
  const [privateQuery, setPrivateQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);

  // تبويب المجموعة الجديدة
  const [groupQuery, setGroupQuery] = useState('');
  const [groupName, setGroupName] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupError, setGroupError] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const creatingRef = useRef(false);

  /* ---------------- إعادة تهيئة الحوار عند كل فتح ---------------- */
  useEffect(() => {
    if (!open) return;
    setTab('private');
    setPrivateQuery('');
    setGroupQuery('');
    setGroupName('');
    setSelectedIds(new Set());
    setFetchError(null);
    setError(null);
    setGroupError(null);
    setCreatingId(null);
  }, [open]);

  /* ---------------- تحميل المستخدمين ---------------- */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetchUsers()
      .then((res) => {
        if (!cancelled) setUsers(res.users ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFetchError(e instanceof ApiError ? e.message : 'تعذر تحميل المستخدمين');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const privateFiltered = useMemo(
    () => users.filter((u) => matchesQuery(u, privateQuery.trim())),
    [users, privateQuery]
  );

  const groupFiltered = useMemo(
    () => users.filter((u) => matchesQuery(u, groupQuery.trim())),
    [users, groupQuery]
  );

  /* ---------------- محادثة خاصة (كما هي) ---------------- */
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

  /* ---------------- إنشاء مجموعة (سوكيت + ack) ---------------- */
  function toggleMember(id: string) {
    if (creatingRef.current) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleCreateGroup() {
    if (creatingRef.current) return;
    const name = groupName.trim();
    const memberIds = Array.from(selectedIds);
    if (!name || memberIds.length === 0) return;

    const socket = getSocket();
    if (!socket) {
      setGroupError('غير متصل بالخادم — انتظر إعادة الاتصال ثم حاول مجدداً');
      return;
    }

    creatingRef.current = true;
    setCreatingGroup(true);
    setGroupError(null);

    // مهلة أمان حتى لا يبقى الزر معلقاً بلا ردّ
    const timeout = window.setTimeout(() => {
      if (!creatingRef.current) return;
      creatingRef.current = false;
      setCreatingGroup(false);
      setGroupError('انتهت مهلة الطلب — تحقق من الاتصال وحاول مجدداً');
    }, 12000);

    socket.emit('create_group', { name, memberIds }, (r?: CreateGroupAck) => {
      window.clearTimeout(timeout);
      creatingRef.current = false;
      setCreatingGroup(false);
      if (r?.ok && r.conversation) {
        setGroupName('');
        setSelectedIds(new Set());
        onCreated(r.conversation);
        onOpenChange(false);
      } else {
        setGroupError(groupErrorText(r?.error));
      }
    });
  }

  /* ---------------- عناصر مشتركة ---------------- */
  const onlineDot = (online: boolean) =>
    online ? (
      <span
        className="absolute bottom-0 end-0 h-3 w-3 rounded-full border-2 border-white bg-[#25d366]"
        aria-label="متصل الآن"
      />
    ) : null;

  const userAvatar = (u: UserSummary) => (
    <div className="relative shrink-0">
      <ChatAvatar name={u.name} color={u.avatarColor} size={44} />
      {onlineDot(onlineIds.has(u.id))}
    </div>
  );

  const userNamePhone = (u: UserSummary) => (
    <div className="min-w-0 flex-1">
      <div className="truncate text-[15px] font-bold text-[#111b21]">{u.name}</div>
      {u.phone ? (
        <div dir="ltr" className="truncate text-xs text-[#667781]">
          {u.phone}
        </div>
      ) : (
        <div className="truncate text-xs text-[#667781]">{onlineIds.has(u.id) ? 'متصل الآن' : u.about || ''}</div>
      )}
    </div>
  );

  const skeletons = (
    <div className="flex flex-col gap-4 p-3" aria-label="جاري التحميل">
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
  );

  const noUsers = (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <UserRoundSearch className="h-8 w-8 text-[#8696a0]" />
      <p className="text-sm font-bold text-[#111b21]">لا يوجد مستخدمون بعد</p>
      <p className="text-xs text-[#667781]">عندما يسجّل مستخدمون آخرون الدخول ستظهر قائمتهم هنا</p>
    </div>
  );

  const noResults = (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <Search className="h-7 w-7 text-[#8696a0]" />
      <p className="text-sm font-bold text-[#111b21]">لا نتائج مطابقة</p>
      <p className="text-xs text-[#667781]">جرّب البحث باسم آخر أو برقم هاتف مختلف</p>
    </div>
  );

  const searchBox = (value: string, onChange: (v: string) => void, label: string) => (
    <div className="p-3 pb-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8696a0]" />
        <Input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="ابحث بالاسم أو رقم الهاتف..."
          aria-label={label}
          className="h-11 rounded-lg border-transparent bg-[#f0f2f5] ps-9 pe-3 text-sm text-[#111b21] placeholder:text-[#8696a0] focus-visible:border-[#00a884]/40"
        />
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-0 overflow-hidden rounded-2xl p-0">
        <DialogHeader className="bg-[#008069] p-4 text-white sm:text-right">
          <DialogTitle className="text-base font-bold text-white">محادثة جديدة</DialogTitle>
          <DialogDescription className="text-xs text-white/80">
            ابدأ محادثة خاصة أو أنشئ مجموعة واضف إليها الأشخاص
          </DialogDescription>
        </DialogHeader>

        {/* شريط التبويبات — أسلوب واتساب */}
        <div className="flex shrink-0 border-b border-[#e9edef]" role="tablist" aria-label="نوع المحادثة الجديدة">
          {(
            [
              { id: 'private' as const, label: 'محادثة خاصة' },
              { id: 'group' as const, label: 'مجموعة جديدة' },
            ]
          ).map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={`relative flex min-h-11 flex-1 items-center justify-center text-sm transition-colors ${
                  active ? 'font-bold text-[#111b21]' : 'font-medium text-[#8696a0] hover:bg-black/[0.03] hover:text-[#111b21]'
                }`}
              >
                {t.label}
                {active && (
                  <span className="absolute inset-x-5 bottom-0 h-[3px] rounded-t-full bg-[#00a884]" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>

        {/* ------------------------- تبويب محادثة خاصة ------------------------- */}
        {tab === 'private' && (
          <>
            {searchBox(privateQuery, setPrivateQuery, 'البحث في المستخدمين')}
            <div className="chat-scroll max-h-80 min-h-40 overflow-y-auto p-1.5" role="list" aria-label="قائمة المستخدمين">
              {loading ? (
                skeletons
              ) : users.length === 0 ? (
                noUsers
              ) : privateFiltered.length === 0 ? (
                noResults
              ) : (
                privateFiltered.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    role="listitem"
                    disabled={creatingId !== null}
                    onClick={() => void handlePick(u)}
                    className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start transition-colors hover:bg-black/[0.04] disabled:opacity-60"
                  >
                    {userAvatar(u)}
                    {userNamePhone(u)}
                    {creatingId === u.id && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#00a884]" />}
                  </button>
                ))
              )}
            </div>
            {error && (
              <p role="alert" className="px-4 pb-3 text-sm font-medium text-red-600">
                {error}
              </p>
            )}
            {fetchError && (
              <p role="alert" className="px-4 pb-3 text-sm font-medium text-red-600">
                {fetchError}
              </p>
            )}
          </>
        )}

        {/* ------------------------- تبويب مجموعة جديدة ------------------------- */}
        {tab === 'group' && (
          <>
            <div className="p-3 pb-1.5">
              <Input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                dir="auto"
                maxLength={60}
                placeholder="اسم المجموعة"
                aria-label="اسم المجموعة"
                className="h-11 rounded-lg border-transparent bg-[#f0f2f5] px-3 text-sm font-bold text-[#111b21] placeholder:font-normal placeholder:text-[#8696a0] focus-visible:border-[#00a884]/40"
              />
            </div>
            {searchBox(groupQuery, setGroupQuery, 'البحث في المستخدمين لإضافتهم للمجموعة')}
            <div
              className="chat-scroll max-h-72 min-h-36 overflow-y-auto p-1.5"
              role="list"
              aria-label="اختيار أعضاء المجموعة"
            >
              {loading ? (
                skeletons
              ) : users.length === 0 ? (
                noUsers
              ) : groupFiltered.length === 0 ? (
                noResults
              ) : (
                groupFiltered.map((u) => {
                  const selected = selectedIds.has(u.id);
                  return (
                    <div key={u.id} role="listitem">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={selected}
                        aria-label={`اختيار ${u.name}`}
                        disabled={creatingGroup}
                        onClick={() => toggleMember(u.id)}
                        className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start transition-colors hover:bg-black/[0.04] disabled:opacity-60"
                      >
                        {userAvatar(u)}
                        {userNamePhone(u)}
                        <span
                          aria-hidden="true"
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                            selected ? 'border-[#00a884] bg-[#00a884]' : 'border-[#8696a0] bg-transparent'
                          }`}
                        >
                          {selected && <Check className="h-4 w-4 text-white" strokeWidth={3} />}
                        </span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            {fetchError && (
              <p role="alert" className="px-4 pb-2 text-sm font-medium text-red-600">
                {fetchError}
              </p>
            )}
            {groupError && (
              <p role="alert" className="px-4 pb-2 text-sm font-medium text-red-600">
                {groupError}
              </p>
            )}
            {/* زر ثابت أسفل الحوار */}
            <div className="shrink-0 border-t border-[#e9edef] p-3">
              <button
                type="button"
                onClick={handleCreateGroup}
                disabled={!groupName.trim() || selectedIds.size === 0 || creatingGroup}
                aria-label="إنشاء المجموعة"
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-[#00a884] text-sm font-bold text-white transition-colors hover:bg-[#017561] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creatingGroup ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    جاري الإنشاء...
                  </>
                ) : (
                  <>
                    <Users className="h-4 w-4" aria-hidden="true" />
                    {selectedIds.size > 0 ? `إنشاء المجموعة (${selectedIds.size})` : 'إنشاء المجموعة'}
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
