import { formatDateTime } from '../lib/dates';

/**
 * The progress view of a background batch on /app/batch: counts, a bar, and
 * each page's state, kept current by polling GET /api/batches/:id. After the
 * first answer only what changed is fetched (`changed_since`), so a batch of
 * hundreds of pages costs a few hundred bytes a poll rather than all of it.
 */

export type BatchStatus = 'queued' | 'running' | 'done' | 'cancelled';
type ItemStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface Batch {
  id: string;
  status: BatchStatus;
  label: string;
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Screenshots reserved for it. */
  shots: number;
  created_at: string;
  completed_at: string | null;
}

interface Item {
  id: string;
  display_url: string;
  device: string;
  status: ItemStatus;
  capture_id: string;
  error?: string;
}

interface Detail extends Batch {
  items: Item[];
  as_of: string;
}

/** While the tab is visible; a hidden tab looks less often. */
const POLL_MS = 3_000;
const HIDDEN_POLL_MS = 15_000;
const RETRY_MS = 10_000;

const ITEM_LABEL: Record<ItemStatus, string> = {
  queued: 'Waiting',
  running: 'Capturing…',
  done: 'Captured',
  error: 'Failed',
  cancelled: 'Cancelled',
};

const BATCH_LABEL: Record<BatchStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Finished',
  cancelled: 'Cancelled',
};

/** A problem answer: its own message, and the status that says whether trying again could help. */
export class RequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** JSON in, JSON out; a problem's own message becomes the error. */
export async function request<T>(url: string, body?: Record<string, string>): Promise<T> {
  const response = await fetch(
    url,
    body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { headers: { accept: 'application/json' } },
  );
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error('No readable response. Try again in a moment.');
  }
  if (!response.ok) {
    throw new RequestError(
      (result as { error?: { message?: string } })?.error?.message ?? 'Request failed.',
      response.status,
    );
  }
  return result as T;
}

/** One line for the recent-batches list, the same words the server renders. */
export function recentLine(batch: Batch): string {
  return (
    `${BATCH_LABEL[batch.status]} · ${batch.done} of ${batch.total} captured` +
    (batch.failed ? ` · ${batch.failed} failed` : '') +
    (batch.cancelled ? ` · ${batch.cancelled} cancelled` : '') +
    ` · ${formatDateTime(batch.created_at)}`
  );
}

