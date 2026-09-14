import { env } from 'cloudflare:workers';
import { HttpError } from './http';
import { parseCaptureOptions, type CaptureOptions } from './capture-options';
import { sha256Hex } from './ids';
export async function watchSettingsReady() {
  return !!(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='watch_settings'").first());
}
export function noiseStrings(options: CaptureOptions) {
  return {
    hide: (options.hide ?? []).join(','),
    ignore_regions: (options.ignoreRegions ?? []).map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(';'),
  };
}
export async function watchNoise(id: string) {
  if (!(await watchSettingsReady())) return { hide: '', ignore_regions: '' };
  return (
    (await env.DB.prepare('SELECT hide,ignore_regions FROM watch_settings WHERE watch_id=?')
      .bind(id)
      .first<{ hide: string; ignore_regions: string }>()) ?? { hide: '', ignore_regions: '' }
  );
}
export function previewOptions(b: Record<string, string>) {
  const options = parseCaptureOptions({
    url: b.url,
    device: b.device,
    mode: b.mode ?? 'fullpage',
    format: 'png',
    hide: b.hide ?? '',
    ignore_regions: b.ignore_regions ?? '',
    block_ads: '1',
    dismiss_consent: '1',
    facts: '1',
  });
  if (options.mode === 'series') throw new HttpError(400, 'invalid_request', 'Monitors require a single PNG image.');
  return options;
}
export async function previewFingerprint(options: CaptureOptions) {
  return sha256Hex(
    JSON.stringify({
      url: options.url,
      device: options.device,
      width: options.width,
      height: options.height,
      scale: options.scale,
      mode: options.mode,
      format: options.format,
      ...noiseStrings(options),
    }),
  );
}
