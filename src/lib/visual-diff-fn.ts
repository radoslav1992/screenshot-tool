/**
 * The comparison itself, as it runs inside the browser page.
 *
 * Kept in its own module with no imports because the function is serialised and
 * evaluated in a page — anything it closes over would not survive the trip. That
 * also makes it testable: a test can drive this exact function in any browser
 * rather than a copy of it that drifts.
 */

export interface DiffResult {
  /** Share of pixels that differ, 0–100. */
  changedPct: number;
  /** True when the two images are not the same size — itself a change. */
  resized: boolean;
  width: number;
  height: number;
}

/**
 * Per-channel tolerance, 0–255. JPEG quantisation and font antialiasing move
 * pixels by a point or two between otherwise identical renders; without a floor
 * every run would report a change.
 */
export const CHANNEL_TOLERANCE = 12;

/**
 * Long pages are compared at reduced resolution. A 390×20000 capture is 7.8M
 * pixels per image, and the share of them that changed is just as accurate from
 * a quarter — while the work drops fourfold.
 */
export const MAX_COMPARE_PIXELS = 2_000_000;

export async function compareInPage(
  before: string,
  after: string,
  tolerance: number,
  maxPixels: number,
  region?: { x: number; y: number; width: number; height: number },
): Promise<DiffResult> {
  const load = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`could not load ${src.slice(0, 80)}`));
      image.src = src;
    });

  const [a, b] = await Promise.all([load(before), load(after)]);

  const resized = !region && (a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight);

  // Compare over the shared area. A page that grew taller has already changed;
  // this still measures how much of the part they have in common moved.
  const x = region?.x ?? 0, y = region?.y ?? 0;
  const width = Math.min(region?.width ?? Infinity, a.naturalWidth - x, b.naturalWidth - x);
  const height = Math.min(region?.height ?? Infinity, a.naturalHeight - y, b.naturalHeight - y);
  if (region && (width < region.width || height < region.height)) throw new Error("Watched region is outside the captured page.");
  if (!width || !height) return { changedPct: 100, resized, width, height };

  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const draw = (image: HTMLImageElement): Uint8ClampedArray => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, x, y, width, height, 0, 0, w, h);
    return context.getImageData(0, 0, w, h).data;
  };

  const pixelsA = draw(a);
  const pixelsB = draw(b);

  let changed = 0;
  for (let i = 0; i < pixelsA.length; i += 4) {
    if (
      Math.abs(pixelsA[i]! - pixelsB[i]!) > tolerance ||
      Math.abs(pixelsA[i + 1]! - pixelsB[i + 1]!) > tolerance ||
      Math.abs(pixelsA[i + 2]! - pixelsB[i + 2]!) > tolerance
    ) {
      changed++;
    }
  }

  return { changedPct: (changed / (w * h)) * 100, resized, width, height };
}
