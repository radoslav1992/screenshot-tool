import type { CaptureMode } from './capture-options';

/**
 * The mark free captures carry.
 *
 * It is drawn into the page just before the screenshot rather than composited
 * onto the image afterwards. Workers have no image library, and re-encoding a
 * PNG in JS would cost more CPU than the capture itself — this costs one
 * `page.evaluate`.
 *
 * Because it is a real DOM element it also scales with the device pixel ratio
 * for free, so it stays crisp at 3x without any extra work.
 *
 * Being part of the page also puts it within reach of the page's stylesheet,
 * and the page is whatever the free account chose to point us at. So the id is
 * new for every capture — there is no fixed selector to write `display:none`
 * against — and every declaration is `!important`, with which an inline style
 * wins over anything a stylesheet says.
 */

const LABEL = 'easyscreencapture.com';

/** A fresh element id for one capture's mark. */
export function watermarkId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `m${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Where to anchor the mark. `fixed` follows the viewport, which is what a single
 * frame and every frame of a scroll series need. A full-page capture is one tall
 * image, so the mark is placed at the document's bottom-right instead — a fixed
 * element would only land near the top of the stitched image.
 */
function anchorFor(mode: CaptureMode): 'fixed' | 'absolute' {
  return mode === 'fullpage' ? 'absolute' : 'fixed';
}

/**
 * The mark as page source. Returned as a string so the same code can go through
 * `page.evaluate` on the binding path and `addScriptTag` on the REST path.
 *
 * Applying it again with the same id replaces the mark rather than adding a
 * second one, which is how it follows a viewport change.
 */
export function watermarkScript(mode: CaptureMode, id: string = watermarkId()): string {
  const anchor = anchorFor(mode);
  return `(function () {
  var id = ${JSON.stringify(id)};
  var existing = document.getElementById(id);
  if (existing) existing.remove();

  var badge = document.createElement('div');
  badge.id = id;

  var dot = document.createElement('span');
  dot.style.cssText = [
    'width:6px',
    'height:6px',
    'border-radius:50%',
    'background:#D7F25F',
    'display:inline-block',
    'margin-right:6px',
    'flex:0 0 auto'
  ].join(' !important;') + ' !important';
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode(${JSON.stringify(LABEL)}));

  badge.style.cssText = [
    'position:${anchor}',
    'right:14px',
    'z-index:2147483647',
    'display:inline-flex',
    'align-items:center',
    'padding:6px 11px',
    'border-radius:999px',
    'background:rgba(15,17,12,0.82)',
    'color:#F5F3EE',
    'font:600 11px/1 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif',
    'letter-spacing:0.02em',
    'box-shadow:0 2px 10px rgba(0,0,0,0.25)',
    'pointer-events:none',
    'margin:0',
    // Initial values, said out loud: the other easy ways to make it vanish.
    'visibility:visible',
    'opacity:1',
    'transform:none',
    'filter:none',
    'clip-path:none'
  ].join(' !important;') + ' !important';

  if (${JSON.stringify(anchor)} === 'absolute') {
    // Anchor to the document so the mark lands inside the bottom of the
    // stitched image rather than near its top.
    badge.style.setProperty('top', Math.max(0, document.documentElement.scrollHeight - 40) + 'px', 'important');
  } else {
    badge.style.setProperty('bottom', '14px', 'important');
  }

  document.documentElement.appendChild(badge);
})();`;
}

/** Injects the mark. Best-effort: a page that blocks evaluation still gets its screenshot. */
export async function applyWatermark(page: any, mode: CaptureMode, id?: string): Promise<void> {
  try {
    await page.evaluate(watermarkScript(mode, id));
  } catch (error) {
    // Log so an unmarked free capture is at least visible in the logs.
    console.error('[watermark] could not apply the mark', error);
  }
}
