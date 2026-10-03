/**
 * The comparison itself, as it runs inside the browser page.
 *
 * Kept in its own module with no imports because the function is serialised and
 * evaluated in a page — anything it closes over would not survive the trip. That
 * also makes it testable: a test can drive this exact function in any browser
 * rather than a copy of it that drifts.
 */

/** A changed area, as fractions (0–1) of the "after" image, so it scales to any rendering of it. */
export interface ChangeRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiffResult {
  /**
   * Share of pixels that differ, 0–100. When the sizes differ it is measured
   * over the area of both images together, and the part only one of them
   * covers counts as changed: a page that grew by a tenth changed by a tenth.
   */
  changedPct: number;
  /** Count before percentage rounding, after tolerance and downsampling. Includes the uncovered area. */
  changedPixels: number;
  /** The same share over the area both images cover. Equals changedPct when the sizes match. */
  sharedPct: number;
  /** True when the two images are not the same size. */
  resized: boolean;
  width: number;
  height: number;
  /**
   * Where it changed: at most MAX_REGIONS boxes over the "after" image, from
   * the same per-pixel test as the percentage — so ignore regions and hidden
   * selectors, painted identically into both captures, never produce one. The
   * area only one version covers is a box too: what a taller page added, or a
   * band along the new edge of a page that lost some.
   */
  regions: ChangeRegion[];
  /** A JPEG data URL of the "after" image with `regions` drawn on, when asked for and the change met `minPct`. */
  highlight?: string;
}

