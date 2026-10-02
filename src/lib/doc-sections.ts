export interface DocEntry {
  id: string;
  title: string;
  /** Fixed label, e.g. "00" for a preamble that must not shift clause numbers. */
  num?: string;
}

export type NumberedEntry = DocEntry & { num: string };

/**
 * Number a page's sections in the order listed — entries with a fixed `num`
 * keep it and do not advance the count — and index them by id.
 */
export function docSections<const T extends readonly DocEntry[]>(entries: T) {
  let count = 0;
  const list: NumberedEntry[] = entries.map((entry) => ({
    ...entry,
    num: entry.num ?? String(++count).padStart(2, '0'),
  }));
  const byId = Object.fromEntries(list.map((entry) => [entry.id, entry])) as Record<T[number]['id'], NumberedEntry>;
  return { list, byId };
}
