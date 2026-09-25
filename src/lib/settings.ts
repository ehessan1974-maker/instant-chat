// إعدادات الخادم في قاعدة البيانات — تسمح بتهيئة التطبيق من الواجهة نفسها
// (بطاقة «تفعيل الدخول الحقيقي» لصاحب البوت) بلا متغيرات بيئة ولا إعادة نشر.
//
// الأسبقية دائماً لمتغيرات البيئة إن وُجدت، وإلا يُقرأ من قاعدة البيانات.
// ذاكرة مؤقتة داخل العملية مع تحديث كل 30 ثانية — كافية لأن الخادم عملية واحدة.

import { db } from '@/lib/db'

const CACHE_TTL_MS = 30_000

export const SETTING_KEYS = {
  telegramBotToken: 'telegram_bot_token',
  telegramBotUsername: 'telegram_bot_username',
  smsProvider: 'sms_provider',
  smsRelayToken: 'sms_relay_token',
} as const

const cache = new Map<string, string>()
let lastLoad = 0
let loading: Promise<void> | null = null

/** تحميل الإعدادات من قاعدة البيانات إلى الذاكرة (مع تهدئة 30 ثانية) */
export async function loadSettings(force = false): Promise<void> {
  if (!force && Date.now() - lastLoad < CACHE_TTL_MS) return
  if (loading) return loading
  loading = (async () => {
    try {
      const rows = await db.setting.findMany()
      cache.clear()
      for (const row of rows) cache.set(row.key, row.value)
      lastLoad = Date.now()
    } catch {
      // جدول الإعدادات غير موجود بعد (قبل أول db:push) — نكمل بذاكرة فارغة
    } finally {
      loading = null
    }
  })()
  return loading
}

/** قراءة من الذاكرة فقط (بلا I/O) — تُستخدم في الدوال المتزامنة بعد تحميل الإقلاع */
export function getCachedSetting(key: string): string | null {
  return cache.get(key) ?? null
}

/** قراءة مع ضمان حداثة الذاكرة */
export async function getSetting(key: string): Promise<string | null> {
  await loadSettings()
  return cache.get(key) ?? null
}

/** كتابة قيمة وتحديث الذاكرة فوراً */
export async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
  cache.set(key, value)
  lastLoad = Date.now()
}
