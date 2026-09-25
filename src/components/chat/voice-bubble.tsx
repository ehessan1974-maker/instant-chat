'use client';

// فقاعة الرسالة الصوتية — زر تشغيل/إيقاف + شريط تقدم رفيع + المدة النصية m:ss.
// تُعرض داخل فقاعة الرسائل في chat-view مكان نص الرسالة.
// كل فقاعة تدير تشغيلها محلياً (عدد الرسائل المعروضة ≤100) وتوقف الصوت عند unmount.

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Pause, Play } from 'lucide-react';
import type { MsgStatus } from '@/lib/chat-api';

interface VoiceBubbleProps {
  /** رابط الملف الصوتي (رابط الخادم أو blob محلي للفقاعة المتفائلة) */
  url: string;
  /** المدة بالمللي ثانية — إن كانت null تُعرض 0:00 حتى first metadata */
  durationMs: number | null;
  /** true لفقاعة المرسل (خلفية خضراء للزر) */
  mine: boolean;
  /** حالة الرسالة — تُستخدم لتعتيم الفقاعة غير المرسلة بعد */
  status?: MsgStatus;
}

/** تنسيق المدة بالمللي ثانية إلى m:ss */
function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function VoiceBubble({ url, durationMs, mine, status }: VoiceBubbleProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // أحدث نسخة من durationMs داخل مستمعي الصوت (تفادي الإغلاق القديم)
  const durationMsRef = useRef(durationMs);
  const [playing, setPlaying] = useState(false);
  /** تقدم التشغيل 0..1 */
  const [progress, setProgress] = useState(0);
  /** المدة من metadata (تُستخدم فقط حين durationMs === null) */
  const [metaMs, setMetaMs] = useState<number | null>(null);
  const [error, setError] = useState(false);
  // تتبع الرابط السابق لإعادة ضبط الحالة عند تغيّره (النمط الرسمي أثناء الرندر)
  const [prevUrl, setPrevUrl] = useState(url);

  if (prevUrl !== url) {
    setPrevUrl(url);
    setPlaying(false);
    setProgress(0);
    setError(false);
    setMetaMs(null);
  }

  // تحديث ref المدة خارج الـ render (تُستخدم داخل مستمعي الصوت فقط)
  useEffect(() => {
    durationMsRef.current = durationMs;
  }, [durationMs]);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = url;
    audioRef.current = audio;

    // مدة فعالة للتقدم: من ملف الصوت، وإن كانت غير معروفة (webm مسيّر) فمن durationMs
    const effectiveSeconds = (): number => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
      const fallback = durationMsRef.current;
      return fallback && fallback > 0 ? fallback / 1000 : 0;
    };

    const onTimeUpdate = (): void => {
      const d = effectiveSeconds();
      if (d > 0) setProgress(Math.min(1, audio.currentTime / d));
    };
    const onLoadedMetadata = (): void => {
      // تحديث المدة المعروضة إن لم تأتِ من الخادم
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setMetaMs(Math.round(audio.duration * 1000));
      }
    };
    const onEnded = (): void => {
      // عند انتهاء التشغيل ارجع للبداية
      setPlaying(false);
      setProgress(0);
      audio.currentTime = 0;
    };
    const onPlay = (): void => setPlaying(true);
    const onPause = (): void => setPlaying(false);
    const onError = (): void => setError(true);

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('error', onError);

    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('error', onError);
      audio.removeAttribute('src');
      audioRef.current = null;
    };
  }, [url]);

  function toggle(): void {
    const audio = audioRef.current;
    if (!audio || error) return;
    if (playing) {
      audio.pause();
    } else {
      audio.play().catch(() => setError(true));
    }
  }

  const shownMs = durationMs ?? metaMs ?? 0;
  const pending = status === 'pending';

  return (
    <div className={`flex w-44 items-center gap-2 sm:w-56 ${pending ? 'opacity-80' : ''}`}>
      <button
        type="button"
        onClick={toggle}
        disabled={error}
        aria-label={playing ? 'إيقاف الرسالة الصوتية' : 'تشغيل الرسالة الصوتية'}
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full shadow-sm transition-all active:scale-95 disabled:cursor-not-allowed ${
          mine
            ? 'bg-[#00a884] text-white hover:bg-[#017561]'
            : 'bg-[#f0f2f5] text-[#54656f] hover:bg-[#e2e5e9]'
        } ${error ? 'opacity-70' : ''}`}
      >
        {error ? (
          <AlertCircle className="h-5 w-5" aria-hidden="true" />
        ) : playing ? (
          <Pause className="h-5 w-5" aria-hidden="true" />
        ) : (
          <Play className="h-5 w-5 rtl:-scale-x-100" aria-hidden="true" />
        )}
      </button>

      {error ? (
        <span className="truncate text-xs font-medium text-red-600">تعذر تشغيل الصوت</span>
      ) : (
        <>
          <div
            role="progressbar"
            aria-label="تقدم تشغيل الرسالة الصوتية"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className={`h-1.5 min-w-0 flex-1 overflow-hidden rounded-full ${
              mine ? 'bg-[#cfe0cb]' : 'bg-[#e5e7eb]'
            }`}
          >
            <div
              className="h-full rounded-full bg-[#008069] transition-[width] duration-150 ease-linear"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <span
            dir="ltr"
            className="w-9 shrink-0 text-end text-[11px] font-medium leading-none tabular-nums text-[#667781]"
          >
            {formatMs(shownMs)}
          </span>
        </>
      )}
    </div>
  );
}
