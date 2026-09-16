// عميل REST لتطبيق "محادثة فورية" — يقرأ التوكن من localStorage('ic_token')
// ويضيف الترويسة Authorization: Bearer <token> لكل طلب محمي.

export interface Me {
  id: string;
  phone: string;
  name: string;
  avatarColor: string;
  about?: string | null;
}

export interface UserSummary {
  id: string;
  name: string;
  avatarColor: string;
  about?: string | null;
  lastSeen?: string | null;
  phone?: string | null;
}

export interface LastMessage {
  id: string;
  text: string;
  createdAt: string;
  senderId: string;
  senderName?: string | null;
  type?: string;
  mediaUrl?: string | null;
  durationMs?: number | null;
}

/** عضو مجموعة */
export interface GroupMember {
  id: string;
  name: string;
  avatarColor: string;
  phone?: string | null;
}

export interface ConversationOther {
  id: string;
  name: string;
  avatarColor: string;
  lastSeen?: string | null;
  /** دفاعي: قد يضيفه الوكيل 2-a لاحقاً — إن غاب نعرض "sent" افتراضياً */
  lastReadAt?: string | null;
}

export interface Conversation {
  id: string;
  type: 'private' | 'group' | string;
  name?: string | null;
  other?: ConversationOther;
  /** للمجموعات: قائمة الأعضاء الكاملة */
  members?: GroupMember[];
  /** للمجموعات: مُنشئ المجموعة (admin) */
  creatorId?: string | null;
  lastMessage?: LastMessage;
  unreadCount: number;
  myLastReadAt?: string | null;
  /** دفاعي: صيغة بديلة محتملة لحقل آخر قراءة للطرف الآخر */
  otherLastReadAt?: string | null;
}

export type MsgStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  type: 'text' | 'voice' | 'system' | string;
  text: string;
  /** للرسائل الصوتية: رابط الملف الصوتي */
  mediaUrl?: string | null;
  /** للرسائل الصوتية: المدة بالمللي ثانية */
  durationMs?: number | null;
  clientId?: string | null;
  createdAt: string;
  sender?: { id: string; name: string; avatarColor: string };
  /** حقل واجهة فقط (لا يأتي من الخادم دائماً) */
  status?: MsgStatus;
}

const TOKEN_KEY = 'ic_token';
const ME_KEY = 'ic_me';

export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, payload: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export function storeMe(me: Me): void {
  window.localStorage.setItem(ME_KEY, JSON.stringify(me));
}

export function readStoredMe(): Me | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ME_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Me;
  } catch {
    return null;
  }
}

export function clearStoredMe(): void {
  window.localStorage.removeItem(ME_KEY);
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, cache: 'no-store' });
  } catch {
    throw new ApiError(0, null, 'تعذر الوصول للخادم — تحقق من اتصالك');
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const rec = (payload ?? {}) as Record<string, unknown>;
    const msg =
      typeof rec.error === 'string' && rec.error
        ? translateError(rec.error, res.status)
        : `فشل الطلب (${res.status})`;
    throw new ApiError(res.status, payload, msg);
  }
  return payload as T;
}

function translateError(code: string, status: number): string {
  switch (code) {
    case 'NAME_REQUIRED':
      return 'NAME_REQUIRED';
    case 'INVALID_CODE':
    case 'OTP_INVALID':
      return 'رمز التحقق غير صحيح أو منتهي الصلاحية';
    case 'OTP_COOLDOWN':
      return 'انتظر دقيقة ثم اطلب رمزاً جديداً';
    case 'OTP_RATE_LIMITED':
      return 'تجاوزت عدد مرات إرسال الرموز المسموحة — حاول لاحقاً';
    case 'SMS_FAILED':
      return 'تعذر إرسال الرسالة النصية — تحقق من الرقم وحاول بعد قليل';
    case 'SMS_NOT_CONFIGURED':
      return 'خدمة الرسائل النصية غير مفعّلة على الخادم بعد — استخدم تيليجرام';
    case 'TOO_MANY_ATTEMPTS':
      return 'محاولات كثيرة خاطئة — انتظر 15 دقيقة ثم جرّب مجدداً';
    case 'PHONE_REQUIRED':
      return 'يرجى إدخال رقم هاتف صحيح';
    case 'UNAUTHORIZED':
      return 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً';
    case 'FORBIDDEN':
      return 'لا تملك صلاحية الوصول لهذه المحادثة';
    case 'NOT_FOUND':
      return 'غير موجود';
    default:
      return status === 0 ? 'تعذر الوصول للخادم' : `حدث خطأ (${status})`;
  }
}

