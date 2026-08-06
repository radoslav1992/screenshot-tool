/** Shared behaviour for the login and signup forms. */

function showError(selector: string, message: string): void {
  const box = document.querySelector<HTMLElement>(selector);
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function wireAuthForm(formSelector: string, errorSelector: string): void {
  const form = document.querySelector<HTMLFormElement>(formSelector);
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const box = document.querySelector<HTMLElement>(errorSelector);
    if (box) box.hidden = true;

    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');

    if (!email.includes('@')) {
      showError(errorSelector, 'Enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      showError(errorSelector, 'Passwords are at least 8 characters.');
      return;
    }

    const originalLabel = submit?.textContent ?? '';
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'One moment…';
    }

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(data.entries())),
      });
      const payload = (await response.json().catch(() => null)) as
        | { redirect?: string; error?: { message?: string } }
        | null;

      if (!response.ok) {
        showError(errorSelector, payload?.error?.message ?? 'Something went wrong. Try again.');
        return;
      }

      window.location.assign(payload?.redirect || '/app');
    } catch {
      showError(errorSelector, 'Network error — check your connection and try again.');
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = originalLabel;
      }
    }
  });
}

export function wirePasswordToggles(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-toggle-password]')) {
    button.addEventListener('click', () => {
      const input = document.querySelector<HTMLInputElement>(button.dataset.togglePassword!);
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
  }
}

/**
 * The mockups include Google and GitHub buttons. No OAuth provider is
 * configured yet, so say so plainly instead of failing silently.
 */
export function wireOauthPlaceholders(errorSelector: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-oauth]')) {
    button.addEventListener('click', () => {
      showError(errorSelector, `${button.dataset.oauth} sign-in isn't connected yet — use your email and password below.`);
    });
  }
}
