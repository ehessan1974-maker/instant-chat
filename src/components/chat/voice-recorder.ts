'use client';

// hook تسجيل الرسائل الصوتية — MediaRecorder مع مؤقت ثوانٍ وحد أقصى 180 ثانية.
// start(): يطلب إذن الميكروفون ويبدأ التسجيل — stop(): يوقف ويرسل النتيجة عبر onFinished
// — cancel(): يوقف ويرمي النتيجة. التنظيف الكامل (مسارات + مؤقتات) عند unmount.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface VoiceRecordingResult {
  blob: Blob;
  durationMs: number;
  mime: string;
}

export interface VoiceRecorderState {
  recording: boolean;
  /** عدّاد ثوانٍ أثناء التسجيل */
  seconds: number;
  /** رسالة عربية للخطأ (منع الميكروفون، عدم الدعم...) */
  error: string | null;
  start: () => Promise<void>;
  /** إيقاف وإرجاع النتيجة عبر onFinished */
  stop: () => void;
  /** إيقاف وإهمال النتيجة */
  cancel: () => void;
}

/** الحد الأقصى لمدة التسجيل بالثواني */
const MAX_SECONDS = 180;

/** ترتيب الصيغ المفضلة — يُختار أول mime مدعوم فعلاً في المتصفح */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // متصفح لا يدعم isTypeSupported — نجرب التالي
    }
  }
  return '';
}

export function useVoiceRecorder(onFinished: (r: VoiceRecordingResult) => void): VoiceRecorderState {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  // أحدث نسخة من callback داخل المستمعات (تفادي الإغلاق القديم)
  const onFinishedRef = useRef(onFinished);

  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  const clearTimer = useCallback((): void => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** إيقاف المسارات وتنظيف كل الموارد (يُستدعى في onstop وعند الأخطاء وعند unmount) */
  const releaseAll = useCallback((): void => {
    clearTimer();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    recorderRef.current = null;
    chunksRef.current = [];
  }, [clearTimer]);

  const resetState = useCallback((): void => {
    setRecording(false);
    setSeconds(0);
  }, []);

  const stop = useCallback((): void => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') return;
    cancelledRef.current = false; // النتيجة مطلوبة → تُسلَّم عبر onFinished
    try {
      rec.stop();
    } catch {
      releaseAll();
      resetState();
    }
  }, [releaseAll, resetState]);

  const cancel = useCallback((): void => {
    cancelledRef.current = true; // إهمال النتيجة
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') {
      releaseAll();
      resetState();
      return;
    }
    try {
      rec.stop();
    } catch {
      releaseAll();
      resetState();
    }
  }, [releaseAll, resetState]);

  const start = useCallback(async (): Promise<void> => {
    // منع بدء تسجيل ثانٍ أثناء التسجيل
    if (recorderRef.current || streamRef.current) return;

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      setError('التسجيل الصوتي غير مدعوم في هذا المتصفح');
      return;
    }

    setError(null);
    cancelledRef.current = false;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('تعذر الوصول للميكروفون — تأكد من منح الإذن للمتصفح');
      return;
    }

    streamRef.current = stream;

    let recorder: MediaRecorder;
    const mime = pickMime();
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      releaseAll();
      setError('تعذر بدء التسجيل — صيغة الصوت غير مدعومة في هذا المتصفح');
      return;
    }

    chunksRef.current = [];
    const usedMime = recorder.mimeType || mime || 'audio/webm';

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onerror = () => {
      cancelledRef.current = true;
      releaseAll();
      resetState();
      setError('حدث خطأ أثناء التسجيل — حاول من جديد');
    };

    recorder.onstart = () => {
      // قياس المدة الفعلية من اللحظة التي بدأ فيها التسجيل فعلاً
      startedAtRef.current = Date.now();
      setSeconds(0);
      let count = 0;
      clearTimer();
      timerRef.current = setInterval(() => {
        count += 1;
        setSeconds(count);
        // حد أقصى 180 ثانية: إيقاف تلقائي مع إرسال النتيجة
        if (count >= MAX_SECONDS) stop();
      }, 1000);
    };

    recorder.onstop = () => {
      const wasCancelled = cancelledRef.current;
      const durationMs = startedAtRef.current > 0 ? Math.max(0, Date.now() - startedAtRef.current) : 0;
      const blob = new Blob(chunksRef.current, { type: usedMime });
      releaseAll();
      resetState();
      if (!wasCancelled) onFinishedRef.current({ blob, durationMs, mime: usedMime });
    };

    recorderRef.current = recorder;
    startedAtRef.current = 0;
    try {
      recorder.start(100); // جمع chunks كل 100ms لضمان نتيجة كاملة حتى مع الإيقاف السريع
    } catch {
      releaseAll();
      setError('تعذر بدء التسجيل — حاول من جديد');
      return;
    }
    setRecording(true);
  }, [clearTimer, releaseAll, resetState, stop]);

  // تنظيف شامل عند إلغاء التركيب: مؤقتات + مسارات ميكروفون (تطفئ نقطة تبويب الميكروفون)
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      clearTimer();
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          // تجاهل — ننظف يدوياً بعد ذلك مباشرة
        }
      }
      recorderRef.current = null;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      chunksRef.current = [];
    };
  }, [clearTimer]);

  return { recording, seconds, error, start, stop, cancel };
}
