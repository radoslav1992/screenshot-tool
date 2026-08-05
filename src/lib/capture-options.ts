import { env } from 'cloudflare:workers';
import { badRequest } from './http';

export type DeviceId = 'desktop' | 'tablet' | 'mobile' | 'custom';
export type CaptureMode = 'visible' | 'fullpage' | 'series';
export type CaptureFormat = 'png' | 'jpg' | 'pdf';

export interface DevicePreset {
  id: Exclude<DeviceId, 'custom'>;
  label: string;
  icon: string;
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
  userAgent?: string;
}

export const DEVICES: Record<Exclude<DeviceId, 'custom'>, DevicePreset> = {
  desktop: { id: 'desktop', label: 'Desktop', icon: '💻', width: 1440, height: 900, scale: 2, mobile: false },
  tablet: { id: 'tablet', label: 'Tablet', icon: '📱', width: 834, height: 1194, scale: 2, mobile: true },
  mobile: { id: 'mobile', label: 'Mobile', icon: '📲', width: 390, height: 844, scale: 3, mobile: true },
};

export const DEVICE_LIST = [DEVICES.desktop, DEVICES.tablet, DEVICES.mobile];

export const MODES: Array<{ id: CaptureMode; label: string; hint: string; longHint: string; icon: string }> = [
  {
    id: 'visible',
    label: 'Visible area',
    hint: 'One shot of what fits on screen',
    longHint: 'Just what fits on the screen. Quick and light.',
    icon: '🖼️',
  },
  {
    id: 'fullpage',
    label: 'Full page',
    hint: 'Whole page in one tall image',
    longHint: 'The whole page, top to bottom, in one tall image.',
    icon: '📜',
  },
  {
    id: 'series',
    label: 'Scroll series',
    hint: 'Screen-sized shots, top to bottom',
    longHint: 'Screen-sized shots in order — the full page as a sequence.',
    icon: '🎞️',
  },
];

export const FORMATS: CaptureFormat[] = ['png', 'jpg', 'pdf'];

export const LIMITS = {
  minWidth: 240,
  maxWidth: 3840,
  minHeight: 240,
  maxHeight: 4320,
  minScale: 1,
  maxScale: 3,
  maxDelayMs: 15_000,
  maxSeriesFrames: 20,
  /** Hard ceiling on stitched full-page height, in CSS pixels. */
  maxFullPageHeight: 20_000,
};

export interface CaptureOptions {
  url: string;
  host: string;
  device: DeviceId;
  width: number;
  height: number;
  scale: number;
  mode: CaptureMode;
  format: CaptureFormat;
  fullPage: boolean;
  delayMs: number;
  blockAds: boolean;
  darkMode: boolean;
  quality: number;
  maxFrames: number;
}

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^::1$/,
  /^\[?::1\]?$/,
  /^f[cd][0-9a-f]{2}:/i, // unique-local IPv6
  /^fe80:/i,
  /\.local$/i,
  /\.internal$/i,
  /^metadata\.google\.internal$/i,
];

function assertPublicUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw badRequest('That does not look like a valid URL.', 'url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('Only http and https URLs can be captured.', 'url');
  }
  if (!parsed.hostname.includes('.') && !parsed.hostname.includes(':')) {
    throw badRequest('That does not look like a valid hostname.', 'url');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw badRequest('Private and loopback addresses cannot be captured.', 'url');
  }

  const denylist = (env.CAPTURE_HOST_DENYLIST ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (denylist.includes(host.toLowerCase())) {
    throw badRequest('That host is not allowed.', 'url');
  }

  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed;
}

function intInRange(value: string | undefined, fallback: number, min: number, max: number, param: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw badRequest(`\`${param}\` must be a number.`, param);
  if (parsed < min || parsed > max) {
    throw badRequest(`\`${param}\` must be between ${min} and ${max}.`, param);
  }
  return parsed;
}

function boolValue(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true' || value === 'on' || value.toLowerCase() === 'yes';
}

/**
 * Normalises raw request params into a validated capture job.
 * Shared by the app UI and the public API so both behave identically.
 */
export function parseCaptureOptions(input: Record<string, string>): CaptureOptions {
  const url = assertPublicUrl((input.url ?? '').trim());

  const modeRaw = (input.mode ?? 'visible').toLowerCase();
  if (!MODES.some((mode) => mode.id === modeRaw)) {
    throw badRequest('`mode` must be one of: visible, fullpage, series.', 'mode');
  }
  const mode = modeRaw as CaptureMode;

  const formatRaw = (input.format ?? 'png').toLowerCase().replace('jpeg', 'jpg');
  if (!FORMATS.includes(formatRaw as CaptureFormat)) {
    throw badRequest('`format` must be one of: png, jpg, pdf.', 'format');
  }
  const format = formatRaw as CaptureFormat;

  if (format === 'pdf' && mode === 'series') {
    throw badRequest('`format=pdf` is not available for scroll series captures.', 'format');
  }

  const deviceRaw = (input.device ?? 'desktop').toLowerCase();
  const hasCustomSize = Boolean(input.width || input.height);
  let device: DeviceId;
  let width: number;
  let height: number;
  let scale: number;

  if (deviceRaw === 'custom' || (hasCustomSize && !(deviceRaw in DEVICES))) {
    device = 'custom';
    width = intInRange(input.width, 1280, LIMITS.minWidth, LIMITS.maxWidth, 'width');
    height = intInRange(input.height, 800, LIMITS.minHeight, LIMITS.maxHeight, 'height');
    scale = 2;
  } else if (deviceRaw in DEVICES) {
    const preset = DEVICES[deviceRaw as Exclude<DeviceId, 'custom'>];
    device = preset.id;
    width = intInRange(input.width, preset.width, LIMITS.minWidth, LIMITS.maxWidth, 'width');
    height = intInRange(input.height, preset.height, LIMITS.minHeight, LIMITS.maxHeight, 'height');
    scale = preset.scale;
    if (width !== preset.width || height !== preset.height) device = 'custom';
  } else {
    throw badRequest('`device` must be one of: desktop, tablet, mobile, custom.', 'device');
  }

  if (input.scale) {
    const parsed = Number.parseFloat(input.scale);
    if (!Number.isFinite(parsed) || parsed < LIMITS.minScale || parsed > LIMITS.maxScale) {
      throw badRequest(`\`scale\` must be between ${LIMITS.minScale} and ${LIMITS.maxScale}.`, 'scale');
    }
    scale = parsed;
  }

  return {
    url: url.toString(),
    host: url.hostname,
    device,
    width,
    height,
    scale,
    mode,
    format,
    fullPage: mode === 'fullpage',
    delayMs: intInRange(input.delay, 0, 0, LIMITS.maxDelayMs, 'delay'),
    blockAds: boolValue(input.block_ads, true),
    darkMode: boolValue(input.dark_mode, false),
    quality: intInRange(input.quality, 85, 30, 100, 'quality'),
    maxFrames: intInRange(input.max_frames, LIMITS.maxSeriesFrames, 1, LIMITS.maxSeriesFrames, 'max_frames'),
  };
}

export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

export function deviceLabel(device: string, width: number, height: number): string {
  if (device === 'custom') return `${width}×${height}`;
  return DEVICES[device as Exclude<DeviceId, 'custom'>]?.label ?? device;
}

export function deviceIcon(device: string): string {
  return DEVICES[device as Exclude<DeviceId, 'custom'>]?.icon ?? '🖥️';
}

export function modeLabel(mode: string): string {
  return MODES.find((entry) => entry.id === mode)?.label ?? mode;
}
