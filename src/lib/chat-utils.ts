// أدوات مشتركة للوقت والنصوص في واجهة المحادثة (تعتمد التوقيت المحلي للجهاز)

export function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** عدد الأيام بين التاريخ المحدد واليوم (0 = اليوم، 1 = أمس) */
export function dayDiff(iso: string): number {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 0;
  const today = startOfDay(new Date());
  return Math.round((today - startOfDay(d)) / 86_400_000);
}

/** تسمية اليوم للمقسمات: اليوم / أمس / dd/mm/yyyy */
export function dayLabel(iso: string): string {
  const diff = dayDiff(iso);
  if (diff === 0) return 'اليوم';
  if (diff === 1) return 'أمس';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** طابع قصير لقائمة المحادثات: اليوم HH:MM | أمس | dd/mm/yyyy */
export function shortStamp(iso: string): string {
  const diff = dayDiff(iso);
  if (diff === 0) return formatTime(iso);
  if (diff === 1) return 'أمس';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** سطر "آخر ظهور" لرأس المحادثة */
export function lastSeenLabel(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const diff = dayDiff(iso);
  const t = formatTime(iso);
  if (diff === 0) return `آخر ظهور اليوم ${t}`;
  if (diff === 1) return `آخر ظهور أمس ${t}`;
  return `آخر ظهور ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function ts(iso?: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}

/** معرّف عميل للإرسال المتفائل (مع بديل إن لم يتوفر crypto.randomUUID) */
export function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
