'use client';

import { Users } from 'lucide-react';

interface ChatAvatarProps {
  name?: string | null;
  color?: string | null;
  size?: number;
  /** true لعرض أيقونة مجموعة خضراء (الغرفة العامة) */
  group?: boolean;
  className?: string;
}

/** أفاتار دائري موحّد: لون خلفية + الحرف الأول من الاسم */
export function ChatAvatar({ name, color, size = 40, group = false, className = '' }: ChatAvatarProps) {
  if (group) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center rounded-full bg-[#00a884] text-white ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <Users style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2.2} />
      </div>
    );
  }

  const letter = (name ?? '?').trim().charAt(0).toUpperCase() || '?';

  return (
    <div
      className={`flex shrink-0 select-none items-center justify-center rounded-full font-bold text-white ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: color || '#00a884',
        fontSize: Math.round(size * 0.42),
      }}
      aria-hidden="true"
    >
      {letter}
    </div>
  );
}
