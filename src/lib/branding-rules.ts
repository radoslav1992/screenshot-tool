import { HttpError, badRequest } from './http';
import { getPlan, PLANS, PLAN_ORDER, REPORT_WHITE_LABEL } from './plans';

/**
 * Report branding rules that need no binding: what a logo may be, what an
 * accent may be, which text colour sits on it, and what a plan may hide. Kept
 * apart from lib/branding.ts so the project page's live preview and the check
 * script can import it without a database.
 */

export const LOGO_MAX_BYTES = 512 * 1024;
/** Larger than any logo needs; mostly a guard against decompression bombs. */
export const LOGO_MAX_SIDE = 4096;
export const FOOTER_MAX = 200;
/**
 * Text on an accent. Pure black rather than the page's #111: with it, the
 * better of the two always reaches 4.5:1, which #111 misses on mid blues.
 */
export const BLACK = '#000000';
export const WHITE = '#ffffff';

export type LogoType = 'image/png' | 'image/jpeg' | 'image/webp';
export interface LogoInfo {
  type: LogoType;
  ext: 'png' | 'jpg' | 'webp';
  width: number;
  height: number;
}

/** A stored branding row, as lib/branding.ts reads it. */
export interface BrandingRow {
  logo_key: string;
  logo_type: string;
  logo_width: number;
  logo_height: number;
  accent: string;
  footer: string;
  hide_attribution: number;
}

/** What a report renders with. `accent` is '' for the default orange. */
export interface ReportBranding {
  logoUrl: string | null;
  logoWidth: number;
  logoHeight: number;
  accent: string;
  accentInk: string;
  footer: string;
  /** Show "Shared with Easy Screen Capture" under the report. */
  attribution: boolean;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const ascii = (b: Uint8Array, i: number, text: string) =>
  b.length >= i + text.length && [...text].every((c, k) => b[i + k] === c.charCodeAt(0));

/** JPEG start-of-frame markers, which carry the dimensions. C4, C8 and CC are not frames. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  // A logo has a handful of segments; the bound only stops a crafted file looping.
  for (let guard = 0; guard < 512 && i + 4 <= b.length; guard++) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    if (SOF.has(marker)) return i + 9 <= b.length ? { height: u16be(b, i + 5), width: u16be(b, i + 7) } : null;
    i += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (ascii(b, 12, 'VP8 ') && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (ascii(b, 12, 'VP8L') && b.length >= 25 && b[20] === 0x2f) {
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8X') && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

/**
 * Identifies a logo by its leading bytes, never by the name or type the
 * browser sent. Only PNG, JPEG and WebP are recognised: SVG is text that can
 * carry script, and anything this cannot size is refused rather than guessed.
 */
export function sniffLogo(bytes: Uint8Array): LogoInfo | null {
  const b = bytes;
  if (b.length >= 24 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) {
    if (!ascii(b, 12, 'IHDR')) return null;
    return { type: 'image/png', ext: 'png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b);
    return size ? { type: 'image/jpeg', ext: 'jpg', ...size } : null;
  }
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    const size = webpSize(b);
    return size ? { type: 'image/webp', ext: 'webp', ...size } : null;
  }
  return null;
}

/** Size alone, so a route can refuse an oversized upload before reading it. */
export function checkLogoSize(size: number): void {
  if (!size) throw badRequest('Choose a logo file to upload.', 'logo');
  if (size > LOGO_MAX_BYTES)
    throw new HttpError(413, 'logo_too_large', 'Logos can be up to 512 KB. Export a smaller PNG, JPEG or WebP.', 'logo');
}

const DECLARED: Record<string, LogoType> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/webp': 'image/webp',
};

/**
 * Validates an uploaded logo. The bytes decide what it is; a declared type is
 * only allowed to agree with them, so an SVG or HTML file renamed `.png`, or a
 * PNG announced as `image/svg+xml`, is refused either way.
 */
export function checkLogo(bytes: Uint8Array, declared = ''): LogoInfo {
  checkLogoSize(bytes.byteLength);
  const info = sniffLogo(bytes);
  if (!info) throw badRequest('Upload a PNG, JPEG or WebP logo. SVG and other formats are not accepted.', 'logo');
  const type = declared.split(';')[0]!.trim().toLowerCase();
  if (type && type !== 'application/octet-stream' && DECLARED[type] !== info.type)
    throw badRequest('The file’s contents do not match its type. Upload a PNG, JPEG or WebP logo.', 'logo');
  if (info.width < 1 || info.height < 1 || info.width > LOGO_MAX_SIDE || info.height > LOGO_MAX_SIDE)
    throw badRequest(`Logos can be up to ${LOGO_MAX_SIDE} × ${LOGO_MAX_SIDE} pixels.`, 'logo');
  return info;
}

/** '' keeps the default orange; anything else must be `#rrggbb`. Stored lower-case. */
export function parseAccent(value: string | undefined): string {
  const accent = (value ?? '').trim().toLowerCase();
  if (!accent) return '';
  if (!/^#[0-9a-f]{6}$/.test(accent))
    throw badRequest('Enter the accent colour as #rrggbb, for example #1f6feb, or leave it empty.', 'accent');
  return accent;
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Black or white, whichever reads better on the accent when it is a background. */
export function accentInk(accent: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(accent)) return BLACK;
  return contrastRatio(accent, WHITE) > contrastRatio(accent, BLACK) ? WHITE : BLACK;
}

/**
 * One line of free text: control characters, line breaks and bidi overrides
 * (which can make a line read differently from what it says) become spaces.
 */
export function oneLine(value: string | undefined): string {
  return (value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseFooter(value: string | undefined): string {
  const footer = oneLine(value);
  if (footer.length > FOOTER_MAX)
    throw badRequest(`The footer line can be up to ${FOOTER_MAX} characters.`, 'footer');
  return footer;
}

/** Whether the project owner's plan may hide our attribution. */
export function canHideAttribution(plan: string | null | undefined): boolean {
  return REPORT_WHITE_LABEL[getPlan(plan).id];
}

/** "Pro and Business", from the plan table rather than a hard-coded list. */
export function whiteLabelPlans(): string {
  const names = PLAN_ORDER.filter((id) => REPORT_WHITE_LABEL[id]).map((id) => PLANS[id].name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? 'Business');
}

/**
 * What a report renders with. The owner's plan is applied here, at render
 * time, so a downgrade brings the attribution back without touching the row.
 */
export function resolveBranding(row: BrandingRow | null, plan: string | null | undefined): ReportBranding {
  const accent = row && /^#[0-9a-f]{6}$/.test(row.accent) ? row.accent : '';
  const logo = row?.logo_key && /^brand\/[a-z0-9_]+\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(row.logo_key);
  return {
    logoUrl: logo ? `/${row!.logo_key}` : null,
    logoWidth: logo ? row!.logo_width : 0,
    logoHeight: logo ? row!.logo_height : 0,
    accent,
    accentInk: accent ? accentInk(accent) : BLACK,
    footer: row?.footer ?? '',
    attribution: !(row?.hide_attribution && canHideAttribution(plan)),
  };
}

/** The inline custom properties a branded report carries; '' for the default look. */
export function accentStyle(branding: Pick<ReportBranding, 'accent' | 'accentInk'> | null | undefined): string {
  return branding?.accent ? `--report-accent:${branding.accent};--report-accent-ink:${branding.accentInk}` : '';
}
