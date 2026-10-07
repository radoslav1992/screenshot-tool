/**
 * Installing the app, shared by the install hint on the workspace screens and
 * the Account screen's row. Base.astro keeps the browser's install prompt in
 * `window.__escInstallPrompt` and announces it with `esc:installable`.
 *
 * The decisions are pure functions of what the browser says about itself, so
 * they can be checked without one (scripts/web-push-check.mjs).
 */

export interface InstallEnvironment {
  /** Already running as an installed app. */
  standalone: boolean;
  /** Chromium handed over a `beforeinstallprompt` that has not been used. */
  canPrompt: boolean;
  /** Safari on iPhone or iPad, where Add to Home Screen is how to install. */
  iosSafari: boolean;
  /** Closed on this device before. */
  dismissed: boolean;
}

export type InstallHint = 'prompt' | 'ios' | null;

/** Which hint, if any: a button where the browser can install, instructions on iOS Safari, nothing elsewhere. */
export function installHint(environment: InstallEnvironment): InstallHint {
  if (environment.standalone || environment.dismissed) return null;
  if (environment.canPrompt) return 'prompt';
  if (environment.iosSafari) return 'ios';
  return null;
}

/** iPadOS asks for desktop pages and says Macintosh; only the touch screen gives it away. */
export function isIOS(userAgent: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** Safari itself, not another browser's or another app's view of the web, which cannot add to the Home Screen. */
export function isIOSSafari(userAgent: string, maxTouchPoints = 0): boolean {
  return (
    isIOS(userAgent, maxTouchPoints) &&
    /Safari\//.test(userAgent) &&
    !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|GSA\/|Instagram|FBAN|FBAV|Line\//.test(userAgent)
  );
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

const DISMISSED_KEY = 'esc:install-hint-dismissed';

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissInstallHint(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    /* private mode: it comes back next time, which is fine */
  }
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const storedPrompt = () => (window as Window & { __escInstallPrompt?: InstallPromptEvent | null }).__escInstallPrompt ?? null;

export function installEnvironment(options: { ignoreDismissed?: boolean } = {}): InstallEnvironment {
  return {
    standalone: isStandalone(),
    canPrompt: Boolean(storedPrompt()),
    iosSafari: isIOSSafari(navigator.userAgent, navigator.maxTouchPoints),
    dismissed: options.ignoreDismissed ? false : dismissed(),
  };
}

/** Shows the browser's own install dialog. A prompt can be used once, so it is forgotten either way. */
export async function promptInstall(): Promise<boolean> {
  const prompt = storedPrompt();
  if (!prompt) return false;
  (window as Window & { __escInstallPrompt?: InstallPromptEvent | null }).__escInstallPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice.catch(() => null);
  document.dispatchEvent(new CustomEvent('esc:install-changed'));
  return choice?.outcome === 'accepted';
}

/** Runs `update` now and whenever installing becomes possible, happens, or is used up. */
export function watchInstall(update: () => void): void {
  for (const name of ['esc:installable', 'esc:install-changed']) document.addEventListener(name, update);
  window.addEventListener('appinstalled', update);
  update();
}
