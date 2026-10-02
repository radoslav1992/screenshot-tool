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
 }
 let changed = a !== b;
 if (rule.kind === 'appeared') changed = !a.toLowerCase().includes(rule.phrase.toLowerCase()) && b.toLowerCase().includes(rule.phrase.toLowerCase());
 if (rule.kind === 'disappeared') changed = a.toLowerCase().includes(rule.phrase.toLowerCase()) && !b.toLowerCase().includes(rule.phrase.toLowerCase());
 if (rule.kind === 'price') {
  const numbers = (s: string) => s.match(/\d+(?:[.,\s\u00a0]\d+)*/g)?.map(n=>n.trim()).join('|');
  const x = numbers(a), y = numbers(b);
  if (!x || !y) throw new Error('No numeric price found in the selected element. Choose a price-only element.');
  changed = x !== y;
 }
 return { changed, detail: changed ? `${rule.kind} rule matched: ${a.slice(0,100)} → ${b.slice(0,100)}` : 'No matching rule change.' };
}
