/** Local Monday key; half-hour timezones and DST are handled by Intl. */
export function digestWeek(timezone: string, now: Date): string | null {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  if (get('weekday') !== 'Mon' || Number(get('hour')) < 9) return null;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function nextDigest(timezone: string, now: Date): string {
  const cursor = new Date(Math.ceil(now.getTime() / 3600000) * 3600000);
  for (let i = 0; i < 8 * 24; i++) {
    if (digestWeek(timezone, cursor)) return cursor.toISOString();
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  throw new Error('Could not schedule digest.');
}
