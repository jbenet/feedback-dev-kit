/**
 * Dates, the same on the server and in every browser: no locale-dependent formatting, so a
 * server-rendered list hydrates in Safari exactly as it was sent.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (v: number) => String(v).padStart(2, '0');

/** "23 Sep" or "23 Sep 2026". */
export function shortDate(value: Date | string | number, withYear = false): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
}

/** "14:05" today, "23 Sep 14:05" before. */
export function savedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${shortDate(d)} ${time}`;
}

/** "just now", "5 min ago", "3 h ago", "4 d ago", then a date. */
export function ago(value: Date | string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const s = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} d ago`;
  return shortDate(date);
}
