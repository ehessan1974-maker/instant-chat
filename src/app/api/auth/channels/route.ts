import { NextResponse } from 'next/server'
import { resolveTelegramToken } from '@/lib/telegram'
import { demoOtpAllowed, isProviderConfigured, resolveSmsProvider } from '@/lib/sms'

/**
 * GET /api/auth/channels — يكشف قنوات تسليم رمز الدخول المتاحة فعلياً
 * { telegram: boolean, sms: 'relay'|'twilio'|'vonage'|'http'|'demo'|null }
 * null = إنتاج بلا مزود → نخفي الخيار بدل إظهاره معطلاً
 * (تُقرأ التهيئة من متغيرات البيئة أو من إعدادات معالج التفعيل في قاعدة البيانات)
 */
export async function GET() {
  const [telegramToken, provider] = await Promise.all([
    resolveTelegramToken(),
    resolveSmsProvider(),
  ])

  let sms: string | null
  if (isProviderConfigured(provider)) {
    sms = provider
  } else if (demoOtpAllowed()) {
    sms = 'demo'
  } else {
    sms = null
  }
  return NextResponse.json({ telegram: Boolean(telegramToken), sms })
}
