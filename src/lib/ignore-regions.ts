import { badRequest } from './http';
export interface IgnoreRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Page coordinates in CSS pixels: x,y,width,height; x,y,width,height. */
export function parseIgnoreRegions(raw: string | undefined): IgnoreRegion[] {
  if (!raw?.trim()) return [];
  const entries = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length > 10) throw badRequest('Use at most ten ignore regions.');
  return entries.map((entry) => {
    const parts = entry.split(',').map((s) => s.trim());
    const values = parts.map(Number);
    if (
      parts.length !== 4 ||
      parts.some((s) => !/^\d+$/.test(s)) ||
      values.some((v) => !Number.isSafeInteger(v) || v > 20000) ||
      values[2] <= 0 ||
      values[3] <= 0
    )
      throw badRequest(
        'Each region must be x,y,width,height in whole CSS pixels (0–20000), with positive width and height.',
      );
    return { x: values[0], y: values[1], width: values[2], height: values[3] };
  });
}
