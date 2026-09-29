import type { Issue } from './types';

const DAY = 86_400_000;

/** UTC calendar dates only, with invalid/missing dates kept out of the arithmetic. */
function dayOf(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  // Validate the written calendar date before converting an offset timestamp to UTC.
  const calendar = value.slice(0, 10);
  const calendarTime = Date.parse(calendar);
  if (!Number.isFinite(calendarTime) || new Date(calendarTime).toISOString().slice(0, 10) !== calendar) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const day = Math.floor(time / DAY);
  return day;
}

/**
 * Reconstruct from current files and their latest closure, not file modification times.
 * Earlier close/reopen cycles are not recorded. Undated closures produce a range for
 * historical open counts; today's count is the exact current queue.
 */
export function issueVelocity(issues: Array<Pick<Issue, 'status' | 'created'> & { closedAt?: string | null }>, now = new Date()) {
  const today = Math.floor(now.getTime() / DAY);
  const records = issues.map((issue) => {
    const created = dayOf(issue.created);
    const closed = issue.status === 'done' ? dayOf(issue.closedAt) : null;
    return {
      done: issue.status === 'done',
      created: created !== null && created <= today ? created : null,
      closed: closed !== null && (created === null || closed >= created) && closed <= today ? closed : null,
    };
  });
  const days = Array.from({ length: 30 }, (_, index) => {
    const day = today - 29 + index;
    const filed = records.filter((r) => r.created === day).length;
    const closed = records.filter((r) => r.closed === day).length;
    const eligible = records.filter((r) => r.created !== null && r.created <= day);
    const knownOpen = eligible.filter((r) => !r.done || (r.closed !== null && r.closed > day)).length;
    const uncertain = eligible.filter((r) => r.done && r.closed === null).length
      + records.filter((r) => r.created === null && (!r.done || r.closed === null || r.closed > day)).length;
    const openNow = records.filter((r) => !r.done).length;
    return {
      date: new Date(day * DAY).toISOString().slice(0, 10), filed, closed,
      openMin: day === today ? openNow : knownOpen,
      openMax: day === today ? openNow : knownOpen + uncertain,
    };
  });
  return {
    days,
    filed: days.reduce((sum, day) => sum + day.filed, 0),
    closed: days.reduce((sum, day) => sum + day.closed, 0),
    open: records.filter((r) => !r.done).length,
    undatedClosures: records.filter((r) => r.done && r.closed === null).length,
    undatedFiled: records.filter((r) => r.created === null).length,
  };
}
