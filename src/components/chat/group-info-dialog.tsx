'use client';

import { useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Loader2, LogOut, Search, UserPlus, UserRoundSearch } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatAvatar } from '@/components/chat/avatar';
import { getSocket } from '@/lib/chat-socket';
import {
  fetchUsers,
  type Conversation,
  type GroupMember,
  type UserSummary,
} from '@/lib/chat-api';

/** ردّ الخادم على add_members / leave_group (ack) */
interface AddMembersAck {
  ok?: boolean;
  error?: string;
  added?: { id: string; name: string }[];
}

interface LeaveGroupAck {
  ok?: boolean;
  error?: string;
}

interface GroupInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: Conversation;
  meId: string;
  /** يُستدعى بعد نجاح إضافة أعضاء (لتحديث members في الحالة الأب) */
  onMembersChanged?: (members: GroupMember[]) => void;
  /** يُستدعى بعد نجاح مغادرتي المجموعة */
  onLeft?: () => void;
}

type View = 'main' | 'add';

/** فلترة محلية بالاسم أو الهاتف (غير حساسة لحالة الأحرف) */
function matchesQuery(u: UserSummary, q: string): boolean {
  if (!q) return true;
  const name = (u.name || '').toLowerCase();
  const phone = (u.phone || '').replace(/[\s-]/g, '');
  const needle = q.toLowerCase();
  return name.includes(needle) || phone.includes(q.replace(/[\s-]/g, ''));
}

