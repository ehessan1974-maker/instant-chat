// خطّاف إقلاع Next.js — يحمّل إعدادات قاعدة البيانات (معالج التهيئة) ثم يشغّل
// بوت تيليجرام داخل نفس عملية الخادم (لا منفذ إضافي ولا خدمة خارجية).
// يبدأ البوت إذا وُجد التوكن في متغيرات البيئة أو في إعدادات قاعدة البيانات.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { loadSettings } = await import('@/lib/settings')
    await loadSettings(true)
    const { telegramTokenCached, startBotPolling } = await import('@/lib/telegram')
    if (!telegramTokenCached()) return
    await startBotPolling()
  } catch (e) {
    console.error('[instrumentation] فشل بدء بوت تيليجرام:', e)
  }
}
