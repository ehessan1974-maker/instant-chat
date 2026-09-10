'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2, MessageCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  ApiError,
  requestOtp,
  verifyOtp,
  setToken,
  storeMe,
  type Me,
} from '@/lib/chat-api';

interface LoginScreenProps {
  onAuthenticated: (me: Me) => void;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (needName) nameRef.current?.focus();
  }, [needName]);

  function normalizePhone(v: string): string {
    return v.replace(/[^\d+]/g, '');
  }

  async function handleSendCode() {
    const p = normalizePhone(phone);
    if (p.replace(/\D/g, '').length < 8) {
      setError('يرجى إدخال رقم هاتف صحيح مع رمز الدولة');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await requestOtp(p);
      setDevCode(res.code ?? null);
      setStep('code');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'تعذر إرسال رمز التحقق، حاول مجدداً');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
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
                    setError(null);
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

              {devCode && (
                <div
                  role="note"
                  className="rounded-xl bg-[#d9fdd3]/70 px-3 py-2.5 text-center text-sm text-[#0a6f53]"
                >
                  وضع تجريبي بلا مزود SMS — رمز التجربة:{' '}
                  <code dir="ltr" className="font-mono text-base font-extrabold tracking-widest">
                    {devCode}
                  </code>
                </div>
              )}

              <CodeSlots value={code} onChange={setCode} disabled={loading} autoFocus />

              {needName && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="display-name" className="text-sm font-medium text-[#3b4a54]">
                    اسمك
                  </label>
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
