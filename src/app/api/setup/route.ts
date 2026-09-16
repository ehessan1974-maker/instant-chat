// معالج تفعيل الخادم — يجعل الدخول الحقيقياً بلا متغيرات بيئة ولا إعادة نشر:
//
// GET  /api/setup  → حالة التهيئة الحالية (بلا أي أسرار)
// POST /api/setup  { botToken } → يتحقق من ملكية البوت عبر getMe، يحفظ التوكن
//                    في قاعدة البيانات، ويفعّل بوابة SMS (relay) مع رمز سري.
//
// الأمان:
//  - إثبات الملكية = امتلاك توكن بوت صالح (من @BotFather) ويوزر البوت ضمن
//    قائمة مسموحة (بوت المالك افتراضياً) — لا يمكن لغريب تفعيل خادمك.
//  - حد محاولات 10/ساعة لكل IP يمنع تخمين التوكنات.
//  - توكن بوابة SMS لا يُعرض إلا لمن نجح في التفعيل، ويستعمله هاتف المالك فقط.

import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { SETTING_KEYS, getSetting, setSetting } from '@/lib/settings'
import {
  isBotPollingActive,
  resolveTelegramToken,
  setCachedBotUsername,
  startBotPolling,
} from '@/lib/telegram'
import { isProviderConfigured, resolveSmsProvider } from '@/lib/sms'

const TG_API = 'https://api.telegram.org/bot'

// بوتات يُسمح لها بتفعيل الخادم — يوسَّع بمتغير SETUP_EXTRA_BOTS="bot1,bot2"
const ALLOWED_BOTS = (process.env.SETUP_EXTRA_BOTS || 'instant_chat_otp_bot')
  .split(',')
  .map((u) => u.trim().replace(/^@/, '').toLowerCase())
  .filter(Boolean)

// حد محاولات التفعيل: 10/ساعة لكل IP
const attempts = new Map<string, { bucket: number; count: number }>()
const HOUR_MS = 3_600_000

function limited(ip: string): boolean {
  const bucket = Math.floor(Date.now() / HOUR_MS)
  const entry = attempts.get(ip)
  if (!entry || entry.bucket !== bucket) {
    attempts.set(ip, { bucket, count: 1 })
    return false
  }
  entry.count += 1
  return entry.count > 10
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  return (fwd ? fwd.split(',')[0] : '').trim() || 'local'
}

interface TgMeResponse {
  ok?: boolean
  result?: { username?: string }
  description?: string
}

/** GET — حالة التهيئة (عامة، بلا أسرار) */
export async function GET() {
  const [telegramToken, provider] = await Promise.all([
    resolveTelegramToken(),
    resolveSmsProvider(),
  ])
  const smsActive = isProviderConfigured(provider) ? provider : null
  return NextResponse.json({
    configured: Boolean(telegramToken),
    telegram: Boolean(telegramToken),
    smsProvider: smsActive,
    relayEnabled: smsActive === 'relay',
  })
}

/** POST — تفعيل الدخول الحقيقي: توكن بوت صالح من صاحبه */
export async function POST(req: Request) {
  if (limited(clientIp(req))) {
    return NextResponse.json({ error: 'SETUP_RATE_LIMITED' }, { status: 429 })
  }

  const body = (await req.json().catch(() => null)) as { botToken?: unknown } | null
  const botToken = typeof body?.botToken === 'string' ? body.botToken.trim() : ''
  if (!botToken) {
    return NextResponse.json({ error: 'TOKEN_REQUIRED' }, { status: 400 })
  }
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    return NextResponse.json({ error: 'TOKEN_INVALID_FORMAT' }, { status: 400 })
  }

  // التحقق الحقيقي من ملكية البوت: توكن صالح + يوزر ضمن القائمة المسموحة
  let username = ''
  try {
    const res = await fetch(`${TG_API}${botToken}/getMe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json().catch(() => null)) as TgMeResponse | null
    if (!data?.ok || !data.result?.username) {
      return NextResponse.json({ error: 'BOT_INVALID' }, { status: 400 })
    }
    username = data.result.username.toLowerCase()
  } catch {
    return NextResponse.json({ error: 'TELEGRAM_UNREACHABLE' }, { status: 502 })
  }

  if (!ALLOWED_BOTS.includes(username)) {
    return NextResponse.json({ error: 'BOT_NOT_ALLOWED' }, { status: 403 })
  }

  // حفظ تهيئة تيليجرام — تعمل فوراً بلا إعادة نشر
  await setSetting(SETTING_KEYS.telegramBotToken, botToken)
  await setSetting(SETTING_KEYS.telegramBotUsername, username)
  setCachedBotUsername(username)

  // بوابة SMS عبر موبايل المالك (relay) — تفعيل + رمز سري ثابت يُعاد استعماله
  const existingRelay = await getSetting(SETTING_KEYS.smsRelayToken)
  const relayToken = existingRelay || randomBytes(24).toString('hex')
  await setSetting(SETTING_KEYS.smsRelayToken, relayToken)
  await setSetting(SETTING_KEYS.smsProvider, 'relay')

  // بدء بولينج البوت داخل نفس العملية إن لم يكن يعمل
  if (!isBotPollingActive()) {
    void startBotPolling().catch(() => undefined)
  }

  // أمر جاهز للنسخ — يشغّل بوابة الإرسال من Termux على موبايل المالك
  const command = [
    'pkg install -y termux-api jq curl',
    'curl -sL https://raw.githubusercontent.com/ehessan1974-maker/instant-chat/main/public/relay-sms.sh -o relay.sh',
    'chmod +x relay.sh',
    `SMS_RELAY_TOKEN='${relayToken}' bash relay.sh`,
  ].join(' && ')

  return NextResponse.json({
    ok: true,
    botUsername: username,
    relayEnabled: true,
    relayToken,
    command,
  })
}
