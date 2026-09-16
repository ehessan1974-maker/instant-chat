import { NextResponse } from 'next/server'
import { isTelegramConfigured } from '@/lib/telegram'
import { demoOtpAllowed, getSmsProvider, isSmsConfigured } from '@/lib/sms'

/**
 * GET /api/auth/channels
 * يكشف قنوات إرسال رمز الدخول المتاحة حتى تعرض الواجهة الخيار الصحيح
 * من أول لحظة بدل اكتشافها بعد المحاولة.
 *
 * telegram: true عند ضبط توكن بوت تيليجرام
 * sms:      'relay' | 'twilio' | 'vonage' | 'http' → مزود حقيقي مضبوط
 *           'demo' → وضع تجريبي (يظهر الرمز في الواجهة — خارج الإنتاج فقط)
 *           null   → الإنتاج بلا مزود SMS — نخفي الخيار بدل إظهاره معطلاً
 */
export async function GET() {
  const provider = getSmsProvider()
  let sms: string | null
  if (isSmsConfigured() && provider) {
    sms = provider
  } else if (demoOtpAllowed()) {
    sms = 'demo'
  } else {
    sms = null
  }
  return NextResponse.json({ telegram: isTelegramConfigured(), sms })
}
