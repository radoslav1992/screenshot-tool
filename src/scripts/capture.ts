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
    customToggle?.setAttribute('aria-expanded', String(!customSize.hidden));
    updateSummary();
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

  const presetButtons = document.querySelectorAll<HTMLButtonElement>('[data-capture-preset]');
  const hint = document.getElementById('preset-hint');
  const summary = document.getElementById('capture-summary');
  const presets: Record<string, { device: string; mode: string; redact: boolean; hint: string }> = {
    review: {
      device: 'desktop',
      mode: 'fullpage',
      redact: false,
      hint: 'Full-page desktop capture for reviews and client handoffs.',
    },
    mobile: {
      device: 'mobile',
      mode: 'fullpage',
      redact: false,
      hint: 'See the whole page as a mobile visitor would.',
    },
    social: {
      device: 'instagram-post',
      mode: 'visible',
      redact: false,
      hint: 'A 1080 × 1350 image, ready for a portrait post.',
    },
    private: {
      device: 'desktop',
      mode: 'fullpage',
      redact: true,
      hint: 'Common personal details will be masked. Always review the result before sharing.',
    },
  };
  function updateSummary() {
    const device = form!.querySelector<HTMLInputElement>('input[name="device"]:checked');
    const mode = form!.querySelector<HTMLInputElement>('input[name="mode"]:checked');
    const format = (form!.querySelector('#format') as HTMLSelectElement | null)?.value.toUpperCase();
    const deviceName =
      device?.closest('label')?.querySelector('.device__name')?.textContent ??
      device?.closest('label')?.querySelector('span')?.textContent ??
      device?.value;
    const modeName = mode?.closest('label')?.querySelector('.mode__name')?.textContent ?? mode?.value;
    const width = form!.querySelector<HTMLInputElement>('#width')?.value;
    const height = form!.querySelector<HTMLInputElement>('#height')?.value;
    const custom = !customSize?.hidden && width && height ? `Custom ${width} × ${height}` : deviceName;
    const redact = form!.querySelector<HTMLInputElement>('[name="redact_pii"]')?.checked;
    const quotaLine = form!.querySelector<HTMLElement>('#quota-line');
    if (quotaLine) {
      quotaLine.dataset.original ??= quotaLine.textContent ?? '';
      quotaLine.textContent = mode?.value === 'series'
        ? 'Uses one screenshot per frame in the scroll series.'
        : quotaLine.dataset.original;
    }
    if (summary)
      summary.textContent = [custom, modeName, format, redact ? 'Personal detail masking' : '']
        .filter(Boolean)
        .join(' · ');
  }
  for (const button of presetButtons) {
    button.addEventListener('click', () => {
      const preset = presets[button.dataset.capturePreset ?? ''];
      if (!preset || (submit.disabled && form.classList.contains('is-busy'))) return;
      for (const other of presetButtons) other.setAttribute('aria-pressed', String(other === button));
      for (const [name, value] of [
        ['device', preset.device],
        ['mode', preset.mode],
      ]) {
        const radio = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
        if (radio) radio.checked = true;
      }
      const redact = form.querySelector<HTMLInputElement>('[name="redact_pii"]');
      if (redact) redact.checked = preset.redact;
      if (customSize) customSize.hidden = true;
      customToggle?.setAttribute('aria-expanded', 'false');
      if (hint) hint.textContent = preset.hint;
      updateSummary();
    });
  }
  form.addEventListener('change', () => {
    for (const button of presetButtons) button.setAttribute('aria-pressed', 'false');
    if (hint) hint.textContent = 'Using your custom settings.';
    updateSummary();
  });
  form.addEventListener('input', updateSummary);
  updateSummary();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
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
    if (!data.get('block_ads')) payload.block_ads = '0';
    if (!data.get('dark_mode')) payload.dark_mode = '0';
    // The width/height inputs only count when the custom panel is open.
    if (customSize?.hidden) {
      delete payload.width;
      delete payload.height;
    }

    const originalLabel = submit.innerHTML;
    const controls = Array.from(form.querySelectorAll('input, select, button')) as Array<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >;
    const disabledStates = controls.map((control) => control.disabled);
    controls.forEach((control) => {
      control.disabled = true;
    });
    form.setAttribute('aria-busy', 'true');
    submit.disabled = true;
    submit.innerHTML = '<span class="spinner"></span> Capturing…';
    form.classList.add('is-busy');

    try {
      const response = await fetch('/api/captures', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
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
      showError('Connection lost. Check your library before retrying; the capture may already have started.');
    } finally {
      controls.forEach((control, index) => {
        control.disabled = disabledStates[index];
      });
      submit.innerHTML = originalLabel;
      form.setAttribute('aria-busy', 'false');
      form.classList.remove('is-busy');
    }
  });
}
