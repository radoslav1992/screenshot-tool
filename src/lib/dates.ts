/**
 * One way to show a stored timestamp. Rows keep ISO-8601 UTC strings; screens
 * show them as "2 Oct 2026, 16:00 UTC" so nobody reads `2026-10-02T16:00:03.412Z`.
 * Times stay in UTC because quotas, schedules and digests are all UTC.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const day = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const time = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

function parse(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "2 Oct 2026" — or the fallback when the value is missing or unparseable. */
export function formatDate(value: string | number | Date | null | undefined, fallback = '—'): string {
  const date = parse(value);
  return date ? day(date) : fallback;
}

/** "2 Oct 2026, 16:00 UTC" — or the fallback when the value is missing or unparseable. */
export function formatDateTime(value: string | number | Date | null | undefined, fallback = '—'): string {
  const date = parse(value);
  return date ? `${day(date)}, ${time(date)} UTC` : fallback;
}
