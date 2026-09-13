// خطّاف إقلاع Next.js — يشغّل بولر بوت تيليجرام داخل نفس عملية الخادم
// (لا منفذ إضافي ولا خدمة خارجية). لا يبدأ إلا إذا وُجد TELEGRAM_BOT_TOKEN.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (!process.env.TELEGRAM_BOT_TOKEN) return
  try {
    const { startBotPolling } = await import('@/lib/telegram')
    await startBotPolling()
  } catch (e) {
    console.error('[instrumentation] فشل بدء بوت تيليجرام:', e)
  }
}
