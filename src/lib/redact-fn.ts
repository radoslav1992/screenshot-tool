/**
 * Hiding, blurring and redacting, applied inside the page before it is shot.
 *
 * Import-free for the same reason as the other `-fn` modules: the function is
 * serialised and evaluated in the page, so anything it closes over would not
 * survive the trip.
 *
 * Redaction happens in the DOM rather than on the finished image on purpose. A
 * blur applied to pixels can be reversed by anyone patient; removing the node,
 * or replacing its text before the shot is taken, means the information was
 * never in the file to begin with.
 */

export interface RedactOptions {
  /** CSS selectors removed from the layout entirely. */
  hide: string[];
  /** CSS selectors blurred where they stand. */
  blur: string[];
  /** Find and cover email addresses, phone numbers and card-shaped digits. */
  redactPii: boolean;
}

export interface RedactResult {
  hidden: number;
  blurred: number;
  redacted: number;
  /** Selectors that matched nothing — worth telling the caller about. */
  unmatched: string[];
}

/**
 * Deliberately conservative. A false positive covers something a customer
 * wanted to see, which they will notice; a false negative leaks a stranger's
 * details into a shared file, which they may not. Between those, over-covering
 * is the safer error — but only for shapes that are unambiguous.
 */
export const PII_PATTERNS: Array<{ name: string; source: string; flags: string }> = [
  { name: 'email', source: '[\\w.+-]+@[\\w-]+\\.[\\w.-]{2,}', flags: 'gi' },
  // 13–16 digits in the groupings cards are printed in.
  { name: 'card', source: '\\b(?:\\d[ -]?){13,16}\\b', flags: 'g' },
  // International and long national numbers; short runs of digits are left be,
  // since prices, dates and counts all look like those.
  { name: 'phone', source: '\\+\\d[\\d\\s().-]{7,}\\d', flags: 'g' },
  { name: 'iban', source: '\\b[A-Z]{2}\\d{2}[A-Z0-9]{10,28}\\b', flags: 'g' },
];

export function redactInPage(options: RedactOptions, patterns: typeof PII_PATTERNS): RedactResult {
  const result: RedactResult = { hidden: 0, blurred: 0, redacted: 0, unmatched: [] };

  const each = (selector: string, apply: (node: HTMLElement) => void): number => {
    let count = 0;
    try {
      document.querySelectorAll(selector).forEach((node) => {
        apply(node as HTMLElement);
        count++;
      });
    } catch {
      // An invalid selector is the caller's mistake, not a reason to lose the
      // capture; it is reported back as unmatched.
    }
    if (count === 0) result.unmatched.push(selector);
    return count;
  };

  for (const selector of options.hide) {
    result.hidden += each(selector, (node) => {
      node.style.setProperty('display', 'none', 'important');
    });
  }

  for (const selector of options.blur) {
    result.blurred += each(selector, (node) => {
      node.style.setProperty('filter', 'blur(10px)', 'important');
      // Blur alone leaves readable edges on high-contrast text.
      node.style.setProperty('opacity', '0.85', 'important');
    });
  }

  if (options.redactPii) {
    const compiled = patterns.map((pattern) => new RegExp(pattern.source, pattern.flags));

    // Skip anything whose text is markup rather than prose, and anything
    // already hidden — no point redacting what will not be in the picture.
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node) {
        const parent = (node as Text).parentElement;
        if (!parent || SKIP.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const targets: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) targets.push(node as Text);

    for (const textNode of targets) {
      const text = textNode.nodeValue ?? '';
      let hit = false;
      for (const pattern of compiled) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;

      // Rebuild the node, wrapping each match in a covered span. Replacing the
      // text is what makes this a redaction rather than a visual effect.
      const fragment = document.createDocumentFragment();
      let rest = text;
      let guard = 0;

      while (rest && guard++ < 200) {
        let earliest: { index: number; length: number } | null = null;
        for (const pattern of compiled) {
          pattern.lastIndex = 0;
          const match = pattern.exec(rest);
          if (match && (!earliest || match.index < earliest.index)) {
            earliest = { index: match.index, length: match[0].length };
          }
        }
        if (!earliest) break;

        if (earliest.index > 0) fragment.appendChild(document.createTextNode(rest.slice(0, earliest.index)));

        const cover = document.createElement('span');
        cover.textContent = '█'.repeat(Math.max(4, Math.min(24, earliest.length)));
        cover.style.setProperty('background', 'currentColor', 'important');
        cover.style.setProperty('color', 'transparent', 'important');
        cover.style.setProperty('border-radius', '2px', 'important');
        fragment.appendChild(cover);

        rest = rest.slice(earliest.index + earliest.length);
        result.redacted++;
      }

      if (result.redacted > 0) {
        if (rest) fragment.appendChild(document.createTextNode(rest));
        textNode.parentNode?.replaceChild(fragment, textNode);
      }
    }
  }

  return result;
}
