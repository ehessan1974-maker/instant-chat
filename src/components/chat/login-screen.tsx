'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2, MessageCircle, Send } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  ApiError,
  requestOtp,
  verifyOtp,
  verifyTelegram,
  fetchOtpStatus,
  setToken,
  storeMe,
  type Me,
} from '@/lib/chat-api';

interface LoginScreenProps {
  onAuthenticated: (me: Me) => void;
}

/** حفظ حالة طلب الرمز — حتى لا تضيع عند العودة من تيليجرام (إعادة تحميل الصفحة) */
const OTP_FLOW_KEY = 'ic_otp_flow';
const OTP_FLOW_TTL_MS = 10 * 60 * 1000; // نفس صلاحية الرمز

interface SavedOtpFlow {
  step: 'phone' | 'code';
  phone: string;
  devCode: string | null;
  smsSent: boolean;
  tgLink: string | null;
  tgDirect: boolean;
  usedChannel: 'telegram' | 'sms';
  link: string | null;
  savedAt: number;
}

function clearFlowStorage(): void {
  try {
    window.sessionStorage.removeItem(OTP_FLOW_KEY);
  } catch {
    /* تجاهل */
  }
}

/** 4 خانات لإدخال رمز التحقق مع تنقّل تلقائي */
function CodeSlots({
  value,
  onChange,
  disabled,
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: 4 }, (_, i) => value[i] ?? '');

  function handleInput(i: number, raw: string) {
    const digit = raw.replace(/\D/g, '').slice(-1);
    if (!digit) return;
    const next = digits.slice();
    next[i] = digit;
    onChange(next.join(''));
    if (i < 3) refs.current[i + 1]?.focus();
  }

  function handleKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = digits.slice();
      if (next[i]) {
        next[i] = '';
        onChange(next.join(''));
      } else if (i > 0) {
        next[i - 1] = '';
        onChange(next.join(''));
        refs.current[i - 1]?.focus();
      }
    }
  }

  return (
    <div dir="ltr" className="flex justify-center gap-2">
      {digits.map((d, i) => (
        <Input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          onChange={(e) => handleInput(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          aria-label={`الرقم ${i + 1} من رمز التحقق`}
          className="h-12 w-12 rounded-xl border-[#00a884]/40 bg-white text-center text-lg font-bold text-[#111b21] shadow-none focus-visible:border-[#00a884] focus-visible:ring-[#00a884]/30"
        />
      ))}
    </div>
  );
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [needName, setNeedName] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [smsSent, setSmsSent] = useState(false);
  const [tgLink, setTgLink] = useState<string | null>(null);
  const [tgDirect, setTgDirect] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [tgApproved, setTgApproved] = useState(false);
  const [usedChannel, setUsedChannel] = useState<'telegram' | 'sms'>('telegram');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (needName) nameRef.current?.focus();
  }, [needName]);

  // استرجاع حالة طلب الرمز عند العودة من تيليجرام (حتى لو أُعيد تحميل الصفحة)
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(OTP_FLOW_KEY);
      if (!raw) return;
      window.sessionStorage.removeItem(OTP_FLOW_KEY); // نستعيده مرة واحدة ثم يُعاد حفظه حياً
      const saved = JSON.parse(raw) as SavedOtpFlow | null;
      if (
        !saved ||
        saved.step !== 'code' ||
        typeof saved.savedAt !== 'number' ||
        Date.now() - saved.savedAt > OTP_FLOW_TTL_MS
      ) {
        return;
      }
      setPhone(saved.phone || '');
      setDevCode(saved.devCode ?? null);
      setSmsSent(Boolean(saved.smsSent));
      setTgLink(saved.tgLink ?? null);
      setTgDirect(Boolean(saved.tgDirect));
      setUsedChannel(saved.usedChannel === 'sms' ? 'sms' : 'telegram');
      setLink(saved.link ?? null);
      setStep('code');
    } catch {
      /* تجاهل */
    }
  }, []);

  // حفظ الحي للحالة ما دمنا في خطوة إدخال الرمز
  useEffect(() => {
    if (step !== 'code') return;
    try {
      const payload: SavedOtpFlow = {
        step,
        phone,
        devCode,
        smsSent,
        tgLink,
        tgDirect,
        usedChannel,
        link,
        savedAt: Date.now(),
      };
      window.sessionStorage.setItem(OTP_FLOW_KEY, JSON.stringify(payload));
    } catch {
      /* تجاهل */
    }
  }, [step, phone, devCode, smsSent, tgLink, tgDirect, usedChannel, link]);

  // استطلاع دوري: هل ضغط المستخدم «تأكيد الدخول» في تيليجرام؟
  useEffect(() => {
    if (step !== 'code' || !link || (!tgLink && !tgDirect) || devCode || tgApproved) return;
    let stopped = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetchOtpStatus(link);
          if (stopped) return;
          if (res.status === 'approved') {
            setTgApproved(true);
          } else if (res.status === 'expired') {
            stopped = true;
            setError('انتهت صلاحية رمز التحقق — ارجع واطلب رمزاً جديداً');
          }
          // pending | delivered → نستمر بالاستطلاع
        } catch {
          /* خطأ شبكة مؤقت — نكمل الاستطلاع */
        }
      })();
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [step, link, tgLink, tgDirect, devCode, tgApproved]);

  // الدخول التلقائي بمجرد تأكيد المستخدم من تيليجرام — بلا كتابة أي رمز
  useEffect(() => {
    if (!tgApproved || !link || needName) return;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await verifyTelegram(link);
        clearFlowStorage();
        setToken(res.token);
        storeMe(res.user);
        onAuthenticated(res.user);
      } catch (e) {
        if (e instanceof ApiError && e.status === 422) {
          const rec = (e.payload ?? {}) as Record<string, unknown>;
          if (rec.error === 'NAME_REQUIRED') {
            setNeedName(true);
            setLoading(false);
            return;
          }
        }
        setError(e instanceof ApiError ? e.message : 'تعذر إكمال تسجيل الدخول، حاول مجدداً');
        setTgApproved(false);
        setLoading(false);
      }
    })();
  }, [tgApproved, link, needName]);

  function normalizePhone(v: string): string {
    return v.replace(/[^\d+]/g, '');
  }

  async function handleSendCode(channelHint?: 'telegram' | 'sms') {
    const p = normalizePhone(phone);
    if (p.replace(/\D/g, '').length < 8) {
      setError('يرجى إدخال رقم هاتف صحيح مع رمز الدولة');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      // إعادة الإرسال تبقى على نفس القناة التي اختارها المستخدم
      const channel = channelHint ?? usedChannel;
      const res = await requestOtp(p, channel);
      const viaTelegram = res.channel === 'telegram' && Boolean(res.linkUrl);
      const directTelegram = res.channel === 'telegram' && !viaTelegram;
      setUsedChannel(viaTelegram || directTelegram ? 'telegram' : 'sms');
      setDevCode(res.code ?? null);
      setTgDirect(directTelegram);
      setLink(res.link ?? null);
      setTgApproved(false);
      setSmsSent(res.delivered === true && !viaTelegram && !directTelegram);
      setTgLink(viaTelegram ? (res.linkUrl ?? null) : null);
      setStep('code');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'تعذر إرسال رمز التحقق، حاول مجدداً');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    // مسار الدخول التلقائي: المستخدم أكد من تيليجرام — بلا كتابة رمز
    if (tgApproved && link) {
      if (needName && !name.trim()) {
        setError('يرجى كتابة اسمك للمتابعة');
        return;
      }
      setError(null);
      setLoading(true);
      try {
        const res = await verifyTelegram(link, needName ? name.trim() : undefined);
        clearFlowStorage();
        setToken(res.token);
        storeMe(res.user);
        onAuthenticated(res.user);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'تعذر إكمال تسجيل الدخول، حاول مجدداً');
      } finally {
        setLoading(false);
      }
      return;
    }

    if (code.length < 4) {
      setError('أدخل رمز التحقق المكوّن من 4 أرقام');
      return;
    }
    if (needName && !name.trim()) {
      setError('يرجى كتابة اسمك للمتابعة');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await verifyOtp(normalizePhone(phone), code, needName ? name.trim() : undefined);
      setToken(res.token);
      storeMe(res.user);
      onAuthenticated(res.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const rec = (e.payload ?? {}) as Record<string, unknown>;
        if (rec.error === 'NAME_REQUIRED') {
          setNeedName(true);
          setError(null);
          return;
        }
      }
      setError(e instanceof ApiError ? e.message : 'رمز التحقق غير صحيح، حاول مجدداً');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-[#075e54] to-[#008069] p-4">
      <div className="w-full max-w-sm">
        {/* الشعار */}
        <div className="mb-6 flex flex-col items-center gap-3">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white/15 shadow-lg backdrop-blur-sm">
            <MessageCircle className="h-10 w-10 text-white" strokeWidth={1.8} />
          </div>
          <h1 className="text-2xl font-extrabold text-white">محادثة فورية</h1>
          <p className="text-sm text-white/80">رسائل مباشرة وخاصة بأسلوب واتساب</p>
        </div>

        {/* البطاقة */}
        <div className="rounded-2xl bg-white p-6 shadow-2xl">
          {step === 'phone' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSendCode();
              }}
              className="flex flex-col gap-4"
            >
              <div className="text-center">
                <h2 className="text-lg font-bold text-[#111b21]">تسجيل الدخول</h2>
                <p className="mt-1 text-sm text-[#667781]">
                  أدخل رقم هاتفك وسنرسل لك رمز تحقق من 4 أرقام
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="phone" className="text-sm font-medium text-[#3b4a54]">
                  رقم الهاتف
                </label>
                <Input
                  id="phone"
                  dir="ltr"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+963 9xx xxx xxx"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={loading}
                  className="h-11 rounded-xl border-black/15 text-left text-base text-[#111b21] placeholder:text-[#8696a0] focus-visible:border-[#00a884] focus-visible:ring-[#00a884]/30"
                />
              </div>

              {error && (
                <p role="alert" className="text-sm font-medium text-red-600">
                  {error}
                </p>
              )}

              <Button
                type="submit"
                disabled={loading}
                className="h-11 rounded-xl bg-[#00a884] text-base font-bold text-white hover:bg-[#017561] disabled:opacity-60"
              >
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : 'إرسال رمز التحقق'}
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setStep('phone');
                    setCode('');
                    setTgLink(null);
                    setTgDirect(false);
                    setLink(null);
                    setTgApproved(false);
                    setUsedChannel('telegram');
                    setError(null);
                    clearFlowStorage();
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-[#008069] hover:bg-black/5"
                  aria-label="تغيير الرقم والرجوع"
                >
                  <ArrowRight className="h-5 w-5" />
                </button>
                <div>
                  <h2 className="text-lg font-bold text-[#111b21]">أدخل رمز التحقق</h2>
                  <p dir="ltr" className="text-right text-xs text-[#667781]">
                    {normalizePhone(phone)}
                  </p>
                </div>
              </div>

              {tgLink ? (
                <div className="flex flex-col gap-2.5 rounded-xl bg-[#e7f6f2] px-3 py-3 text-center">
                  <p className="text-sm font-bold text-[#0a6f53]">إرسال الرمز عبر تيليجرام 📨</p>
                  <a
                    href={tgLink}
                    target="_blank"
                    rel="noreferrer"
                    className="mx-auto flex h-11 w-full max-w-[280px] items-center justify-center gap-2 rounded-xl bg-[#00a884] text-base font-bold text-white transition-colors hover:bg-[#017561]"
                  >
                    <Send className="h-5 w-5" />
                    استلم الرمز عبر تيليجرام
                  </a>
                  <p className="text-xs leading-5 text-[#3b4a54]">
                    اضغط الزر ثم <span className="font-bold">START</span> — ستصلك رسالة فيها الرمز
                    وزر <span className="font-bold">«تأكيد الدخول»</span>: اضغطه ويتم تسجيل دخولك
                    تلقائياً هنا بلا كتابة. <span className="font-bold">مرة واحدة فقط</span> — بعد
                    تصل الرموز فوراً بلا أي زر.
                  </p>
                  {/* بديل لمن لا يملك حساب تيليجرام */}
                  <button
                    type="button"
                    onClick={() => void handleSendCode('sms')}
                    disabled={loading}
                    className="mt-1 text-xs font-medium text-[#008069] underline-offset-4 hover:underline disabled:opacity-50"
                  >
                    لا تملك تيليجرام؟ استلم الرمز برسالة نصية SMS
                  </button>
                </div>
              ) : tgDirect ? (
                <div
                  role="status"
                  className="flex flex-col gap-1 rounded-xl bg-[#e7f6f2] px-3 py-3 text-center"
                >
                  <p className="text-sm font-bold text-[#0a6f53]">
                    أرسلنا رمز الدخول إلى تيليجرام فوراً ✅
                  </p>
                  <p className="text-xs leading-5 text-[#3b4a54]">
                    افتح تيليجرام واضغط <span className="font-bold">«تأكيد الدخول»</span> في رسالة
                    البوت — سيتم تسجيل دخولك تلقائياً هنا بلا كتابة. أو أدخل الرمز يدوياً.
                  </p>
                </div>
              ) : (
                <>
                  {devCode ? (
                    <div
                      role="note"
                      className="rounded-xl bg-[#d9fdd3]/70 px-3 py-2.5 text-center text-sm text-[#0a6f53]"
                    >
                      وضع تجريبي بلا مزود SMS — رمز التجربة:{' '}
                      <code dir="ltr" className="font-mono text-base font-extrabold tracking-widest">
                        {devCode}
                      </code>
                    </div>
                  ) : (
                    smsSent && (
                      <div
                        role="status"
                        className="rounded-xl bg-[#d9fdd3]/70 px-3 py-2.5 text-center text-sm text-[#0a6f53]"
                      >
                        أرسلنا رمز التحقق برسالة نصية SMS إلى{' '}
                        <span dir="ltr" className="font-mono font-bold">
                          {normalizePhone(phone)}
                        </span>
                      </div>
                    )
                  )}
                </>
              )}

              <CodeSlots value={code} onChange={setCode} disabled={loading} autoFocus />

              <button
                type="button"
                onClick={() => void handleSendCode()}
                disabled={loading}
                className="text-xs font-medium text-[#00a884] underline-offset-4 hover:underline disabled:opacity-50"
              >
                لم يصلك الرمز؟ إعادة الإرسال
              </button>

              {needName && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="display-name" className="text-sm font-medium text-[#3b4a54]">
                    اسمك
                  </label>
                  {tgApproved && (
                    <p role="status" className="text-xs font-medium text-[#0a6f53]">
                      تم تأكيد الدخول من تيليجرام ✓ — اكتب اسمك لإكمال أول تسجيل
                    </p>
                  )}
                  <Input
                    id="display-name"
                    ref={nameRef}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={loading}
                    placeholder="اكتب الاسم الذي سيراه الآخرون"
                    maxLength={40}
                    className="h-11 rounded-xl border-black/15 text-base text-[#111b21] placeholder:text-[#8696a0] focus-visible:border-[#00a884] focus-visible:ring-[#00a884]/30"
                  />
                </div>
              )}

              {error && (
                <p role="alert" className="text-sm font-medium text-red-600">
                  {error}
                </p>
              )}

              <Button
                type="button"
                onClick={() => void handleVerify()}
                disabled={loading}
                className="h-11 rounded-xl bg-[#00a884] text-base font-bold text-white hover:bg-[#017561] disabled:opacity-60"
              >
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : 'تحقق ومتابعة'}
              </Button>
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-white/70">
          بالمتابعة أنت توافق على محادثة الآخرين باحترام 🙂
        </p>
      </div>
    </main>
  );
}
