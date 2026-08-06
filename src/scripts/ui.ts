/**
 * Small progressive-enhancement helpers shared by every page:
 * copy-to-clipboard buttons and relative timestamps.
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

document.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-copy]');
  if (!target) return;

  event.preventDefault();
  const value =
    target.dataset.copyValue ??
    (target.dataset.copyFrom ? (document.querySelector(target.dataset.copyFrom)?.textContent ?? '') : '');
  if (!value) return;

  const original = target.textContent;
  const ok = await copyText(value);
  target.textContent = ok ? 'Copied' : 'Copy failed';
  window.setTimeout(() => {
    target.textContent = original;
  }, 1600);
});

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

applyRelativeTimes();
