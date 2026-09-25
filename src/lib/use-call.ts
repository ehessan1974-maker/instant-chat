'use client';

// hook إدارة مكالمة WebRTC كاملة (1:1) عبر إشارات السوكيت (chat-service :3003).
// العقد مطابق لـ CONTRACT v2 — قسم "مكالمات 1:1" في worklog.md:
//   المتصل: getUserMedia ← call_invite(ack) ← call_accepted ← PC+offer(call_offer) ← call_answer
//   المستقبل: call_incoming ← (getUserMedia) call_accept ← call_offer ← PC+answer(call_answer)
//   الطرفان: call_ice (مع اصطفاف candidates حتى تجهز remoteDescription)
//   الإنهاء: call_end/call_ended · call_cancel/call_cancelled · call_reject/call_rejected
// القاعدة الذهبية: أي حدث إنهاء بمعرّف callId يطابق الحالي ← تنظيف كامل فوري + note قصيرة ثم idle.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

export type CallState = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';

export interface CallPeer {
  id: string;
  name: string;
  avatarColor: string;
}

export interface CallInfo {
  callId: string | null;
  peer: CallPeer | null;
  kind: 'audio' | 'video';
  state: CallState;
  /** رسالة قصيرة (مرفوض/انتهت/خطأ) تُعرض ثم تعود idle */
  note: string | null;
}

export interface UseCallResult {
  call: CallInfo;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  elapsedSeconds: number;
  startCall: (peerId: string, peer: CallPeer, kind: 'audio' | 'video') => Promise<void>;
  acceptCall: () => Promise<void>;
  rejectCall: () => void;
  hangUp: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
}

const ICE_SERVERS: RTCIceServer[] = [
  {
    urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
  },
];

/** مدة بقاء رسالة النهاية قبل العودة إلى idle */
const IDLE_DELAY_MS = 2000;
/** مدة بقاء رسالة الخطأ قبل العودة إلى idle */
const ERROR_IDLE_DELAY_MS = 2500;

const IDLE_CALL: CallInfo = { callId: null, peer: null, kind: 'audio', state: 'idle', note: null };

type AckError = string | undefined;

function translateAckError(code: AckError): string {
  switch (code) {
    case 'OFFLINE':
      return 'الطرف الآخر غير متصل الآن';
    case 'BUSY':
      return 'في مكالمة أخرى حالياً';
    case 'IN_CALL':
      return 'أنت في مكالمة بالفعل';
    case 'UNAVAILABLE':
      return 'غير متاح للاتصال';
    case 'BAD_TARGET':
      return 'لا يمكن الاتصال بهذا المستخدم';
    case 'UNAUTHORIZED':
      return 'انتهت الجلسة — حدّث الصفحة';
    default:
      return 'تعذر بدء المكالمة';
  }
}

interface IncomingPayload {
  callId?: string;
  from?: Partial<CallPeer>;
  kind?: string;
}

interface SdpPayload {
  callId?: string;
  sdp?: string;
}

interface IcePayload {
  callId?: string;
  candidate?: RTCIceCandidateInit | null;
}

interface EndPayload {
  callId?: string;
  reason?: string;
}

interface InviteAck {
  ok?: boolean;
  callId?: string;
  error?: AckError;
}

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** الحصول على وسائط الميكروفون/الكاميرا حسب نوع المكالمة */
async function acquireMedia(kind: 'audio' | 'video'): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: kind === 'video' ? { facingMode: 'user' } : false,
  });
}

function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      /* تجاهل */
    }
  });
}