/** How the highlighted copy is drawn and how large it may get. */
export interface HighlightOptions {
  /** Drawn only for a change this large, in percent; 0 means any detected change. */
  minPct: number;
  maxWidth: number;
  maxPixels: number;
  /** The longest data URL worth sending back; past it there is no highlight. */
  maxChars: number;
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

/** More boxes than this stop pointing at anything: past it the nearest ones merge. */
export const MAX_REGIONS = 8;

/**
 * The highlighted copy is for a person to glance at, in an email or on a phone,
 * so it is downscaled: a long page fits in a few megapixels, and the JPEG stays
 * under about a megabyte and a half.
 */
export const HIGHLIGHT_LIMITS: Omit<HighlightOptions, 'minPct'> = {
  maxWidth: 1000,
  maxPixels: 3_000_000,
  maxChars: 2_000_000,
};

export async function compareInPage(
  before: string,
  after: string,
  tolerance: number,
  maxPixels: number,
  region?: { x: number; y: number; width: number; height: number },
  highlight?: HighlightOptions,
  maxRegions = 8,
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

  // Compare over the shared area, then count what only one image covers as
  // changed. A page that grew taller has changed by the part it grew, not by
  // all of it — so the threshold, not the resize alone, decides.
  const x = region?.x ?? 0, y = region?.y ?? 0;
  const width = Math.min(region?.width ?? Infinity, a.naturalWidth - x, b.naturalWidth - x);
  const height = Math.min(region?.height ?? Infinity, a.naturalHeight - y, b.naturalHeight - y);
  if (region && (width < region.width || height < region.height)) throw new Error("Watched region is outside the captured page.");
  const union = resized ? Math.max(a.naturalWidth, b.naturalWidth) * Math.max(a.naturalHeight, b.naturalHeight) : width * height;
  if (!width || !height) {
    const regions = resized && b.naturalWidth && b.naturalHeight ? [{ x: 0, y: 0, w: 1, h: 1 }] : [];
    return { changedPct: 100, changedPixels: resized ? Math.max(1, union) : 0, sharedPct: 100, resized, width, height, regions };
  }

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

  // Changed pixels are also marked on a grid of square tiles, about 48 across,
  // which is what the boxes are built from. Each tile keeps the extent of its
  // changed pixels, so a box fits the change rather than the tile edges.
  type Grid = { cols: number; rows: number; minX: Int32Array; minY: Int32Array; maxX: Int32Array; maxY: Int32Array };
  const grid = (cols: number, rows: number): Grid => ({
    cols,
    rows,
    minX: new Int32Array(cols * rows).fill(w),
    minY: new Int32Array(cols * rows).fill(h),
    maxX: new Int32Array(cols * rows).fill(-1),
    maxY: new Int32Array(cols * rows).fill(-1),
  });
  const tile = Math.max(2, Math.ceil(w / 48));
  const tiles = grid(Math.ceil(w / tile), Math.ceil(h / tile));

  let changed = 0;
  for (let py = 0, i = 0; py < h; py++) {
    const row = Math.floor(py / tile) * tiles.cols;
    for (let px = 0; px < w; px++, i += 4) {
      if (
        Math.abs(pixelsA[i]! - pixelsB[i]!) > tolerance ||
        Math.abs(pixelsA[i + 1]! - pixelsB[i + 1]!) > tolerance ||
        Math.abs(pixelsA[i + 2]! - pixelsB[i + 2]!) > tolerance
      ) {
        changed++;
        const t = row + Math.floor(px / tile);
        if (px < tiles.minX[t]!) tiles.minX[t] = px;
        if (px > tiles.maxX[t]!) tiles.maxX[t] = px;
        if (py < tiles.minY[t]!) tiles.minY[t] = py;
        tiles.maxY[t] = py;
      }
    }
  }

  const sharedShare = changed / (w * h);
  const uncovered = union - width * height;
  const changedPct = ((sharedShare * width * height + uncovered) / union) * 100;
  // In the same downsampled units as `changed`, and never zero for a resize.
  const extra = uncovered > 0 ? Math.max(1, Math.round(uncovered * scale * scale)) : 0;

  /* ------------------------------------------------------------------------ */
  /* Regions                                                                   */
  /* ------------------------------------------------------------------------ */

  // Half-open rectangles in "after" image pixels, until they are normalised.
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const afterW = b.naturalWidth;
  const afterH = b.naturalHeight;
  const unitX = width / w;
  const unitY = height / h;

  /*
   * Changed tiles within two of each other join one cluster, so a paragraph
   * that reflowed is one box rather than a box per line. A page changed in a
   * hundred scattered places is clustered again on a grid half as fine, until
   * few enough clusters are left to merge pair by pair.
   */
  const cluster = (level: Grid): Box[] => {
    const { cols, rows } = level;
    const seen = new Uint8Array(cols * rows);
    const found: Box[] = [];
    for (let start = 0; start < cols * rows; start++) {
      if (level.maxX[start]! < 0 || seen[start]) continue;
      let px0 = w, py0 = h, px1 = -1, py1 = -1;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const at = stack.pop()!;
        px0 = Math.min(px0, level.minX[at]!);
        py0 = Math.min(py0, level.minY[at]!);
        px1 = Math.max(px1, level.maxX[at]!);
        py1 = Math.max(py1, level.maxY[at]!);
        const c = at % cols, r = Math.floor(at / cols);
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const nc = c + dc, nr = r + dr;
            if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
            const next = nr * cols + nc;
            if (level.maxX[next]! >= 0 && !seen[next]) {
              seen[next] = 1;
              stack.push(next);
            }
          }
        }
      }
      found.push({ x0: x + px0 * unitX, y0: y + py0 * unitY, x1: x + (px1 + 1) * unitX, y1: y + (py1 + 1) * unitY });
    }
    return found;
  };

  let level = tiles;
  let boxes = changed ? cluster(level) : [];
  while (boxes.length > maxRegions * 4 && (level.cols > 1 || level.rows > 1)) {
    const coarse = grid(Math.ceil(level.cols / 2), Math.ceil(level.rows / 2));
    for (let r = 0; r < level.rows; r++) {
      for (let c = 0; c < level.cols; c++) {
        const from = r * level.cols + c;
        if (level.maxX[from]! < 0) continue;
        const to = Math.floor(r / 2) * coarse.cols + Math.floor(c / 2);
        coarse.minX[to] = Math.min(coarse.minX[to]!, level.minX[from]!);
        coarse.minY[to] = Math.min(coarse.minY[to]!, level.minY[from]!);
        coarse.maxX[to] = Math.max(coarse.maxX[to]!, level.maxX[from]!);
        coarse.maxY[to] = Math.max(coarse.maxY[to]!, level.maxY[from]!);
      }
    }
    level = coarse;
    boxes = cluster(level);
  }

  // The area only one version covers. A box where the page grew; where it
  // shrank there is nothing left to point at, so a band along the new edge.
  const near = tile * Math.max(unitX, unitY);
  if (resized) {
    const edge = (length: number) => Math.min(length, Math.max(4, Math.round(near)));
    if (afterH > height) boxes.push({ x0: 0, y0: height, x1: afterW, y1: afterH });
    if (afterW > width) boxes.push({ x0: width, y0: 0, x1: afterW, y1: afterH });
    if (a.naturalHeight > afterH) boxes.push({ x0: 0, y0: afterH - edge(afterH), x1: afterW, y1: afterH });
    if (a.naturalWidth > afterW) boxes.push({ x0: afterW - edge(afterW), y0: 0, x1: afterW, y1: afterH });
  }

  const join = (p: Box, q: Box): Box => ({
    x0: Math.min(p.x0, q.x0),
    y0: Math.min(p.y0, q.y0),
    x1: Math.max(p.x1, q.x1),
    y1: Math.max(p.y1, q.y1),
  });
  const area = (box: Box) => (box.x1 - box.x0) * (box.y1 - box.y0);
  // Boxes that overlap or nearly touch say the same thing twice.
  const touching = (p: Box, q: Box) =>
    p.x0 <= q.x1 + near && q.x0 <= p.x1 + near && p.y0 <= q.y1 + near && q.y0 <= p.y1 + near;
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) {
      for (let j = i + 1; j < boxes.length && !merged; j++) {
        if (touching(boxes[i]!, boxes[j]!)) {
          boxes[i] = join(boxes[i]!, boxes[j]!);
          boxes.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  // Still too many: merge whichever pair adds the least empty area.
  while (boxes.length > maxRegions) {
    let best = [0, 1], cost = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const waste = area(join(boxes[i]!, boxes[j]!)) - area(boxes[i]!) - area(boxes[j]!);
        if (waste < cost) {
          cost = waste;
          best = [i, j];
        }
      }
    }
    boxes[best[0]!] = join(boxes[best[0]!]!, boxes[best[1]!]!);
    boxes.splice(best[1]!, 1);
  }

  const fraction = (value: number, length: number) =>
    Math.round(Math.min(1, Math.max(0, value / length)) * 10_000) / 10_000;
  const regions = boxes
    .map((box) => {
      const rx = fraction(box.x0, afterW), ry = fraction(box.y0, afterH);
      return {
        x: rx,
        y: ry,
        w: Math.max(0.0001, Math.round((fraction(box.x1, afterW) - rx) * 10_000) / 10_000),
        h: Math.max(0.0001, Math.round((fraction(box.y1, afterH) - ry) * 10_000) / 10_000),
      };
    })
    .sort((p, q) => p.y - q.y || p.x - q.x);

  const result: DiffResult = {
    changedPct,
    changedPixels: changed + extra,
    sharedPct: sharedShare * 100,
    resized,
    width,
    height,
    regions,
  };

  /* ------------------------------------------------------------------------ */
  /* The highlighted copy                                                      */
  /* ------------------------------------------------------------------------ */

  // Judged on the rounded percentage, which is the one the caller compares.
  const met = highlight
    ? highlight.minPct === 0
      ? result.changedPixels > 0
      : Math.round(changedPct * 100) / 100 >= highlight.minPct
    : false;
  if (highlight && met && regions.length) {
    const fit = Math.min(1, highlight.maxWidth / afterW, Math.sqrt(highlight.maxPixels / (afterW * afterH)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(afterW * fit));
    canvas.height = Math.max(1, Math.round(afterH * fit));
    const context = canvas.getContext('2d')!;
    context.drawImage(b, 0, 0, canvas.width, canvas.height);
    const line = Math.max(2, Math.round(canvas.width / 400));
    for (const box of regions) {
      const bw = Math.min(canvas.width, Math.max(box.w * canvas.width, line * 3));
      const bh = Math.min(canvas.height, Math.max(box.h * canvas.height, line * 3));
      const bx = Math.min(box.x * canvas.width, canvas.width - bw);
      const by = Math.min(box.y * canvas.height, canvas.height - bh);
      context.fillStyle = 'rgba(251, 117, 21, 0.14)';
      context.fillRect(bx, by, bw, bh);
      // Brand orange, with a thin dark edge either side so it reads on any page.
      context.lineWidth = line + 2;
      context.strokeStyle = 'rgba(27, 28, 28, 0.9)';
      context.strokeRect(bx + line / 2, by + line / 2, bw - line, bh - line);
      context.lineWidth = line;
      context.strokeStyle = '#fb7515';
      context.strokeRect(bx + line / 2, by + line / 2, bw - line, bh - line);
    }
    for (const quality of [0.8, 0.6]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= highlight.maxChars) {
        result.highlight = url;
        break;
      }
    }
  }

  return result;
}
