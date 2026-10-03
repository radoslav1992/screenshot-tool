/**
 * The free tools' forms, a little better with JavaScript.
 *
 * Every tool works as a plain form that posts to its own page and comes back
 * with the result in it. This posts the same form with fetch() instead, so the
 * page stays put while a browser renders for 5–20 seconds: the button says how
 * long it has been, and the result is taken from the page that comes back, the
 * same markup the plain form would have shown.
 *
 * The images arrive inline, as nothing is stored to fetch them from. They are
 * turned into object URLs here, which a download link handles better than a
 * long data: URL and the page can let go of when the next result arrives.
 */

const form = document.querySelector<HTMLFormElement>('form[data-tool-form]');
let objectUrls: string[] = [];

function release(): void {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
}

/** Swaps each inline image, and the download link that shares its bytes, for an object URL. */
async function toObjectUrls(root: HTMLElement): Promise<void> {
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a[data-tool-download]')];
  for (const image of root.querySelectorAll<HTMLImageElement>('img[data-tool-image]')) {
    const source = image.getAttribute('src') ?? '';
    if (!source.startsWith('data:')) continue;
    try {
      const url = URL.createObjectURL(await (await fetch(source)).blob());
      objectUrls.push(url);
      image.src = url;
      for (const link of links) if (link.getAttribute('href') === source) link.href = url;
    } catch {
      /* the data: URL still works; it is just heavier */
    }
  }
  for (const link of links) {
    const source = link.getAttribute('href') ?? '';
    if (!source.startsWith('data:')) continue;
    try {
      const url = URL.createObjectURL(await (await fetch(source)).blob());
      objectUrls.push(url);
      link.href = url;
    } catch {
      /* as above */
    }
  }
}

/** A share preview whose image will not load says so, rather than showing a broken picture. */
function quietBrokenImages(root: HTMLElement): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('.seo-card img')) {
    const replace = () => {
      const note = document.createElement('span');
      note.className = 'seo-card__none';
      note.textContent = 'The og:image could not be loaded';
      image.replaceWith(note);
    };
    if (image.complete && image.naturalWidth === 0) replace();
    else image.addEventListener('error', replace, { once: true });
  }
}

/** The addresses as typed, with https:// where none was given: what the server assumes anyway. */
function normaliseUrls(target: HTMLFormElement): void {
  for (const input of target.querySelectorAll<HTMLInputElement>('input[inputmode="url"]')) {
    const value = input.value.trim();
    if (value && !/^https?:\/\//i.test(value)) input.value = `https://${value}`;
  }
}

if (form) {
  const output = () => document.querySelector<HTMLElement>('[data-tool-result]');
  const button = form.querySelector<HTMLButtonElement>('[data-tool-submit]')!;
  const label = form.querySelector<HTMLElement>('[data-tool-label]')!;
  const status = form.querySelector<HTMLElement>('[data-tool-status]')!;
  const statusText = form.querySelector<HTMLElement>('[data-tool-status-text]')!;
  const working = form.dataset.working ?? 'Working';
  let busy = false;

  const current = output();
  if (current) {
    quietBrokenImages(current);
    void toObjectUrls(current);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    normaliseUrls(form);
    if (!form.reportValidity()) return;

    busy = true;
    const started = Date.now();
    const idle = label.textContent;
    const tick = () => {
      const seconds = Math.round((Date.now() - started) / 1000);
      statusText.textContent = `${working}… ${seconds} s. Pages usually take 5 to 20 seconds.`;
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    // aria-disabled rather than disabled: a disabled button drops focus, and the busy flag already ignores clicks.
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-busy', 'true');
    label.textContent = 'Working…';
    status.hidden = false;
    form.setAttribute('aria-busy', 'true');

    let replacement: HTMLElement | null = null;
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        credentials: 'same-origin',
        headers: { accept: 'text/html' },
      });
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      replacement = page.querySelector<HTMLElement>('[data-tool-result]');
      // The page that came back says whether there is a result to rerun from.
      const next = page.querySelector<HTMLElement>('[data-tool-label]')?.textContent;
      if (next) label.dataset.next = next;
      button.classList.toggle('ai-btn-outline', Boolean(replacement?.querySelector('.tool-output')));
    } catch {
      replacement = null;
    } finally {
      window.clearInterval(timer);
      busy = false;
      button.removeAttribute('aria-disabled');
      button.removeAttribute('aria-busy');
      form.removeAttribute('aria-busy');
      status.hidden = true;
      label.textContent = label.dataset.next ?? idle;
    }

    const previous = output();
    if (!previous) return;
    if (!replacement) {
      replacement = previous.cloneNode(false) as HTMLElement;
      replacement.innerHTML =
        '<div class="tool-error" role="alert"><span class="tool-error__label">[ COULD NOT RUN ]</span>' +
        '<p>The request did not get through. Check your connection and try again.</p></div>';
    }
    release();
    previous.replaceWith(replacement);
    quietBrokenImages(replacement);
    await toObjectUrls(replacement);
    replacement.focus({ preventScroll: true });
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    replacement.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  });
}
