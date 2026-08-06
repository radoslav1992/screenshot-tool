import { env } from 'cloudflare:workers';
import { badRequest } from './http';

/** Physical devices — what the page is rendered as. */
export type DeviceId = 'desktop' | 'tablet' | 'mobile';

/** Fixed output frames — what the image has to fit into. */
export type FrameId = 'instagram-post' | 'instagram-square' | 'instagram-story' | 'og-image' | 'x-post';

export type ViewportId = DeviceId | FrameId | 'custom';

export type CaptureMode = 'visible' | 'fullpage' | 'series';
export type CaptureFormat = 'png' | 'jpg' | 'pdf';

export type PresetIcon =
  | 'desktop'
  | 'tablet'
  | 'mobile'
  | 'frame-portrait'
  | 'frame-square'
  | 'frame-story'
  | 'frame-wide';

export interface ViewportPreset {
  id: DeviceId | FrameId;
  label: string;
  icon: PresetIcon;
  /** CSS pixels the page is laid out at. */
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
  /** Set on frames: the exact pixel size the file comes out at (width × scale). */
  output?: string;
  userAgent?: string;
}

/** Kept exactly as they were — these are the everyday captures. */
export const DEVICES: Record<DeviceId, ViewportPreset> = {
  desktop: { id: 'desktop', label: 'Desktop', icon: 'desktop', width: 1440, height: 900, scale: 2, mobile: false },
  tablet: { id: 'tablet', label: 'Tablet', icon: 'tablet', width: 834, height: 1194, scale: 2, mobile: true },
  mobile: { id: 'mobile', label: 'Mobile', icon: 'mobile', width: 390, height: 844, scale: 3, mobile: true },
};

export const DEVICE_LIST = [DEVICES.desktop, DEVICES.tablet, DEVICES.mobile];

/**
 * Frames that land on an exact output size, so a capture is publishable as-is
 * rather than something you crop afterwards.
 *
 * Each viewport is chosen so `width × scale` is the platform's pixel size: the
 * page is laid out at a width that reads well, and the file comes out exact.
 */
export const FRAMES: Record<FrameId, ViewportPreset> = {
  'instagram-post': {
    id: 'instagram-post',
    label: 'Post 4:5',
    icon: 'frame-portrait',
    width: 540,
    height: 675,
    scale: 2,
    mobile: true,
    output: '1080×1350',
  },
  'instagram-square': {
    id: 'instagram-square',
    label: 'Square 1:1',
    icon: 'frame-square',
    width: 540,
    height: 540,
    scale: 2,
    mobile: true,
    output: '1080×1080',
  },
  'instagram-story': {
    id: 'instagram-story',
    label: 'Story 9:16',
    icon: 'frame-story',
    width: 360,
    height: 640,
    scale: 3,
    mobile: true,
    output: '1080×1920',
  },
  'og-image': {
    id: 'og-image',
    label: 'Link preview',
    icon: 'frame-wide',
    width: 1200,
    height: 630,
    scale: 1,
    mobile: false,
    output: '1200×630',
  },
  'x-post': {
    id: 'x-post',
    label: 'Wide 16:9',
    icon: 'frame-wide',
    width: 800,
    height: 450,
    scale: 2,
    mobile: false,
    output: '1600×900',
  },
};

export const FRAME_LIST = [
  FRAMES['instagram-post'],
  FRAMES['instagram-square'],
  FRAMES['instagram-story'],
  FRAMES['og-image'],
  FRAMES['x-post'],
];

/** Every named preset, by id. Frames are named, so they are not "custom" sizes. */
export const PRESETS: Record<DeviceId | FrameId, ViewportPreset> = { ...DEVICES, ...FRAMES };

export function isFrameId(id: string): id is FrameId {
  return id in FRAMES;
}

export const MODES: Array<{
  id: CaptureMode;
  label: string;
  hint: string;
  longHint: string;
  icon: 'mode-visible' | 'mode-fullpage' | 'mode-series';
}> = [
  {
    id: 'visible',
    label: 'Visible area',
    hint: 'One shot of what fits on screen',
    longHint: 'Just what fits on the screen. Quick and light.',
    icon: 'mode-visible',
  },
  {
    id: 'fullpage',
    label: 'Full page',
    hint: 'Whole page in one tall image',
    longHint: 'The whole page, top to bottom, in one tall image.',
    icon: 'mode-fullpage',
  },
  {
    id: 'series',
    label: 'Scroll series',
    hint: 'Screen-sized shots, top to bottom',
    longHint: 'Screen-sized shots in order — the full page as a sequence.',
    icon: 'mode-series',
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
  device: ViewportId;
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
  let device: ViewportId;
  let width: number;
  let height: number;
  let scale: number;

  if (deviceRaw === 'custom' || (hasCustomSize && !(deviceRaw in PRESETS))) {
    device = 'custom';
    width = intInRange(input.width, 1280, LIMITS.minWidth, LIMITS.maxWidth, 'width');
    height = intInRange(input.height, 800, LIMITS.minHeight, LIMITS.maxHeight, 'height');
    scale = 2;
  } else if (deviceRaw in PRESETS) {
    const preset = PRESETS[deviceRaw as DeviceId | FrameId];
    device = preset.id;
    width = intInRange(input.width, preset.width, LIMITS.minWidth, LIMITS.maxWidth, 'width');
    height = intInRange(input.height, preset.height, LIMITS.minHeight, LIMITS.maxHeight, 'height');
    scale = preset.scale;
    // Overriding a preset's dimensions makes it a custom viewport again.
    if (width !== preset.width || height !== preset.height) device = 'custom';
  } else {
    throw badRequest(
      `\`device\` must be one of: ${Object.keys(PRESETS).join(', ')}, custom.`,
      'device',
    );
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
  return PRESETS[device as DeviceId | FrameId]?.label ?? device;
}

export function deviceIcon(device: string): PresetIcon {
  return PRESETS[device as DeviceId | FrameId]?.icon ?? 'desktop';
}

export function modeLabel(mode: string): string {
  return MODES.find((entry) => entry.id === mode)?.label ?? mode;
}
