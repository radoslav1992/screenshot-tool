/**
 * What changed on a page, in words.
 *
 * A pixel diff says a page moved and by how much. It cannot say a price went
 * from $19 to $29, which is the thing anyone actually wants from a change
 * alert. This works on the visible text captured with each run, so the answer
 * is quotable: these lines went, those arrived.
 */

export interface TextChange {
  added: string[];
  removed: string[];
  /** True when both sides were present and neither was empty. */
  comparable: boolean;
}

/** Longer than this and the comparison stops being worth the CPU. */
const MAX_LINES = 400;

/**
 * Visible text arrives as one long run. Splitting on sentence-ish boundaries
 * gives units small enough to be quoted in an email and large enough that a
 * reflowed paragraph does not read as a hundred separate changes.
 */
export function toLines(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?:;])\s+|\s{2,}|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 2)
    .slice(0, MAX_LINES);
}

/**
 * Set difference rather than a positional diff.
 *
 * A page that reorders its sections has not changed its content, and a
 * positional diff would report every line as both removed and added. What a
 * change alert should report is what is now there that was not, and what is
 * gone — which is exactly the symmetric difference.
 */
export function diffText(before: string, after: string): TextChange {
  const beforeLines = toLines(before);
  const afterLines = toLines(after);

  if (!beforeLines.length || !afterLines.length) {
    return { added: [], removed: [], comparable: false };
  }

  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);

  return {
    added: afterLines.filter((line) => !beforeSet.has(line)),
    removed: beforeLines.filter((line) => !afterSet.has(line)),
    comparable: true,
  };
}

/** A short, plain rendering for an email when no model is available. */
export function describeChange(change: TextChange, limit = 4): string {
  if (!change.comparable) return '';
  const parts: string[] = [];
  if (change.added.length) {
    parts.push(`New:\n${change.added.slice(0, limit).map((line) => `  + ${line}`).join('\n')}`);
  }
  if (change.removed.length) {
    parts.push(`Gone:\n${change.removed.slice(0, limit).map((line) => `  − ${line}`).join('\n')}`);
  }
  const extra = Math.max(0, change.added.length - limit) + Math.max(0, change.removed.length - limit);
  if (extra) parts.push(`…and ${extra} more line${extra === 1 ? '' : 's'}.`);
  return parts.join('\n\n');
}
