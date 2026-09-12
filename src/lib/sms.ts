// وحدة إرسال SMS حقيقية — متعددة المزودين وتُضبط كلياً من متغيرات البيئة:
//
//   SMS_PROVIDER = twilio | vonage | http     (فارغ أو غير مضبوط = وضع تجريبي بلا إرسال)
//
// Twilio  (عالمي — لا يدعم سوريا منذ 9/2025):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   TWILIO_FROM  أو  TWILIO_MESSAGING_SERVICE_SID
//
// Vonage (Nexmo):
//   VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_FROM
//
// بوابة HTTP عامة (تناسب أي مزود محلي/إقليمي بيدعم سوريا مثل Unimatrix أو EasySendSMS):
//   SMS_HTTP_URL        (يستقبل POST بصيغة JSON: { to, message })
//   SMS_HTTP_TOKEN      (اختياري — يُرسل كـ Authorization: Bearer <token>)
//
// بوابة الموبايل (relay) — أرخص خيار: موبايل أندرويد بيرسل من باقتك المجانية:
//   SMS_PROVIDER=relay  +  SMS_RELAY_TOKEN=<رمز سري>
//   الموبايل (سطر أوامر Termux) يسحب /api/sms/relay/pending ويرسل من الشريحة
//   ثم يثبت عبر /api/sms/relay/confirm — انظر public/relay-sms.sh
//
// تحسين اختياري للرسالة (يجب أن تبقى تحت 70 حرفاً لقطاع SMS واحد):
//   OTP_MESSAGE_TEMPLATE = "رمز الدخول لمحادثة فورية: {code}"

export type SmsSendResult = { ok: true } | { ok: false; error: string }

const SEND_TIMEOUT_MS = 10_000

function activeProvider(): string {
  return (process.env.SMS_PROVIDER || '').trim().toLowerCase()
}

/** اسم المزود الحالي (twilio | vonage | http | relay | فارغ) */
export function getSmsProvider(): string {
  return activeProvider()
}

/** هل المزود مضبوط بمتغيرات البيئة؟ يحدد الوضع التجريبي مقابل الإرسال الحقيقي */
export function isSmsConfigured(): boolean {
  switch (activeProvider()) {
    case 'twilio':
      return Boolean(
        process.env.TWILIO_ACCOUNT_SID &&
          process.env.TWILIO_AUTH_TOKEN &&
          (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID)
      )
    case 'vonage':
      return Boolean(
        process.env.VONAGE_API_KEY &&
          process.env.VONAGE_API_SECRET &&
          process.env.VONAGE_FROM
      )
    case 'http':
      return Boolean(process.env.SMS_HTTP_URL)
    case 'relay':
      return Boolean(process.env.SMS_RELAY_TOKEN)
    default:
      return false
  }
}

async function postJson(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; data: unknown; networkError?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    return { status: res.status, data }
  } catch (e) {
    return {
      status: 0,
      data: null,
      networkError: e instanceof Error ? e.message : 'network',
    }
  }
}

async function sendViaTwilio(to: string, text: string): Promise<SmsSendResult> {
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim()
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim()
  const from = (process.env.TWILIO_FROM || '').trim()
  const messagingServiceSid = (process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim()

  const params = new URLSearchParams()
  params.set('To', to) // E.164 مثل ‎+9639xxxxxxxx
  params.set('Body', text)
  if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid)
  else params.set('From', from)

  const { status, data, networkError } = await postJson(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    params.toString(),
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
    }
  )
  if (networkError) return { ok: false, error: `twilio_network:${networkError}` }
  if (status === 201) return { ok: true }
  const message =
    (data as { message?: string } | null)?.message || `twilio_http_${status}`
  return { ok: false, error: message }
}

async function sendViaVonage(to: string, text: string): Promise<SmsSendResult> {
  const apiKey = (process.env.VONAGE_API_KEY || '').trim()
  const apiSecret = (process.env.VONAGE_API_SECRET || '').trim()
  const from = (process.env.VONAGE_FROM || '').trim()

  const { status, data, networkError } = await postJson(
    'https://rest.nexmo.com/sms/json',
    JSON.stringify({
      api_key: apiKey,
      api_secret: apiSecret,
      to: to.replace(/^\+/, ''), // فونيج يريد الرقم بلا +
      from,
      text,
    }),
    { 'Content-Type': 'application/json' }
  )
  if (networkError) return { ok: false, error: `vonage_network:${networkError}` }
  const first = (data as { messages?: Array<{ status?: string; 'error-text'?: string }> } | null)
    ?.messages?.[0]
  if (first && first.status === '0') return { ok: true }
  return { ok: false, error: first?.['error-text'] || `vonage_http_${status}` }
}

async function sendViaHttpGateway(to: string, text: string): Promise<SmsSendResult> {
  const url = (process.env.SMS_HTTP_URL || '').trim()
  const token = (process.env.SMS_HTTP_TOKEN || '').trim()

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  const { status, networkError } = await postJson(
    url,
    JSON.stringify({ to, message: text }),
    headers
  )
  if (networkError) return { ok: false, error: `sms_http_network:${networkError}` }
  if (status >= 200 && status < 300) return { ok: true }
  return { ok: false, error: `sms_http_${status}` }
}

/** يرسل الرسالة عبر المزود المضبوط. يعيد ok=false مع سبب عام عند الفشل */
export async function sendSms(to: string, text: string): Promise<SmsSendResult> {
  switch (activeProvider()) {
    case 'twilio':
      return sendViaTwilio(to, text)
    case 'vonage':
      return sendViaVonage(to, text)
    case 'http':
      return sendViaHttpGateway(to, text)
    default:
      return { ok: false, error: 'provider_not_configured' }
  }
}
