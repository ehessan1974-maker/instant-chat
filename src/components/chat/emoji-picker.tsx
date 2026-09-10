'use client';

import { useEffect, useRef } from 'react';

/** شبكة إيموجي بسيطة (48 إيموجي شائع) تُدرج في حقل الإدخال */
const EMOJIS: readonly string[] = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
  '😊', '😇', '🙂', '😉', '😍', '😘', '😜', '🤪',
  '🤔', '🤗', '🤭', '🤫', '😎', '😴', '🙄', '😏',
  '😢', '😭', '😤', '😡', '🥳', '🤦', '🤷', '🙈',
  '🙌', '👍', '👎', '👏', '🙏', '💪', '🤝', '✌️',
  '❤️', '💔', '✨', '🔥', '🎉', '🎂', '🌹', '☕',
];

interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onPick, onClose }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Element | null;
      if (!target) return;
      // تجاهل النقر على زر التبديل نفسه حتى لا يُغلق ويُفتح فوراً
      if (target.closest('[data-emoji-toggle]')) return;
      if (ref.current && !ref.current.contains(target)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="اختيار إيموجي"
      className="absolute bottom-full start-0 z-20 mb-2 w-[300px] max-w-[calc(100vw-24px)] rounded-2xl border border-black/10 bg-white p-2 shadow-xl"
    >
      <div className="grid grid-cols-8" dir="ltr">
        {EMOJIS.map((emoji, i) => (
          <button
            key={`${emoji}-${i}`}
            type="button"
            onClick={() => onPick(emoji)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-xl transition-colors hover:bg-black/5 active:bg-black/10"
            aria-label={`إدراج ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
