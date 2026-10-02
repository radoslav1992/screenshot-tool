/**
 * Small progressive-enhancement helpers shared by every page:
 * copy-to-clipboard buttons, chip-row overflow hints and relative timestamps.
 */

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    textarea.remove();
    return ok;
  }
}

/** One polite live region for every copy button, so the result is announced. */
function announce(message: string): void {
  let region = document.getElementById('copy-announcer');
  if (!region) {
    region = document.createElement('p');
    region.id = 'copy-announcer';
    region.className = 'sr-only';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  // Clear first so the same message twice in a row is still announced.
  region.textContent = '';
  window.setTimeout(() => {
    region!.textContent = message;
  }, 50);
}

const COPY_FEEDBACK_MS = 1600;
const resetTimers = new WeakMap<HTMLElement, number>();
const originals = new WeakMap<
  HTMLElement,
  { text: string | null; label: string | null; title: string | null; textOnly: boolean }
>();

/**
 * Feedback never rebuilds the button's markup: an icon-only button keeps its
 * icon. Text-only buttons say "Copied" in place; every button gets a state
 * class, an updated accessible name and a spoken announcement, and all of it is
 * restored exactly afterwards.
 */
function showCopyState(target: HTMLElement, ok: boolean): void {
  if (!originals.has(target)) {
    originals.set(target, {
      text: target.textContent,
      label: target.getAttribute('aria-label'),
      title: target.getAttribute('title'),
      textOnly: target.children.length === 0,
    });
  }
  const original = originals.get(target)!;
  const message = ok ? 'Copied' : 'Copy failed';

  window.clearTimeout(resetTimers.get(target));
  target.classList.toggle('is-copied', ok);
  target.classList.toggle('is-copy-failed', !ok);
  target.setAttribute('title', message);
  if (original.label !== null) target.setAttribute('aria-label', `${original.label} — ${message.toLowerCase()}`);
  if (original.textOnly) target.textContent = message;
  announce(ok ? 'Copied to the clipboard.' : 'Could not copy. Select the text and copy it manually.');

  resetTimers.set(
    target,
    window.setTimeout(() => {
      target.classList.remove('is-copied', 'is-copy-failed');
      if (original.title === null) target.removeAttribute('title');
      else target.setAttribute('title', original.title);
      if (original.label !== null) target.setAttribute('aria-label', original.label);
      if (original.textOnly) target.textContent = original.text;
      originals.delete(target);
    }, COPY_FEEDBACK_MS),
  );
}

document.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-copy]');
  if (!target) return;

  event.preventDefault();
  const value =
    target.dataset.copyValue ??
    (target.dataset.copyFrom ? (document.querySelector(target.dataset.copyFrom)?.textContent ?? '') : '');
  if (!value) return;

  showCopyState(target, await copyText(value));
});

/**
 * A horizontally scrolling chip row hides chips past its edge. Mark which edge
 * still has more, so CSS can fade it and the hidden chips are discoverable.
 */
function watchChipOverflow(): void {
  const rows = document.querySelectorAll<HTMLElement>('.chips:not(.chips--wrap)');
  const update = (row: HTMLElement) => {
    const max = row.scrollWidth - row.clientWidth;
    if (max <= 1) {
      delete row.dataset.overflow;
      return;
    }
    const atStart = row.scrollLeft <= 1;
    const atEnd = row.scrollLeft >= max - 1;
    row.dataset.overflow = atStart ? 'end' : atEnd ? 'start' : 'both';
  };
  for (const row of rows) {
    update(row);
    row.addEventListener('scroll', () => update(row), { passive: true });
  }
  if (rows.length && 'ResizeObserver' in window) {
    const observer = new ResizeObserver((entries) => entries.forEach((entry) => update(entry.target as HTMLElement)));
    rows.forEach((row) => observer.observe(row));
  }
}

/** `<time data-relative datetime="…">` gets a human label on the client. */
function applyRelativeTimes(): void {
  const now = Date.now();
  for (const node of document.querySelectorAll<HTMLTimeElement>('time[data-relative]')) {
    const then = Date.parse(node.dateTime);
    if (!Number.isFinite(then)) continue;
    const seconds = Math.max(0, Math.round((now - then) / 1000));
    const minutes = Math.round(seconds / 60);
    const hours = Math.round(minutes / 60);
    const days = Math.round(hours / 24);

    if (seconds < 60) node.textContent = 'just now';
    else if (minutes < 60) node.textContent = `${minutes} min ago`;
    else if (hours < 24) node.textContent = `${hours} hr ago`;
    else if (days === 1) node.textContent = 'Yesterday';
    else if (days < 30) node.textContent = `${days} days ago`;
    else node.textContent = new Date(then).toLocaleDateString();
  }
}

watchChipOverflow();
applyRelativeTimes();