export function GroupInfoDialog({
  open,
  onOpenChange,
  conversation,
  meId,
  onMembersChanged,
  onLeft,
}: GroupInfoDialogProps) {
  const [view, setView] = useState<View>('main');
  const [error, setError] = useState<string | null>(null);

  // أعضاء أضفتهم محلياً خلال هذه الجلسة (يدمج مع قائمة الأب عند العرض)
  const [addedMembers, setAddedMembers] = useState<GroupMember[]>([]);

  // إضافة أعضاء
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const fetchSeqRef = useRef(0);

  // مغادرة المجموعة
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);

  const creatorId = conversation.creatorId ?? null;

  /* ---------- الأعضاء المعروضون: قائمة الأب + المضافون محلياً (بدون تكرار) ---------- */
  const members = useMemo(() => {
    const base = conversation.members ?? [];
    if (addedMembers.length === 0) return base;
    const ids = new Set(base.map((m) => m.id));
    const extra = addedMembers.filter((m) => !ids.has(m.id));
    return extra.length > 0 ? [...base, ...extra] : base;
  }, [conversation.members, addedMembers]);

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);

  /** مرشّحون للإضافة: غير موجودين أصلاً + مطابقون للبحث */
  const candidates = useMemo(() => {
    const q = query.trim();
    return users.filter((u) => !memberIds.has(u.id) && matchesQuery(u, q));
  }, [users, memberIds, query]);

  /* ---------------- إعادة التهيئة الكاملة عند الإغلاق ---------------- */
  // كل مسارات الإغلاق (X / Esc / الخلفية / برمجياً) تمر عبر onOpenChange هنا،
  // لذا تصفير الحالة عند الإغلاق يضمن فتحاً نظيفاً في المرة التالية بلا تأثيرات.
  function resetAll() {
    setView('main');
    setError(null);
    setQuery('');
    setSelectedIds(new Set());
    setConfirmLeave(false);
    setAddedMembers([]);
    setUsers([]);
    setUsersLoading(false);
    setUsersError(null);
    fetchSeqRef.current += 1; // إبطال أي طلب تحميل جارٍ
  }

  function handleOpenChange(o: boolean) {
    if (!o) resetAll();
    onOpenChange(o);
  }

  /* ---------------- فتح عرض الإضافة وتحميل المستخدمين ---------------- */
  function openAddView() {
    const seq = ++fetchSeqRef.current;
    setView('add');
    setSelectedIds(new Set());
    setQuery('');
    setError(null);
    setUsers([]);
    setUsersError(null);
    setUsersLoading(true);
    fetchUsers()
      .then((res) => {
        if (fetchSeqRef.current === seq) setUsers(res.users ?? []);
      })
      .catch(() => {
        if (fetchSeqRef.current === seq) setUsersError('تعذر تحميل المستخدمين، حاول مجدداً');
      })
      .finally(() => {
        if (fetchSeqRef.current === seq) setUsersLoading(false);
      });
  }

  function backToMain() {
    setView('main');
    setSelectedIds(new Set());
    setQuery('');
    setError(null);
  }

  /* ---------------- إضافة أعضاء (سوكيت + ack) ---------------- */
  function toggleUser(id: string) {
    if (addingRef.current) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleAddMembers() {
    if (addingRef.current) return;
    const chosen = users.filter((u) => selectedIds.has(u.id));
    if (chosen.length === 0) return;

    const socket = getSocket();
    if (!socket) {
      setError('غير متصل بالخادم — انتظر إعادة الاتصال ثم حاول مجدداً');
      return;
    }

    addingRef.current = true;
    setAdding(true);
    setError(null);

    const timeout = window.setTimeout(() => {
      if (!addingRef.current) return;
      addingRef.current = false;
      setAdding(false);
      setError('انتهت مهلة الطلب — تحقق من الاتصال وحاول مجدداً');
    }, 12000);

    socket.emit(
      'add_members',
      { conversationId: conversation.id, memberIds: Array.from(selectedIds) },
      (r?: AddMembersAck) => {
        window.clearTimeout(timeout);
        addingRef.current = false;
        setAdding(false);
        if (r?.ok) {
          // بناء القائمة الجديدة محلياً: الحاليون + المختارون (بياناتهم كاملة من fetchUsers)
          const fresh = chosen
            .map((u) => ({ id: u.id, name: u.name, avatarColor: u.avatarColor, phone: u.phone ?? null }))
            .filter((m) => !memberIds.has(m.id));
          const merged = fresh.length > 0 ? [...members, ...fresh] : members;
          setAddedMembers((prev) => [...prev, ...fresh]);
          setSelectedIds(new Set());
          setView('main'); // العودة للعرض الرئيسي بعد نجاح الإضافة
          onMembersChanged?.(merged);
        } else {
          setError(
            r?.error === 'MEMBERS_REQUIRED' ? 'يرجى اختيار عضو واحد على الأقل' : 'تعذر إضافة الأعضاء، حاول مجدداً'
          );
        }
      }
    );
  }

  /* ---------------- مغادرة المجموعة (سوكيت + ack) ---------------- */
  function handleLeave() {
    if (leavingRef.current) return;
    const socket = getSocket();
    if (!socket) {
      setConfirmLeave(false);
      setError('غير متصل بالخادم — انتظر إعادة الاتصال ثم حاول مجدداً');
      return;
    }

    leavingRef.current = true;
    setLeaving(true);
    setError(null);

    const timeout = window.setTimeout(() => {
      if (!leavingRef.current) return;
      leavingRef.current = false;
      setLeaving(false);
      setConfirmLeave(false);
      setError('انتهت مهلة الطلب — تحقق من الاتصال وحاول مجدداً');
    }, 12000);

    socket.emit('leave_group', { conversationId: conversation.id }, (r?: LeaveGroupAck) => {
      window.clearTimeout(timeout);
      leavingRef.current = false;
      setLeaving(false);
      if (r?.ok) {
        onLeft?.();
        handleOpenChange(false);
      } else {
        setConfirmLeave(false);
        setError('تعذر مغادرة المجموعة، حاول مجدداً');
      }
    });
  }

  /* ---------------- عناصر مشتركة ---------------- */
  const skeletons = (
    <div className="flex flex-col gap-4 p-3" aria-label="جاري التحميل">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );

  const noUsers = (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <UserRoundSearch className="h-7 w-7 text-[#8696a0]" />
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

  const allMembersAlready = (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <Check className="h-7 w-7 text-[#00a884]" />
      <p className="text-sm font-bold text-[#111b21]">الجميع موجود في المجموعة</p>
      <p className="text-xs text-[#667781]">لا يوجد مستخدمون جدد يمكن إضافتهم حالياً</p>
    </div>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-sm gap-0 overflow-hidden rounded-2xl p-0" dir="rtl">
          {/* ===================== العرض الرئيسي: معلومات المجموعة ===================== */}
          {view === 'main' && (
            <>
              {/* رأس المجموعة */}
              <div className="flex flex-col items-center gap-1.5 px-6 pb-4 pt-7 text-center">
                <ChatAvatar group size={64} />
                <DialogTitle className="mt-1 text-lg font-bold text-[#111b21]">
                  {conversation.name || 'مجموعة'}
                </DialogTitle>
                <DialogDescription className="text-xs text-[#667781]">
                  مجموعة · {members.length} أعضاء
                </DialogDescription>
              </div>

              {/* قسم الأعضاء */}
              <div className="border-t border-[#e9edef] px-3 pb-2 pt-3">
                <div className="mb-1 flex items-center justify-between px-1.5">
                  <h3 className="text-sm font-bold text-[#111b21]">الأعضاء</h3>
                  <span className="text-xs text-[#667781]">{members.length}</span>
                </div>

                <button
                  type="button"
                  onClick={openAddView}
                  aria-label="إضافة أعضاء إلى المجموعة"
                  className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-start transition-colors hover:bg-black/[0.04]"
                >
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#00a884] text-white"
                    aria-hidden="true"
                  >
                    <UserPlus className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-bold text-[#00a884]">إضافة أعضاء</span>
                </button>

                <div className="chat-scroll max-h-64 overflow-y-auto" role="list" aria-label="أعضاء المجموعة">
                  {members.map((m) => (
                    <div key={m.id} role="listitem" className="flex items-center gap-3 rounded-xl px-2.5 py-2">
                      <ChatAvatar name={m.name} color={m.avatarColor} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-bold text-[#111b21]">{m.name}</span>
                          {m.id === meId && (
                            <span className="shrink-0 rounded-full bg-[#f0f2f5] px-1.5 py-0.5 text-[10px] font-bold text-[#667781]">
                              أنت
                            </span>
                          )}
                          {m.id === creatorId && (
                            <span className="shrink-0 rounded-full bg-[#00a884]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#008069]">
                              المنشئ
                            </span>
                          )}
                        </div>
                        {m.phone && (
                          <div dir="ltr" className="truncate text-xs text-[#667781]">
                            {m.phone}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {error && (
                <p role="alert" className="px-4 pb-2 text-xs font-medium text-red-600">
                  {error}
                </p>
              )}

              {/* مغادرة المجموعة */}
              <div className="mt-auto border-t border-[#e9edef] p-2">
                <button
                  type="button"
                  onClick={() => setConfirmLeave(true)}
                  disabled={leaving}
                  aria-label="مغادرة المجموعة"
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-bold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-60"
                >
                  {leaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                  )}
                  مغادرة المجموعة
                </button>
              </div>
            </>
          )}

          {/* ===================== عرض ثانٍ: إضافة أعضاء ===================== */}
          {view === 'add' && (
            <>
              <div className="flex items-center gap-1 border-b border-[#e9edef] px-1.5 py-1.5">
                <button
                  type="button"
                  onClick={backToMain}
                  aria-label="رجوع إلى معلومات المجموعة"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#111b21] transition-colors hover:bg-black/[0.05]"
                >
                  <ArrowRight className="h-5 w-5" aria-hidden="true" />
                </button>
                <div className="min-w-0">
                  <DialogTitle className="truncate text-base font-bold text-[#111b21]">إضافة أعضاء</DialogTitle>
                  <DialogDescription className="truncate text-xs text-[#667781]">
                    إلى: {conversation.name || 'مجموعة'}
                  </DialogDescription>
                </div>
              </div>

              <div className="p-3 pb-1.5">
                <div className="relative">
                  <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8696a0]" />
                  <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="ابحث بالاسم أو رقم الهاتف..."
                    aria-label="البحث في المستخدمين لإضافتهم للمجموعة"
                    className="h-11 rounded-lg border-transparent bg-[#f0f2f5] ps-9 pe-3 text-sm text-[#111b21] placeholder:text-[#8696a0] focus-visible:border-[#00a884]/40"
                  />
                </div>
              </div>

              <div
                className="chat-scroll max-h-72 min-h-36 overflow-y-auto p-1.5"
                role="list"
                aria-label="قائمة المستخدمين المتاحين للإضافة"
              >
                {usersLoading ? (
                  skeletons
                ) : usersError ? (
                  <p role="alert" className="px-4 py-6 text-center text-sm font-medium text-red-600">
                    {usersError}
                  </p>
                ) : users.length === 0 ? (
                  noUsers
                ) : candidates.length === 0 ? (
                  allMembersAlready
                ) : (
                  candidates.map((u) => {
                    const selected = selectedIds.has(u.id);
                    return (
                      <div key={u.id} role="listitem">
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={selected}
                          aria-label={`اختيار ${u.name}`}
                          disabled={adding}
                          onClick={() => toggleUser(u.id)}
                          className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start transition-colors hover:bg-black/[0.04] disabled:opacity-60"
                        >
                          <div className="relative shrink-0">
                            <ChatAvatar name={u.name} color={u.avatarColor} size={40} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[15px] font-bold text-[#111b21]">{u.name}</div>
                            {u.phone ? (
                              <div dir="ltr" className="truncate text-xs text-[#667781]">
                                {u.phone}
                              </div>
                            ) : (
                              <div className="truncate text-xs text-[#667781]">{u.about || ''}</div>
                            )}
                          </div>
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

              {error && (
                <p role="alert" className="px-4 pb-2 text-xs font-medium text-red-600">
                  {error}
                </p>
              )}

              {/* زر الإضافة الثابت */}
              <div className="shrink-0 border-t border-[#e9edef] p-3">
                <button
                  type="button"
                  onClick={handleAddMembers}
                  disabled={selectedIds.size === 0 || adding}
                  aria-label="إضافة الأعضاء المختارين"
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-[#00a884] text-sm font-bold text-white transition-colors hover:bg-[#017561] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {adding ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      جاري الإضافة...
                    </>
                  ) : (
                    <>
                      <UserPlus className="h-4 w-4" aria-hidden="true" />
                      {selectedIds.size > 0 ? `إضافة (${selectedIds.size})` : 'إضافة'}
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* تأكيد مغادرة المجموعة */}
      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent dir="rtl" className="max-w-sm rounded-2xl">
          <AlertDialogHeader className="text-start sm:text-start">
            <AlertDialogTitle className="text-[#111b21]">مغادرة المجموعة؟</AlertDialogTitle>
            <AlertDialogDescription className="text-[#667781]">
              لن تصلك رسائل «{conversation.name || 'مجموعة'}» بعد مغادرتك لها، وسيظهر للأعضاء أنك غادرت.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row justify-start gap-2 sm:flex-row sm:justify-start">
            <AlertDialogCancel disabled={leaving} className="min-h-11 rounded-full px-5">
              إلغاء
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={leaving}
              onClick={(e) => {
                e.preventDefault(); // نُبقي التأكيد مفتوحاً حتى وصول ردّ الخادم
                handleLeave();
              }}
              className="min-h-11 rounded-full bg-red-600 px-5 text-white hover:bg-red-700"
            >
              {leaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  جاري المغادرة...
                </>
              ) : (
                'مغادرة'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