export function batchProgress() {
  const section = document.querySelector<HTMLElement>('#batch-progress');
  if (!section) return null;
  const label = section.querySelector<HTMLElement>('#batch-progress-label')!;
  const status = section.querySelector<HTMLElement>('#batch-progress-status')!;
  const bar = section.querySelector<HTMLElement>('#batch-progress-bar')!;
  const fill = bar.querySelector<HTMLElement>('.batch-bar__fill')!;
  const counts = section.querySelector<HTMLElement>('#batch-progress-counts')!;
  const errorBox = section.querySelector<HTMLElement>('#batch-progress-error')!;
  const cancel = section.querySelector<HTMLButtonElement>('#batch-cancel')!;
  const list = section.querySelector<HTMLOListElement>('#batch-progress-items')!;

  let current: { id: string; asOf: string | null; nodes: Map<string, HTMLLIElement>; batch?: Batch } | null = null;
  let timer: number | undefined;

  function summary(batch: Batch): string {
    const finished = batch.done + batch.failed;
    if (batch.status === 'queued') return `Waiting to start · ${batch.total} captures. Batches usually start within a minute.`;
    if (batch.status === 'running') return `${finished} of ${batch.total} finished · runs in the background, so you can close this tab.`;
    if (batch.status === 'cancelled') return `Cancelled · ${batch.done} captured before it stopped.`;
    return (
      `Finished ${formatDateTime(batch.completed_at)} · ${batch.done} captured` +
      (batch.failed ? `, ${batch.failed} failed.` : '.')
    );
  }

  function renderBatch(batch: Batch) {
    label.textContent = batch.label || 'Batch progress';
    status.textContent = summary(batch);
    const finished = batch.done + batch.failed + batch.cancelled;
    bar.setAttribute('aria-valuemax', String(batch.total));
    bar.setAttribute('aria-valuenow', String(finished));
    fill.style.width = `${batch.total ? Math.round((finished / batch.total) * 100) : 0}%`;
    counts.replaceChildren(
      ...(
        [
          ['Captured', batch.done],
          ['Capturing', batch.running],
          ['Waiting', batch.queued],
          ['Failed', batch.failed],
          ['Cancelled', batch.cancelled],
        ] as const
      )
        .filter(([name, value]) => value > 0 || name === 'Captured')
        .map(([name, value]) => {
          const entry = document.createElement('div');
          const term = document.createElement('dt');
          term.textContent = name;
          const count = document.createElement('dd');
          count.textContent = value.toLocaleString();
          entry.appendChild(term);
          entry.appendChild(count);
          return entry;
        }),
    );
    cancel.hidden = batch.queued === 0;
  }

  function renderItem(node: HTMLLIElement, item: Item) {
    const text = document.createElement('div');
    text.className = 'batch-item__text';
    const page = document.createElement('p');
    page.textContent = `${item.device} · ${item.display_url}`;
    const state = document.createElement('p');
    state.className = `small batch-state--${item.status}`;
    state.textContent = `${ITEM_LABEL[item.status]}${item.error ? ` · ${item.error}` : ''}`;
    text.appendChild(page);
    text.appendChild(state);
    node.replaceChildren(text);
    if (item.status === 'done') {
      const link = document.createElement('a');
      link.className = 'batch-item__link';
      link.href = `/app/c/${encodeURIComponent(item.capture_id)}`;
      link.textContent = 'Open capture →';
      node.appendChild(link);
    }
  }

  function schedule(ms: number) {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), ms);
  }

  async function refresh() {
    if (!current) return;
    const open = current;
    try {
      const query = open.asOf ? `?changed_since=${encodeURIComponent(open.asOf)}` : '';
      const detail = await request<Detail>(`/api/batches/${encodeURIComponent(open.id)}${query}`);
      if (current !== open) return;
      errorBox.hidden = true;
      for (const item of detail.items) {
        let node = open.nodes.get(item.id);
        if (!node) {
          node = document.createElement('li');
          node.className = 'project-item project-item--row';
          open.nodes.set(item.id, node);
          list.appendChild(node);
        }
        renderItem(node, item);
      }
      open.asOf = detail.as_of;
      open.batch = detail;
      renderBatch(detail);
      if (detail.status === 'queued' || detail.status === 'running') {
        schedule(document.hidden ? HIDDEN_POLL_MS : POLL_MS);
      }
    } catch (error) {
      if (current !== open) return;
      const message = error instanceof Error ? error.message : 'The batch could not be read.';
      // A batch that is not there (or not yours) will not appear by asking again;
      // a dropped connection or a busy database might.
      const final = error instanceof RequestError && error.status >= 400 && error.status < 500 && error.status !== 429;
      if (final) status.textContent = '';
      errorBox.textContent = final ? message : `${message} Retrying…`;
      errorBox.hidden = false;
      if (!final) schedule(RETRY_MS);
    }
  }

  cancel.addEventListener('click', async () => {
    if (!current) return;
    if (!confirm('Cancel the pages that have not started? Their screenshots are refunded; finished captures stay in your library.')) return;
    const open = current;
    cancel.disabled = true;
    try {
      await request(`/api/batches/${encodeURIComponent(open.id)}`, { action: 'cancel' });
      // Everything that was waiting just changed; read it all again.
      open.asOf = null;
      await refresh();
    } catch (error) {
      errorBox.textContent = error instanceof Error ? error.message : 'The batch could not be cancelled.';
      errorBox.hidden = false;
    } finally {
      cancel.disabled = false;
    }
  });

  // A tab coming back to the front should not wait out a slow hidden-tab poll.
  document.addEventListener('visibilitychange', () => {
    const batch = current?.batch;
    if (!document.hidden && batch && (batch.status === 'queued' || batch.status === 'running')) schedule(0);
  });

  return {
    /** Shows a batch, replacing whatever was shown, and keeps it current until it finishes. */
    async open(id: string) {
      window.clearTimeout(timer);
      current = { id, asOf: null, nodes: new Map() };
      list.replaceChildren();
      counts.replaceChildren();
      errorBox.hidden = true;
      cancel.hidden = true;
      label.textContent = 'Batch progress';
      status.textContent = 'Loading…';
      section.hidden = false;
      await refresh();
    },
  };
}
