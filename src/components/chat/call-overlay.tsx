'use client';

// شاشة المكالمة — Overlay ثابت ملء الشاشة بأسلوب واتساب الداكن.
// يعيد null عند state === 'idle'، ويعرض فيديو الطرف الآخر في مكالمات الفيديو
// (أثناء/بعد الاتصال) مع كاميرتي PiP معكوسة، وأفاتار كبير للمكالمات الصوتية
// وقبل الرد، وأزرار قبول/رفض للمكالمة الواردة وأزرار تحكم أثناءها.

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from 'lucide-react';
import { ChatAvatar } from '@/components/chat/avatar';
import type { CallInfo } from '@/lib/use-call';

interface CallOverlayProps {
  call: CallInfo;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  elapsedSeconds: number;
  onAccept: () => void;
  onReject: () => void;
  onHangUp: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
}

/** صيغة mm:ss لمدة المكالمة */
function formatCallTime(total: number): string {
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function CallOverlay({
  call,
  localStream,
  remoteStream,
  muted,
  cameraOff,
  elapsedSeconds,
  onAccept,
  onReject,
  onHangUp,
  onToggleMute,
  onToggleCamera,
}: CallOverlayProps) {
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  // ربط تدفق الطرف الآخر بعنصر العرض المناسب (فيديو في مكالمات الفيديو، صوت خفي في الصوتية)
  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;
  }, [remoteStream, call.state, call.kind]);

  // ربط كاميرتي بعنصر PiP عند ظهوره
  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream, call.state]);

  if (call.state === 'idle') return null;

  const peer = call.peer;
  const peerName = peer?.name || 'مستخدم';
  const isIncoming = call.state === 'incoming';
  const isEnded = call.state === 'ended';
  // فيديو الطرف الآخر: مكالمات فيديو فقط أثناء الاتصال أو بعده
  const showRemoteVideo =
    call.kind === 'video' && (call.state === 'active' || call.state === 'connecting');
  // كاميرتي: متوفرة بعد الحصول على الإذن (للمتصل منذ الرنين وللمستقبل بعد القبول)
  const showLocalPiP =
    call.kind === 'video' &&
    !!localStream &&
    (call.state === 'outgoing' || call.state === 'connecting' || call.state === 'active');

  const statusText = (() => {
    switch (call.state) {
      case 'incoming':
        return `مكالمة ${call.kind === 'video' ? 'فيديو' : 'صوتية'} واردة`;
      case 'outgoing':
      case 'connecting':
        return 'جاري الاتصال...';
      case 'active':
        return formatCallTime(elapsedSeconds);
      case 'ended':
        return call.note || 'انتهت المكالمة';
      default:
        return '';
    }
  })();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label={`مكالمة مع ${peerName}`}
      className="fixed inset-0 z-[100] flex flex-col bg-gradient-to-b from-[#0b141a] to-[#1f2c34] text-white"
    >
      {/* فيديو الطرف الآخر — ملء الشاشة (مكالمات الفيديو أثناء/بعد الاتصال) */}
      {showRemoteVideo && (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          aria-label={`فيديو ${peerName}`}
          className="absolute inset-0 h-full w-full bg-black object-contain"
        />
      )}

      {/* صوت الطرف الآخر (مكالمات صوتية أو قبل جهوزية الفيديو) */}
      {!showRemoteVideo && <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />}

      {/* كاميرتي — PiP صغيرة أعلى اليسار معكوسة كالمرآة */}
      {showLocalPiP && (
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          aria-label="كاميرتي"
          className="absolute left-4 top-4 z-20 w-28 -scale-x-100 rounded-xl border border-white/20 bg-black/60 shadow-lg"
        />
      )}

      {/* منطقة المعلومات */}
      {showRemoteVideo ? (
        <div className="relative z-10 flex items-center gap-3 px-4 pt-[max(1.25rem,env(safe-area-inset-top))]">
          <ChatAvatar name={peerName} color={peer?.avatarColor} size={40} />
          <div className="min-w-0">
            <div className="truncate text-base font-bold">{peerName}</div>
            <div
              className="text-sm text-white/75"
              aria-live="polite"
              dir={call.state === 'active' ? 'ltr' : undefined}
            >
              {statusText}
            </div>
          </div>
        </div>
      ) : (
        <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
          <div className="relative">
            {call.state === 'outgoing' && (
              <span
                aria-hidden="true"
                className="absolute inset-0 -m-2.5 animate-pulse rounded-full border-2 border-[#25d366]/60"
              />
            )}
            <ChatAvatar name={peerName} color={peer?.avatarColor} size={120} />
          </div>
          <div>
            <div className="text-2xl font-bold">{peerName}</div>
            <div
              className="mt-1.5 text-sm text-white/75 sm:text-base"
              aria-live="polite"
              dir={call.state === 'active' ? 'ltr' : undefined}
            >
              {statusText}
            </div>
          </div>
        </div>
      )}

      {/* فاصل مرن فوق الأزرار عندما يظهر فيديو الطرف الآخر */}
      {showRemoteVideo && <div className="relative z-10 flex-1" aria-hidden="true" />}

      {/* منطقة الأزرار */}
      <div className="relative z-10 flex items-center justify-center pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4">
        {isIncoming ? (
          // مكالمة واردة: رفض أحمر + قبول أخضر (≥64px)
          <div className="flex items-center gap-14 px-8">
            <button
              type="button"
              onClick={onReject}
              aria-label="رفض المكالمة"
              className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-[#ef4444] text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
            >
              <PhoneOff className="h-8 w-8" />
            </button>
            <button
              type="button"
              onClick={onAccept}
              aria-label={call.kind === 'video' ? 'قبول مكالمة الفيديو' : 'قبول المكالمة الصوتية'}
              className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-[#25d366] text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
            >
              {call.kind === 'video' ? <Video className="h-8 w-8" /> : <Phone className="h-8 w-8" />}
            </button>
          </div>
        ) : isEnded ? (
          // انتهت المكالمة: لا أزرار — الرسالة تظهر ثم تعود idle
          <div className="h-14" aria-hidden="true" />
        ) : (
          // أثناء المكالمة: كتم + كاميرا (فيديو فقط) + إنهاء
          <div className="flex items-center gap-5 px-6">
            <button
              type="button"
              onClick={onToggleMute}
              aria-label={muted ? 'إلغاء كتم الصوت' : 'كتم الصوت'}
              aria-pressed={muted}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-sm transition-colors hover:bg-white/25 active:scale-95"
            >
              {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
            </button>
            {call.kind === 'video' && (
              <button
                type="button"
                onClick={onToggleCamera}
                aria-label={cameraOff ? 'تشغيل الكاميرا' : 'إيقاف الكاميرا'}
                aria-pressed={cameraOff}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-sm transition-colors hover:bg-white/25 active:scale-95"
              >
                {cameraOff ? <VideoOff className="h-6 w-6" /> : <Video className="h-6 w-6" />}
              </button>
            )}
            <button
              type="button"
              onClick={onHangUp}
              aria-label="إنهاء المكالمة"
              className="flex h-14 w-14 items-center justify-center rounded-full bg-[#ef4444] text-white shadow-lg transition-colors hover:bg-[#dc2626] active:scale-95"
            >
              <PhoneOff className="h-6 w-6" />
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
