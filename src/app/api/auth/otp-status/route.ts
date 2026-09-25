import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

/**
 * GET /api/auth/otp-status?link=<linkCode>
 * استطلاع حالة رمز تيليجرام المعلق (يستدعيه المتصفح كل بضع ثوانٍ).
 * يعيد الحالة فقط — بلا أي أسرار (الرمز لا يُكشف هنا أبداً):
 *   pending   → لم يُسلَّم بعد (المستخدم لم يضغط START)
 *   delivered → وصل الرمز للتيليجرام (بانتظار الضغط على «تأكيد الدخول» أو كتابته يدوياً)
 *   approved  → ضُغط «تأكيد الدخول» — يمكن للمتصفح إكمال الدخول عبر verify-telegram
 *   expired   → انتهى أو استُهلك
 */
export async function GET(req: Request) {
  const link = new URL(req.url).searchParams.get('link') || ''
  if (!/^[a-f0-9]{48}$/i.test(link)) {
    return NextResponse.json({ status: 'expired' })
  }

  try {
    const otp = await db.otpCode.findUnique({
      where: { linkCode: link },
      select: { used: true, expiresAt: true, deliveredAt: true, approvedAt: true },
    })
    if (!otp || otp.used || otp.expiresAt.getTime() < Date.now()) {
      return NextResponse.json({ status: 'expired' })
    }
    if (otp.approvedAt) return NextResponse.json({ status: 'approved' })
    if (otp.deliveredAt) return NextResponse.json({ status: 'delivered' })
    return NextResponse.json({ status: 'pending' })
  } catch (error) {
    console.error('[auth/otp-status] failed:', error)
    return NextResponse.json({ status: 'pending' })
  }
}