/* ----------------------------- المصادقة ----------------------------- */

export interface RequestOtpResult {
  ok?: boolean;
  code?: string;
  isNew?: boolean;
  /** true = أُرسل الرمز فعلياً (رسالة SMS أو تيليجرام) ولا يظهر في الاستجابة */
  delivered?: boolean;
  /** قناة التسليم: sms | telegram */
  channel?: string;
  /** عند التسليم عبر تيليجرام: رابط ضغطة واحدة لاستلام الرمز من البوت (أول مرة فقط) */
  linkUrl?: string;
  /** true = أُرسل الرمز مباشرة إلى شات تيليجرام المرتبط — بلا زر وبلا START */
  direct?: boolean;
  /** رمز الربط المعلق (للاستطلاع والدخول التلقائي بضغطة «تأكيد الدخول») */
  link?: string;
  error?: string;
}

export function requestOtp(
  phone: string,
  channel?: 'telegram' | 'sms'
): Promise<RequestOtpResult> {
  return apiFetch<RequestOtpResult>('/api/auth/request-otp', {
    method: 'POST',
    body: JSON.stringify(channel ? { phone, channel } : { phone }),
  });
}

/** القنوات المتاحة لإرسال رمز الدخول — يكشفها الخادم ليعرض الزر الصحيح من البداية */
export interface OtpChannels {
  telegram: boolean;
  /** 'relay'|'twilio'|'vonage'|'http' مزود حقيقي — 'demo' وضع تجريبي — null غير مفعّل */
  sms: string | null;
}

export async function fetchChannels(): Promise<OtpChannels> {
  return apiFetch<OtpChannels>('/api/auth/channels');
}

export interface VerifyResult {
  token: string;
  user: Me;
}

export function verifyOtp(phone: string, code: string, name?: string): Promise<VerifyResult> {
  return apiFetch<VerifyResult>('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify(name ? { phone, code, name } : { phone, code }),
  });
}

export interface OtpStatusResult {
  status?: 'pending' | 'delivered' | 'approved' | 'expired' | string;
}

/** استطلاع حالة رمز تيليجرام المعلق (بلا أي أسرار في الاستجابة) */
export function fetchOtpStatus(link: string): Promise<OtpStatusResult> {
  return apiFetch<OtpStatusResult>(
    `/api/auth/otp-status?link=${encodeURIComponent(link)}`
  );
}

/** الدخول التلقائي بعد ضغط «تأكيد الدخول» في تيليجرام — بلا كتابة الرمز */
export function verifyTelegram(link: string, name?: string): Promise<VerifyResult> {
  return apiFetch<VerifyResult>('/api/auth/verify-telegram', {
    method: 'POST',
    body: JSON.stringify(name ? { link, name } : { link }),
  });
}

export function fetchMe(): Promise<{ user: Me }> {
  return apiFetch<{ user: Me }>('/api/auth/me');
}

export function apiLogout(): Promise<{ ok?: boolean }> {
  return apiFetch<{ ok?: boolean }>('/api/auth/logout', { method: 'POST' });
}

/* -------------------------- المستخدمون والمحادثات -------------------------- */

export function fetchUsers(q?: string): Promise<{ users: UserSummary[] }> {
  const query = q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
  return apiFetch<{ users: UserSummary[] }>(`/api/users${query}`);
}

export function fetchConversations(): Promise<{ conversations: Conversation[] }> {
  return apiFetch<{ conversations: Conversation[] }>('/api/conversations');
}

export interface CreatedConversation {
  id: string;
  type: string;
  name?: string | null;
  other?: ConversationOther;
}

export function createConversation(userId: string): Promise<{ conversation: CreatedConversation }> {
  return apiFetch<{ conversation: CreatedConversation }>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export function fetchMessages(conversationId: string, before?: string): Promise<{ messages: ChatMessage[] }> {
  const q = before ? `?before=${encodeURIComponent(before)}` : '';
  return apiFetch<{ messages: ChatMessage[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages${q}`
  );
}
