// بوت تيليجرام لتسليم رموز الدخول — مجاني بالكامل عبر Bot API
//
// ضبطه من متغيرات البيئة (على Render):
//   TELEGRAM_BOT_TOKEN     من @BotFather (ضروري لتفعيل القناة)
//   TELEGRAM_BOT_USERNAME  يوزر البوت بدون @ (يُفضَّل ضبطه — يلغي سباق getMe
//                          عند أول طلب رمز بعد الإقلاع)
//
// التدفق:
//   1) المستخدم يطلب رمزاً من التطبيق → الخادم يولّد linkCode ويعيد رابط
//      https://t.me/<bot>?start=<linkCode>
//   2) المستخدم يفتح الرابط ويضغط START → يصلنا /start <linkCode> عبر
//      getUpdates (long polling داخل نفس عملية الخادم — لا منفذ إضافي)
//   3) البوت يطابق الرمز ويبعث رمز الدخول لهذا الشات ثم يعليم التسليم
//
// ملاحظات أمنية:
//   - linkCode عشوائي 48 حرفاً، يُستهلك مع نفس صلاحية الرمز (10 دقائق)
//   - الرمز لا يُعاد إرساله بعد أول تسليم (يُطلب رمز جديد بدل ذلك)
//   - الرمز لا يظهر في أي استجابة REST إطلاقاً

import { randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import { SETTING_KEYS, getCachedSetting, loadSettings } from '@/lib/settings'

const API_BASE = 'https://api.telegram.org/bot'

let cachedBotUsername: string | null = null
let polling = false

/** توكن البوت الفعلي: متغير البيئة أولاً ثم إعدادات قاعدة البيانات (معالج التهيئة) */
export function telegramTokenCached(): string {
  const fromEnv = (process.env.TELEGRAM_BOT_TOKEN || '').trim()
  if (fromEnv) return fromEnv
  return (getCachedSetting(SETTING_KEYS.telegramBotToken) || '').trim()
}

/** يضمن حداثة ذاكرة قاعدة البيانات ثم يعيد التوكن الفعلي */
export async function resolveTelegramToken(): Promise<string> {
  const fromEnv = (process.env.TELEGRAM_BOT_TOKEN || '').trim()
  if (fromEnv) return fromEnv
  await loadSettings()
  return telegramTokenCached()
}

export function isTelegramConfigured(): boolean {
  return Boolean(telegramTokenCached())
}

/** يوزر البوت: البيئة ← قاعدة البيانات (معالج التهيئة) ← ذاكرة getMe — أو null */
export function getTelegramBotUsername(): string | null {
  const fromEnv = (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '')
  if (fromEnv) return fromEnv
  const fromDb = getCachedSetting(SETTING_KEYS.telegramBotUsername)
  if (fromDb) return fromDb
  return cachedBotUsername
}

/** تحديث اسم البوت المُخزّن فوراً بعد معالج التهيئة — بلا انتظار getMe جديد */
export function setCachedBotUsername(username: string | null): void {
  cachedBotUsername = username
}

/** هل حلقة بولينج البوت تعمل حالياً؟ */
export function isBotPollingActive(): boolean {
  return polling
}

/** رمز ربط عشوائي آمن لرابط تيليجرام */
export function newTelegramLinkCode(): string {
  return randomBytes(24).toString('hex')
}

/// جلب معرّف الشات المرتبط بالرقم (الربط الدائم بعد أول تسليم) — أو null
export async function getTelegramChatId(phone: string): Promise<number | null> {
  try {
    const binding = await db.telegramBinding.findUnique({ where: { phone } })
    return binding?.chatId ?? null
  } catch {
    return null
  }
}

/// حفظ/تحديث الربط الدائم بين الرقم والشات (يُستدعى بعد كل تسليم ناجح عبر البوت)
async function upsertTelegramBinding(phone: string, chatId: number): Promise<void> {
  try {
    await db.telegramBinding.upsert({
      where: { phone },
      update: { chatId },
      create: { phone, chatId },
    })
  } catch (e) {
    console.error('[telegram] حفظ الربط الدائم فشل:', e instanceof Error ? e.message : e)
  }
}

interface TgResponse<T> {
  ok?: boolean
  result?: T
  description?: string
  error_code?: number
}

interface TgUpdate {
  update_id?: number
  message?: {
    chat?: { id?: number }
    text?: string
  }
  callback_query?: {
    id?: number
    data?: string
    message?: { chat?: { id?: number } }
  }
}

async function tgCall<T>(
  method: string,
  payload?: unknown,
  timeoutMs = 12_000
): Promise<T | null> {
  const token = telegramTokenCached()
  if (!token) return null
  try {
    const res = await fetch(`${API_BASE}${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    let data: TgResponse<T> | null = null
    try {
      data = (await res.json()) as TgResponse<T>
    } catch {
      return null
    }
    if (data?.ok) return data.result ?? null
    console.error(
      `[telegram] ${method} فشل (${data?.error_code ?? res.status}):`,
      data?.description || 'unknown'
    )
    return null
  } catch (e) {
    console.error('[telegram] خطأ شبكة:', method, e instanceof Error ? e.message : e)
    return null
  }
}

export async function sendTelegramMessage(
  chatId: number | string,
  text: string
): Promise<boolean> {
  const result = await tgCall<{ message_id?: number }>('sendMessage', {
    chat_id: chatId,
    text,
  })
  return Boolean(result)
}

/**
 * إرسال رمز الدخول مع زر «تأكيد الدخول» (inline callback) —
 * الضغط عليه يُدخّل المستخدم تلقائياً في التطبيق بلا كتابة الرمز.
 */
export async function sendTelegramOtp(
  chatId: number | string,
  text: string,
  linkCode: string
): Promise<boolean> {
  const result = await tgCall<{ message_id?: number }>('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ تأكيد الدخول', callback_data: `approve:${linkCode}` }],
      ],
    },
  })
  return Boolean(result)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** يشغّل البوت (يُستدعى من instrumentation عند إقلاع الخادم) */
export async function startBotPolling(): Promise<void> {
  if (polling || !isTelegramConfigured()) return
  polling = true

  const me = await tgCall<{ username?: string }>('getMe')
  if (me?.username) {
    cachedBotUsername = me.username
    console.log(`[telegram] البوت جاهز: @${me.username}`)
  } else {
    console.error('[telegram] تعذر جلب هوية البوت (getMe) — تحقق من TELEGRAM_BOT_TOKEN')
  }

  // أي webhook قديم يمنع getUpdates — نحذفه عند الإقلاع
  await tgCall('deleteWebhook', { drop_pending_updates: false })

  void pollLoop()
}

async function pollLoop(): Promise<void> {
  let offset = 0
  for (;;) {
    const updates = await tgCall<TgUpdate[]>(
      'getUpdates',
      { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
      35_000
    )
    if (updates === null) {
      // خطأ شبكة/توكن — تراجع قصير حتى لا نضغط الـ API
      await sleep(5_000)
      continue
    }
    for (const update of updates) {
      if (typeof update.update_id === 'number') {
        offset = Math.max(offset, update.update_id + 1)
      }
      try {
        await handleUpdate(update)
      } catch (e) {
        console.error('[telegram] معالجة تحديث فشلت:', e instanceof Error ? e.message : e)
      }
    }
  }
}

async function handleUpdate(update: TgUpdate): Promise<void> {
  // ضغط زر «تأكيد الدخول» في تيليجرام → موافقة تُدخل المستخدم تلقائياً
  const cb = update.callback_query
  if (cb && typeof cb.data === 'string') {
    const cbChatId = cb.message?.chat?.id
    if (typeof cbChatId === 'number') {
      await handleApproveCallback(cb.data, cb.id, cbChatId)
    }
    return
  }

  const chatId = update.message?.chat?.id
  const text = (update.message?.text || '').trim()
  if (!chatId) return

  if (!text.startsWith('/start')) {
    await sendTelegramMessage(
      chatId,
      'هذا البوت يسلّم رموز الدخول لتطبيق «محادثة فورية» 📲\n' +
        'اطلب رمزك من التطبيق أولاً ثم اضغط زر «استلم الرمز عبر تيليجرام» ليصلك الرمز هنا.'
    )
    return
  }

  // /start أو /start <linkCode>
  const param = text.replace(/^\/start\s*/, '').trim()
  if (!param) {
    await sendTelegramMessage(
      chatId,
      'أهلاً بك! 👋\n' +
        'افتح تطبيق «محادثة فورية» واطلب رمز الدخول، ثم اضغط زر «استلم الرمز عبر تيليجرام» وسيصلك الرمز هنا خلال ثوانٍ.'
    )
    return
  }

  await deliverOtpByLinkCode(param, chatId)
}

/** معالجة ضغط زر «تأكيد الدخول» — يعليم الموافقة في القاعدة ليدخل المتصفح تلقائياً */
async function handleApproveCallback(
  data: string,
  callbackQueryId: number | undefined,
  chatId: number
): Promise<void> {
  const answer = (text: string): void => {
    if (typeof callbackQueryId !== 'number') return
    void tgCall('answerCallbackQuery', { callback_query_id: callbackQueryId, text }, 8_000)
  }

  // الشاتات الجماعية لا تصلح — رسالة الرمز تُرى من غير صاحبها
  if (chatId <= 0) {
    answer('يُسمح بالتأكيد في محادثة خاصة فقط')
    return
  }

  if (!data.startsWith('approve:')) {
    answer('')
    return
  }
  const linkCode = data.slice('approve:'.length).trim()
  if (!/^[a-f0-9]{48}$/i.test(linkCode)) {
    answer('رمز غير صالح')
    return
  }

  try {
    const otp = await db.otpCode.findUnique({ where: { linkCode } })
    if (!otp || otp.used || otp.expiresAt.getTime() < Date.now()) {
      answer('⌛ الطلب منتهي — اطلب رمزاً جديداً من التطبيق')
      return
    }

    await db.otpCode.update({
      where: { id: otp.id },
      data: {
        approvedAt: new Date(),
        ...(otp.deliveredAt ? {} : { deliveredAt: new Date() }),
      },
    })
    answer('✓ تم التأكيد — ارجع إلى التطبيق')
    await sendTelegramMessage(
      chatId,
      '✅ تم تأكيد الدخول.\nارجع إلى التطبيق — سيُسجّل دخولك تلقائياً خلال ثوانٍ.'
    )
    console.log('[telegram] أُقرّ دخول (زر تأكيد) لرقم ينتهي بـ', otp.phone.slice(-4))
  } catch (e) {
    console.error('[telegram] معالجة التأكيد فشلت:', e instanceof Error ? e.message : e)
    answer('⚠️ حدث خطأ — حاول مجدداً')
  }
}

async function deliverOtpByLinkCode(linkCode: string, chatId: number): Promise<void> {
  let otp: {
    id: string
    code: string
    phone: string
    used: boolean
    expiresAt: Date
    deliveredAt: Date | null
  } | null = null
  try {
    otp = await db.otpCode.findUnique({ where: { linkCode } })
  } catch (e) {
    console.error('[telegram] قراءة OTP فشلت:', e instanceof Error ? e.message : e)
  }

  if (!otp || otp.used || otp.expiresAt.getTime() < Date.now()) {
    await sendTelegramMessage(
      chatId,
      '⌛ هذا الرابط منتهي أو مستهلك.\n' +
        'ارجع إلى التطبيق واطلب رمزاً جديداً (بعد دقيقة من الطلب السابق).'
    )
    return
  }

  if (otp.deliveredAt) {
    await sendTelegramMessage(
      chatId,
      '✅ أُرسل الرمز سابقاً في رسالة أعلاه.\n' +
        'إن لم يصلك، ارجع للتطبيق واطلب رمزاً جديداً بعد دقيقة.'
    )
    return
  }

  const template = process.env.OTP_MESSAGE_TEMPLATE || 'رمز الدخول لمحادثة فورية: {code}'
  const text = template.replace('{code}', otp.code)
  // زر التأكيد يُدخل المستخدم تلقائياً في التطبيق بلا كتابة الرمز
  const sent = await sendTelegramOtp(chatId, text, linkCode)
  if (sent) {
    try {
      await db.otpCode.update({
        where: { id: otp.id },
        data: { deliveredAt: new Date() },
      })
    } catch (e) {
      console.error('[telegram] تعليم التسليم فشل:', e instanceof Error ? e.message : e)
    }
    // ربط دائم: الرموز القادمة لهذا الرقم تُرسل فوراً بلا زر وبلا START
    await upsertTelegramBinding(otp.phone, chatId)
    console.log('[telegram] سُلّم رمز دخول لرقم ينتهي بـ', otp.phone.slice(-4))
  } else {
    await sendTelegramMessage(chatId, '⚠️ حدث خطأ مؤقت — أعد ضغط زر الاستلام من التطبيق.')
  }
}