export function useCall(me: { id: string } | null, socket: Socket | null): UseCallResult {
  const [call, setCallState] = useState<CallInfo>(IDLE_CALL);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // مراجع حية داخل المستمعات والمؤقتات (تفادي الإغلاق القديم)
  const callRef = useRef<CallInfo>(IDLE_CALL);
  /** معرّف المكالمة الجارية — يُفرَّغ فور أي إنهاء لتجاهل الأحداث اللاحقة بنفس المعرّف */
  const activeCallIdRef = useRef<string | null>(null);
  const roleRef = useRef<'caller' | 'callee' | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const socketRef = useRef<Socket | null>(socket);
  const mutedRef = useRef(false);
  const cameraOffRef = useRef(false);
  const startingRef = useRef(false); // منع النقر المزدوج على بدء المكالمة
  const acceptingRef = useRef(false); // منع النقر المزدوج على القبول
  const activatedRef = useRef(false); // هل بدأ عداد المدة
  const startTsRef = useRef(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringtoneRef = useRef<{ ctx: AudioContext; interval: ReturnType<typeof setInterval> } | null>(null);

  // تحديث حالة المكالمة + المرجع الحي معاً (يُستدعى من الأحداث فقط، ليس أثناء الرندر)
  const setCall = useCallback((next: CallInfo | ((prev: CallInfo) => CallInfo)) => {
    const value = typeof next === 'function' ? next(callRef.current) : next;
    callRef.current = value;
    setCallState(value);
  }, []);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  /* ------------------------- نغمة الرنين (WebAudio) ------------------------- */

  const stopRingtone = useCallback(() => {
    const r = ringtoneRef.current;
    if (!r) return;
    ringtoneRef.current = null;
    try {
      clearInterval(r.interval);
    } catch {
      /* تجاهل */
    }
    try {
      void r.ctx.close();
    } catch {
      /* تجاهل */
    }
  }, []);

  const startRingtone = useCallback(() => {
    if (ringtoneRef.current) return;
    try {
      // إنشاء AudioContext عند أول تسجيل (قد يُحجب قبل تفاعل المستخدم — مقبول)
      const AC = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      void ctx.resume().catch(() => {
        /* تجاهل — سياسة التشغيل التلقائي */
      });

      const ringOnce = (): void => {
        try {
          // مذبذبان متناوبان 440/480 هرتز — نمط رنين يتكرر كل ثانيتين
          const t0 = ctx.currentTime + 0.05;
          const parts: Array<[number, number]> = [
            [440, 0],
            [480, 0.45],
          ];
          for (const [freq, offset] of parts) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const start = t0 + offset;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.12, start + 0.03);
            gain.gain.setValueAtTime(0.12, start + 0.32);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.45);
          }
        } catch {
          /* تجاهل */
        }
      };

      ringOnce();
      const interval = setInterval(ringOnce, 2000);
      ringtoneRef.current = { ctx, interval };
    } catch {
      /* الصوت ليس حرجاً */
    }
  }, []);

  /* ------------------------- تنظيف الوسائط و PC ------------------------- */

  const stopMediaAndPC = useCallback(() => {
    const pc = pcRef.current;
    if (pc) {
      pcRef.current = null;
      try {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.close();
      } catch {
        /* تجاهل */
      }
    }
    const stream = localStreamRef.current;
    localStreamRef.current = null;
    stopStream(stream);
    pendingIceRef.current = [];
    setRemoteStream(null);
  }, []);

  const resetToIdle = useCallback(() => {
    stopRingtone();
    stopMediaAndPC();
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    activeCallIdRef.current = null;
    roleRef.current = null;
    activatedRef.current = false;
    startTsRef.current = 0;
    startingRef.current = false;
    acceptingRef.current = false;
    mutedRef.current = false;
    cameraOffRef.current = false;
    setLocalStream(null);
    setMuted(false);
    setCameraOff(false);
    setElapsedSeconds(0);
    setCall(IDLE_CALL);
  }, [stopRingtone, stopMediaAndPC, setCall]);

  const scheduleIdle = useCallback(
    (delay: number) => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null;
        resetToIdle();
      }, delay);
    },
    [resetToIdle]
  );

  /** دخول حالة active مرة واحدة: بدء عداد المدة (mm:ss في الواجهة) */
  const activate = useCallback(() => {
    if (activatedRef.current) return;
    activatedRef.current = true;
    setCall((prev) => (prev.state === 'active' ? prev : { ...prev, state: 'active', note: null }));
    startTsRef.current = Date.now();
    setElapsedSeconds(0);
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTsRef.current) / 1000));
    }, 1000);
  }, [setCall]);

  /** تفريغ candidates المرصوصة بعد جهوزية remoteDescription */
  const flushPendingIce = useCallback(() => {
    const pc = pcRef.current;
    const list = pendingIceRef.current;
    pendingIceRef.current = [];
    if (!pc) return;
    for (const candidate of list) {
      pc.addIceCandidate(candidate).catch(() => {
        /* تجاهل — candidate قديم */
      });
    }
  }, []);

  /** إنهاء المكالمة: تنظيف فوري كامل + note قصيرة مرئية ثم idle */
  const applyEnd = useCallback(
    (note: string) => {
      stopRingtone();
      stopMediaAndPC();
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      activeCallIdRef.current = null; // تجاهل أي أحداث لاحقة بنفس المعرّف
      roleRef.current = null;
      activatedRef.current = false;
      startTsRef.current = 0;
      startingRef.current = false;
      acceptingRef.current = false;
      mutedRef.current = false;
      cameraOffRef.current = false;
      setLocalStream(null);
      setMuted(false);
      setCameraOff(false);
      setElapsedSeconds(0);
      // نبقي callId/peer/kind للعرض فقط
      setCall((prev) => ({ ...prev, state: 'ended', note }));
      scheduleIdle(IDLE_DELAY_MS);
    },
    [stopRingtone, stopMediaAndPC, setCall, scheduleIdle]
  );

  /* ------------------------- إنشاء RTCPeerConnection ------------------------- */

  const createPC = useCallback(
    (callId: string): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;
      pendingIceRef.current = [];

      // إضافة مساراتي المحلية إن وجدت
      const stream = localStreamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
      }

      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        try {
          socketRef.current?.emit('call_ice', { callId, candidate: e.candidate.toJSON() });
        } catch {
          /* تجاهل */
        }
      };

      pc.ontrack = (e) => {
        const remote = e.streams[0] ?? new MediaStream([e.track]);
        setRemoteStream(remote);
      };

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'connected') {
          activate();
          return;
        }
        if (st === 'failed' || st === 'closed' || st === 'disconnected') {
          // إبلاغ الطرف الآخر ثم إنهاء محلي فوري
          try {
            socketRef.current?.emit('call_end', { callId });
          } catch {
            /* تجاهل */
          }
          applyEnd('انقطع الاتصال');
        }
      };

      return pc;
    },
    [activate, applyEnd]
  );

  /** المتصل: إنشاء PC + offer وإرسالها بعد قبول الطرف الآخر */
  const beginCallerPC = useCallback(
    async (callId: string) => {
      try {
        const pc = createPC(callId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current?.emit('call_offer', { callId, sdp: pc.localDescription?.sdp ?? offer.sdp });
      } catch {
        try {
          socketRef.current?.emit('call_end', { callId });
        } catch {
          /* تجاهل */
        }
        applyEnd('تعذر إتمام الاتصال');
      }
    },
    [createPC, applyEnd]
  );

  /** المستقبل: PC + setRemoteDescription(offer) + إضافة مساراتي + answer */
  const beginCalleePC = useCallback(
    async (callId: string, sdp: string) => {
      if (!sdp) {
        try {
          socketRef.current?.emit('call_reject', { callId });
        } catch {
          /* تجاهل */
        }
        applyEnd('تعذر إتمام الاتصال');
        return;
      }
      try {
        const pc = createPC(callId);
        await pc.setRemoteDescription({ type: 'offer', sdp });
        flushPendingIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socketRef.current?.emit('call_answer', { callId, sdp: pc.localDescription?.sdp ?? answer.sdp });
        // بدء العداد عند إرسال الرد (يقابله استقبال answer عند المتصل)
        activate();
      } catch {
        try {
          socketRef.current?.emit('call_end', { callId });
        } catch {
          /* تجاهل */
        }
        applyEnd('تعذر إتمام الاتصال');
      }
    },
    [createPC, flushPendingIce, activate, applyEnd]
  );

  /* ------------------------- مستمعو أحداث السوكيت ------------------------- */

  useEffect(() => {
    if (!socket) return;
    socketRef.current = socket;
    const s = socket;
    const myId = me?.id ?? null;

    function onIncoming(payload: IncomingPayload): void {
      const callId = payload?.callId;
      if (!callId) return;
      if (payload.from?.id && payload.from.id === myId) return; // دفاعي
      // أنا في مكالمة (أو رسالة نهاية معروضة) → مشغول: رفض فوري
      if (callRef.current.state !== 'idle') {
        try {
          s.emit('call_reject', { callId });
        } catch {
          /* تجاهل */
        }
        return;
      }
      roleRef.current = 'callee';
      activeCallIdRef.current = callId;
      setCall({
        callId,
        peer: {
          id: payload.from?.id ?? '',
          name: payload.from?.name ?? 'مستخدم',
          avatarColor: payload.from?.avatarColor ?? '#00a884',
        },
        kind: payload.kind === 'video' ? 'video' : 'audio',
        state: 'incoming',
        note: null,
      });
      // اهتزاز مرة واحدة عند وصول المكالمة
      try {
        navigator.vibrate?.([400, 200, 400, 200, 400]);
      } catch {
        /* تجاهل */
      }
      startRingtone();
    }

    function onAccepted(payload: { callId?: string }): void {
      const callId = payload?.callId;
      if (!callId || callId !== activeCallIdRef.current || roleRef.current !== 'caller') return;
      if (callRef.current.state !== 'outgoing') return;
      setCall((prev) => ({ ...prev, state: 'connecting' }));
      void beginCallerPC(callId);
    }

    function onOffer(payload: SdpPayload): void {
      const callId = payload?.callId;
      if (!callId || callId !== activeCallIdRef.current || roleRef.current !== 'callee') return;
      // يجب أن تكون وسائطي جاهزة (قبول ← getUserMedia ← call_accept)
      if (!localStreamRef.current) {
        try {
          s.emit('call_reject', { callId });
        } catch {
          /* تجاهل */
        }
        applyEnd('تعذر الوصول للميكروفون/الكاميرا');
        return;
      }
      void beginCalleePC(callId, payload.sdp ?? '');
    }

    function onAnswer(payload: SdpPayload): void {
      const callId = payload?.callId;
      if (!callId || callId !== activeCallIdRef.current || roleRef.current !== 'caller') return;
      const pc = pcRef.current;
      if (!pc || !payload.sdp) return;
      pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
        .then(() => {
          flushPendingIce();
          activate(); // بدء العداد عند استقبال الرد
        })
        .catch(() => {
          try {
            s.emit('call_end', { callId });
          } catch {
            /* تجاهل */
          }
          applyEnd('تعذر إتمام الاتصال');
        });
    }

    function onIce(payload: IcePayload): void {
      const callId = payload?.callId;
      if (!callId || callId !== activeCallIdRef.current) return;
      const candidate = payload.candidate;
      if (!candidate) return;
      const pc = pcRef.current;
      if (pc && pc.remoteDescription) {
        pc.addIceCandidate(candidate).catch(() => {
          /* تجاهل — candidate قديم */
        });
      } else {
        // اصطفاف حتى تجهز remoteDescription ثم التفريغ
        pendingIceRef.current.push(candidate);
      }
    }

    function onEnded(payload: EndPayload): void {
      const callId = payload?.callId;
      if (!callId || callId !== activeCallIdRef.current) return;
      const note =
        payload?.reason === 'no-answer'
          ? 'لا رد — انتهى وقت الرنين'
          : payload?.reason === 'disconnected'
            ? 'انقطع الاتصال'
            : 'انتهت المكالمة';
      applyEnd(note);
    }

    function onCancelled(payload: EndPayload): void {
      const callId = payload?.callId;
      if (!callId || callId !== activeCallIdRef.current) return;
      const note = payload?.reason === 'timeout' ? 'انتهى وقت الرنين' : 'أُلغيت المكالمة';
      applyEnd(note);
    }

    function onRejected(payload: EndPayload): void {
      const callId = payload?.callId;
      if (!callId || callId !== activeCallIdRef.current) return;
      applyEnd('تم رفض المكالمة');
    }

    s.on('call_incoming', onIncoming);
    s.on('call_accepted', onAccepted);
    s.on('call_offer', onOffer);
    s.on('call_answer', onAnswer);
    s.on('call_ice', onIce);
    s.on('call_ended', onEnded);
    s.on('call_cancelled', onCancelled);
    s.on('call_rejected', onRejected);

    return () => {
      s.off('call_incoming', onIncoming);
      s.off('call_accepted', onAccepted);
      s.off('call_offer', onOffer);
      s.off('call_answer', onAnswer);
      s.off('call_ice', onIce);
      s.off('call_ended', onEnded);
      s.off('call_cancelled', onCancelled);
      s.off('call_rejected', onRejected);
    };
  }, [socket, me, startRingtone, setCall, beginCallerPC, beginCalleePC, flushPendingIce, activate, applyEnd]);

  /* ------------------------- أفعال المستخدم ------------------------- */

  const startCall = useCallback(
    async (peerId: string, peer: CallPeer, kind: 'audio' | 'video'): Promise<void> => {
      if (callRef.current.state !== 'idle' || startingRef.current) return;
      if (!peerId || (me && peerId === me.id)) return;
      startingRef.current = true;
      try {
        // getUserMedia يسبق call_invite (شرط الخادم)
        const stream = await acquireMedia(kind);
        startingRef.current = false;
        // قد وصلت مكالمة واردة أثناء انتظار الإذن
        if (callRef.current.state !== 'idle') {
          stopStream(stream);
          return;
        }
        localStreamRef.current = stream;
        setLocalStream(stream);
        mutedRef.current = false;
        cameraOffRef.current = false;
        setMuted(false);
        setCameraOff(false);
      } catch {
        startingRef.current = false;
        setCall({ callId: null, peer, kind, state: 'ended', note: 'تعذر الوصول للميكروفون/الكاميرا' });
        scheduleIdle(ERROR_IDLE_DELAY_MS);
        return;
      }

      const s = socketRef.current;
      if (!s) {
        stopMediaAndPC();
        setLocalStream(null);
        setCall({ callId: null, peer, kind, state: 'ended', note: 'تعذر بدء المكالمة' });
        scheduleIdle(ERROR_IDLE_DELAY_MS);
        return;
      }

      s.emit('call_invite', { to: peerId, kind }, (r?: InviteAck) => {
        if (r?.ok && r.callId) {
          // وصلت مكالمة واردة بين الإرسال والرد؟ لا تُلبس outgoing فوقها
          if (callRef.current.state !== 'idle') {
            stopMediaAndPC();
            setLocalStream(null);
            return;
          }
          roleRef.current = 'caller';
          activeCallIdRef.current = r.callId;
          setCall({ callId: r.callId, peer, kind, state: 'outgoing', note: null });
          return;
        }
        // فشل: إيقاف المسارات + رسالة مترجمة ثم idle
        stopMediaAndPC();
        setLocalStream(null);
        setCall({ callId: null, peer, kind, state: 'ended', note: translateAckError(r?.error) });
        scheduleIdle(ERROR_IDLE_DELAY_MS);
      });
    },
    [me, setCall, scheduleIdle, stopMediaAndPC]
  );

  const acceptCall = useCallback(async (): Promise<void> => {
    const current = callRef.current;
    if (current.state !== 'incoming' || !current.callId || acceptingRef.current) return;
    acceptingRef.current = true;
    const callId = current.callId;
    stopRingtone();
    try {
      // getUserMedia قبل call_accept (شرط الخادم)
      const stream = await acquireMedia(current.kind);
      acceptingRef.current = false;
      // أُلغيت/انتهت المكالمة أثناء انتظار الإذن؟
      if (activeCallIdRef.current !== callId) {
        stopStream(stream);
        return;
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      mutedRef.current = false;
      cameraOffRef.current = false;
      setMuted(false);
      setCameraOff(false);
      setCall((prev) => (prev.callId === callId ? { ...prev, state: 'connecting' } : prev));
      socketRef.current?.emit('call_accept', { callId });
    } catch {
      acceptingRef.current = false;
      // تعذر الإذن → رفض لإبلاغ المتصل فوراً
      try {
        socketRef.current?.emit('call_reject', { callId });
      } catch {
        /* تجاهل */
      }
      applyEnd('تعذر الوصول للميكروفون/الكاميرا');
    }
  }, [stopRingtone, setCall, applyEnd]);

  const rejectCall = useCallback((): void => {
    const current = callRef.current;
    if (current.state !== 'incoming' || !current.callId) return;
    try {
      socketRef.current?.emit('call_reject', { callId: current.callId });
    } catch {
      /* تجاهل */
    }
    resetToIdle();
  }, [resetToIdle]);

  const hangUp = useCallback((): void => {
    const current = callRef.current;
    if (current.state === 'idle' || current.state === 'ended') return;
    const callId = current.callId;
    if (callId) {
      try {
        if (current.state === 'incoming') socketRef.current?.emit('call_reject', { callId });
        else if (current.state === 'outgoing') socketRef.current?.emit('call_cancel', { callId });
        else socketRef.current?.emit('call_end', { callId });
      } catch {
        /* تجاهل */
      }
    }
    applyEnd('انتهت المكالمة');
  }, [applyEnd]);

  const toggleMute = useCallback((): void => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) return;
    const next = !mutedRef.current;
    tracks.forEach((t) => {
      try {
        t.enabled = !next;
      } catch {
        /* تجاهل */
      }
    });
    mutedRef.current = next;
    setMuted(next);
  }, []);

  const toggleCamera = useCallback((): void => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const tracks = stream.getVideoTracks();
    if (tracks.length === 0) return;
    const next = !cameraOffRef.current;
    tracks.forEach((t) => {
      try {
        t.enabled = !next;
      } catch {
        /* تجاهل */
      }
    });
    cameraOffRef.current = next;
    setCameraOff(next);
  }, []);

  /* ------------------------- تنظيف عند إلغاء التركيب ------------------------- */
  useEffect(() => {
    return () => {
      const r = ringtoneRef.current;
      if (r) {
        ringtoneRef.current = null;
        try {
          clearInterval(r.interval);
        } catch {
          /* تجاهل */
        }
        try {
          void r.ctx.close();
        } catch {
          /* تجاهل */
        }
      }
      const pc = pcRef.current;
      if (pc) {
        pcRef.current = null;
        try {
          pc.onicecandidate = null;
          pc.ontrack = null;
          pc.onconnectionstatechange = null;
          pc.close();
        } catch {
          /* تجاهل */
        }
      }
      stopStream(localStreamRef.current);
      localStreamRef.current = null;
      pendingIceRef.current = [];
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  return {
    call,
    localStream,
    remoteStream,
    muted,
    cameraOff,
    elapsedSeconds,
    startCall,
    acceptCall,
    rejectCall,
    hangUp,
    toggleMute,
    toggleCamera,
  };
}
