import { badRequest } from './http';
import type { PageFacts } from './page-facts';
import { parseIgnoreRegions } from './ignore-regions';
export interface MonitorRule { kind: string; phrase: string; selector: string; region: string }
export const defaultRule: MonitorRule = { kind: 'visual', phrase: '', selector: '', region: '' };
export function parseMonitorRule(body: Record<string,string>): MonitorRule {
 const kind = body.rule_kind || 'visual';
 if (!['visual','text','appeared','disappeared','price','element'].includes(kind)) throw badRequest('Choose a valid alert rule.');
 const phrase = (body.rule_phrase || '').trim();
 const selector = (body.rule_selector || '').trim();
 if (phrase.length > 200 || selector.length > 200) throw badRequest('Rule text must be 200 characters or fewer.');
 if (['appeared','disappeared'].includes(kind) && !phrase) throw badRequest('Enter a phrase to watch.');
 if (['element','price'].includes(kind) && !selector) throw badRequest('Enter the CSS selector of the element to watch.');
 const region = body.watch_region || '';
 if (parseIgnoreRegions(region).length > 1) throw badRequest('Choose one watched region.');
 return { kind, phrase, selector, region };
}
export function evaluateRule(rule: MonitorRule, before: PageFacts | null, after: PageFacts | null): { changed: boolean; detail: string } {
 const normalize = (s: string) => s.replace(/\s+/g,' ').trim();
 if (!before || !after) throw new Error('Page text unavailable. The previous baseline has been kept.');
 if (typeof before.text !== 'string' || typeof after.text !== 'string') throw new Error('Page text unavailable.');
 let a = normalize(before.text), b = normalize(after.text);
 if (['price','element'].includes(rule.kind)) {
  if (before.monitored_element?.selector !== rule.selector || after.monitored_element?.selector !== rule.selector)
   return { changed: false, detail: 'Saved the first baseline for this element rule.' };
  if (!before.monitored_element.found || !after.monitored_element.found) throw new Error('Watched element was not found. Check its CSS selector.');
  a = normalize(before.monitored_element.text); b = normalize(after.monitored_element.text);
  if (rule.kind === 'element') return a !== b ? { changed: true, detail: `The watched element changed: ${a.slice(0,100)} → ${b.slice(0,100)}` } : unchanged;
 }
 if (rule.kind === 'price') {
  const numbers = (s: string) => s.match(/\d+(?:[.,\s\u00a0]\d+)*/g)?.map(n=>n.trim()).join('|');
  const x = numbers(a), y = numbers(b);
  if (!x || !y) throw new Error('No numeric price found in the selected element. Choose a price-only element.');
  return x !== y ? { changed: true, detail: `Price changed: ${a.slice(0,100)} → ${b.slice(0,100)}` } : unchanged;
 }
 /*
  * The stored text stops at 8,000 characters. The hash covers all of it, so a
  * change further down still counts, and a page known to be unchanged is not
  * second-guessed from its excerpt.
  */
 const hashed = Boolean(before.text_hash && after.text_hash);
 if (hashed && before.text_hash === after.text_hash) return unchanged;
 if (rule.kind === 'appeared' || rule.kind === 'disappeared') {
  const phrase = normalize(rule.phrase);
  const was = contains(before, a, phrase), is = contains(after, b, phrase);
  const changed = rule.kind === 'appeared' ? !was.found && is.found : was.found && !is.found;
  if (!changed) return unchanged;
  /*
   * Only an absence can be an artefact of the excerpt. Checks now answer each
   * phrase against the whole page, so an absence read from the excerpt is a
   * baseline taken before that — alerting on it would announce a phrase that
   * was there all along. Stay quiet once; the next comparison is exact.
   */
  if ((rule.kind === 'appeared' ? was : is).partial) {
   return { changed: false, detail: `Only the first 8,000 characters could be checked for “${phrase}”; the next check covers the whole page.` };
  }
  return { changed, detail: rule.kind === 'appeared' ? `“${phrase}” appeared on the page.` : `“${phrase}” is no longer on the page.` };
 }
 return hashed || a !== b ? { changed: true, detail: 'The page text changed.' } : unchanged;
}
const unchanged = { changed: false, detail: 'No matching rule change.' };
/**
 * Whether a capture's text contains a phrase. A capture that checked the
 * phrase against its whole text answers exactly; otherwise only the stored
 * excerpt can be searched, and a miss on a page longer than it is partial.
 */
function contains(facts: PageFacts, text: string, phrase: string): { found: boolean; partial: boolean } {
 const key = phrase.toLowerCase();
 const recorded = Object.entries(facts.phrases ?? {}).find(([name]) => name.replace(/\s+/g,' ').trim().toLowerCase() === key);
 if (recorded) return { found: recorded[1] === true, partial: false };
 const found = text.toLowerCase().includes(key);
 return { found, partial: !found && (facts.text_length ?? 0) > facts.text.length };
}
