'use client';

// نغمات WebAudio قصيرة — تطابق التطبيق الأصلي:
// رسالة واردة: نغمتان 880Hz ثم 1100Hz | إرسال: نقرة خفيفة.
// يُنشأ AudioContext عند أول تفاعل مستخدم فقط (سياسات المتصفح).

let ctx: AudioContext | null = null;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

export function ensureAudio(): void {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
  } catch {
    // تجاهل — الصوت ليس حرجاً
  }
}

function tone(
  freq: number,
  startDelay: number,
  duration: number,
  gainValue: number,
  type: OscillatorType = 'sine'
): void {
  if (!ctx) return;
  const t0 = ctx.currentTime + startDelay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(gainValue, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

/** نغمة رسالة واردة: 880Hz ثم 1100Hz (كما في التطبيق الأصلي) */
export function playIncoming(): void {
  try {
    ensureAudio();
    tone(880, 0, 0.14, 0.16);
    tone(1100, 0.18, 0.2, 0.16);
  } catch {
    // تجاهل
  }
}

/** نقرة إرسال خفيفة */
export function playSent(): void {
  try {
    ensureAudio();
    tone(660, 0, 0.06, 0.05, 'triangle');
  } catch {
    // تجاهل
  }
}
