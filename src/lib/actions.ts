import { badRequest } from './http';

/**
 * A short list of things to do to a page before photographing it.
 *
 * The most common reason a capture is unusable is not the renderer: it is a
 * consent dialog, a newsletter modal or a chat bubble sitting on top of the
 * thing someone wanted. Hiding those with CSS works when you know the selector;
 * this is for when the page needs to be *used* first — accept, wait, scroll,
 * then shoot.
 *
 * Deliberately not a scripting language. Four verbs, no expressions, no loops:
 * enough to get past a dialog, and nothing that turns a capture request into
 * code execution with an unbounded runtime.
 */

export type ActionKind = 'click' | 'wait_for' | 'wait' | 'scroll_to' | 'type';

export interface Action {
  kind: ActionKind;
  /** A selector for every verb except `wait`, which carries a duration. */
  value: string;
  /** Text for `type`. */
  text?: string;
}

/** More than this and it is automation, not a capture. */
const MAX_ACTIONS = 10;
const MAX_WAIT_MS = 10_000;

/**
 * Accepts either a JSON array of `{kind, value}` or the compact form
 * `click:.accept-all; wait_for:#content; scroll_to:footer`, because most of
 * these are typed by hand into a form field or a curl flag.
 */
export function parseActions(input: string | undefined): Action[] {
  const raw = (input ?? '').trim();
  if (!raw) return [];

  let entries: Array<Record<string, unknown>>;

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      entries = parsed as Array<Record<string, unknown>>;
    } catch {
      throw badRequest('`actions` must be a JSON array or a `verb:selector` list.', 'actions');
    }
  } else {
    entries = raw
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const at = part.indexOf(':');
        if (at < 0) throw badRequest(`\`${part}\` is not a \`verb:value\` pair.`, 'actions');
        return { kind: part.slice(0, at).trim(), value: part.slice(at + 1).trim() };
      });
  }

  if (entries.length > MAX_ACTIONS) {
    throw badRequest(`\`actions\` takes at most ${MAX_ACTIONS} steps.`, 'actions');
  }

  return entries.map((entry) => {
    const kind = String(entry.kind ?? '').toLowerCase() as ActionKind;
    const value = String(entry.value ?? '').trim();

    if (!['click', 'wait_for', 'wait', 'scroll_to', 'type'].includes(kind)) {
      throw badRequest(`\`${kind}\` is not an action. Use click, wait_for, wait, scroll_to or type.`, 'actions');
    }
    if (!value) throw badRequest(`The \`${kind}\` action needs a value.`, 'actions');
    if (value.length > 200) throw badRequest(`The \`${kind}\` value is too long.`, 'actions');

    if (kind === 'wait') {
      const ms = Number.parseInt(value, 10);
      if (!Number.isFinite(ms) || ms < 0 || ms > MAX_WAIT_MS) {
        throw badRequest(`\`wait\` takes milliseconds, 0–${MAX_WAIT_MS}.`, 'actions');
      }
    }

    const text = entry.text === undefined ? undefined : String(entry.text).slice(0, 200);
    if (kind === 'type' && !text) throw badRequest('The `type` action needs `text`.', 'actions');

    return { kind, value, ...(text ? { text } : {}) };
  });
}

/**
 * Selectors and button labels that dismiss a consent dialog on most sites.
 *
 * Ordered by how sure we are: an explicit accept-all id first, then the common
 * framework classes, then text. Only the first match is clicked — several of
 * these can be present at once, and clicking them all risks hitting "reject"
 * after "accept", or a link that navigates away.
 */
export const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '.cc-btn.cc-allow',
  '.fc-cta-consent',
  'button[aria-label*="accept" i]',
  'button[title*="accept" i]',
  '[data-testid="cookie-accept"]',
  '[id*="accept-cookies" i]',
  '[class*="accept-all" i]',
];

/** Button text that means yes, in the languages this service sees most. */
export const CONSENT_TEXTS = [
  'accept all',
  'accept cookies',
  'allow all',
  'i agree',
  'agree',
  'accept',
  'got it',
  'ok',
  'приемам',
  'съгласен',
  'akzeptieren',
  'tout accepter',
  'aceptar',
];

/**
 * Runs in the page: clicks the first thing that looks like consent.
 *
 * Import-free — serialised into the page like the other `-fn` bodies. Returns
 * what it clicked so a caller can see whether the dialog was the reason a
 * capture looked wrong.
 */
export function dismissConsentInPage(selectors: string[], texts: string[]): string | null {
  const clickable = (node: Element | null): HTMLElement | null => {
    if (!node) return null;
    const element = node as HTMLElement;
    const box = element.getBoundingClientRect();
    // A zero-sized or hidden control is a leftover from another consent
    // library, not the dialog actually on screen.
    if (box.width < 4 || box.height < 4) return null;
    if (getComputedStyle(element).visibility === 'hidden') return null;
    return element;
  };

  for (const selector of selectors) {
    try {
      const target = clickable(document.querySelector(selector));
      if (target) {
        target.click();
        return selector;
      }
    } catch {
      /* an invalid selector should not stop the rest */
    }
  }

  const buttons = [...document.querySelectorAll('button, [role="button"], a')].slice(0, 400);
  for (const text of texts) {
    for (const node of buttons) {
      const label = (node.textContent ?? '').trim().toLowerCase();
      // Exact-ish match only: "accept" must not fire on "accept our terms of
      // service and privacy policy", which is usually a link away from the page.
      if (label === text || label === `${text} cookies`) {
        const target = clickable(node);
        if (target) {
          target.click();
          return `text:${text}`;
        }
      }
    }
  }

  return null;
}
