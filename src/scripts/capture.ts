/** Drives the New capture form: validation, submit, polling, redirect. */

interface CaptureResponse {
  id: string;
  status: string;
  error?: string;
  images: string[];
}

interface ErrorResponse {
  error?: { message?: string };
}

const URL_PATTERN = /^https?:\/\/[^\s/$.?#][^\s]*$/i;

function normaliseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function wireCaptureForm(): void {
  const form = document.querySelector<HTMLFormElement>('#capture-form');
  if (!form) return;

  const urlInput = form.querySelector<HTMLInputElement>('#url')!;
  const urlState = form.querySelector<HTMLElement>('#url-state')!;
  const errorBox = form.querySelector<HTMLElement>('#capture-error')!;
  const submit = form.querySelector<HTMLButtonElement>('#capture-submit')!;
  const customToggle = form.querySelector<HTMLButtonElement>('#custom-toggle');
  const customSize = form.querySelector<HTMLElement>('#custom-size');

  const showError = (message: string) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
  };

  const validateUrl = () => {
    const candidate = normaliseUrl(urlInput.value);
    urlState.hidden = !(candidate && URL_PATTERN.test(candidate) && candidate.includes('.'));
  };

  urlInput.addEventListener('input', validateUrl);
  urlInput.addEventListener('blur', () => {
    if (urlInput.value.trim()) urlInput.value = normaliseUrl(urlInput.value);
    validateUrl();
  });
  validateUrl();

  customToggle?.addEventListener('click', () => {
    if (!customSize) return;
    customSize.hidden = !customSize.hidden;
    if (!customSize.hidden) customSize.querySelector<HTMLInputElement>('#width')?.focus();
  });

  // A fixed output frame only makes sense as a single viewport-sized shot —
  // a full-page capture of a 4:5 frame is not 4:5 any more. Switch the mode
  // rather than silently producing something the wrong shape.
  for (const input of form.querySelectorAll<HTMLInputElement>('#frame-chips input[name="device"]')) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      const visible = form.querySelector<HTMLInputElement>('input[name="mode"][value="visible"]');
      if (visible && !visible.checked) visible.checked = true;
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const url = normaliseUrl(urlInput.value);
    if (!url || !URL_PATTERN.test(url)) {
      showError('Enter a page URL to capture, like stripe.com/pricing');
      urlInput.focus();
      return;
    }
    urlInput.value = url;

    const data = new FormData(form);
    const payload: Record<string, string> = {};
    for (const [key, value] of data.entries()) {
      const text = String(value).trim();
      if (text) payload[key] = text;
    }
    payload.url = url;

    // FormData yields one entry per checked box, and the loop above keeps only
    // the last. The API wants them as one comma-separated value.
    const sizes = data.getAll('sizes').map(String).filter(Boolean);
    if (sizes.length) payload.sizes = sizes.join(',');
    else delete payload.sizes;
    if (!data.get('block_ads')) payload.block_ads = '0';
    if (!data.get('dark_mode')) payload.dark_mode = '0';
    if (!data.get('dismiss_consent')) payload.dismiss_consent = '0';
    if (!data.get('redact_pii')) payload.redact_pii = '0';
    // The width/height inputs only count when the custom panel is open.
    if (customSize?.hidden) {
      delete payload.width;
      delete payload.height;
    }

    const originalLabel = submit.textContent;
    submit.disabled = true;
    submit.innerHTML = '<span class="spinner"></span> Capturing…';
    form.classList.add('is-busy');

    try {
      const response = await fetch('/api/captures', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ErrorResponse | null;
        showError(body?.error?.message ?? `Capture failed (${response.status}).`);
        return;
      }

      const capture = (await response.json()) as CaptureResponse;
      if (capture.status === 'error') {
        showError(capture.error ?? 'The capture failed. Try a different URL.');
        return;
      }

      window.location.assign(`/app/c/${capture.id}`);
    } catch {
      showError('Network error — the capture was not started.');
    } finally {
      submit.disabled = false;
      submit.textContent = originalLabel;
      form.classList.remove('is-busy');
    }
  });
}
