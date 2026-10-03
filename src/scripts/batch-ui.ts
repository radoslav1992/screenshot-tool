import { batchProgress, recentLine, request, type Batch } from './batch-progress';

const root = document.querySelector<HTMLElement>('#batch-workspace');
if (root) {
  const form = document.querySelector<HTMLFormElement>('#batch-form')!;
  const status = document.querySelector<HTMLElement>('#batch-status')!;
  const errorBox = document.querySelector<HTMLElement>('#batch-error');
  /** Failures go in the alert notice; progress stays in the quiet status line. */
  const fail = (message: string) => {
    status.textContent = '';
    if (!errorBox) {
      status.textContent = message;
      return;
    }
    errorBox.textContent = message;
    errorBox.hidden = false;
  };
  const clearError = () => {
    if (errorBox) errorBox.hidden = true;
  };
  const queue = document.querySelector<HTMLOListElement>('#batch-queue')!;
  const start = document.querySelector<HTMLButtonElement>('#batch-start')!;
  const stop = document.querySelector<HTMLButtonElement>('#batch-stop')!;
  const retry = document.querySelector<HTMLButtonElement>('#batch-retry')!;
  let remaining = Number(root.dataset.remaining),
    running = false,
    stopping = false;
  /*
   * With migration 0013 a started queue becomes a background batch, sized by
   * the plan; without it, this page runs the queue itself, one page per
   * request, capped at 25.
   */
  const background = root.dataset.background === '1';
  const limit = Number(root.dataset.limit) || 25;
  const progress = background ? batchProgress() : null;
  type Job = {
    url: string;
    device: string;
    state: 'pending' | 'running' | 'done' | 'failed' | 'unknown';
    error?: string;
    id?: string;
    attached?: boolean;
  };
  let jobs: Job[] = [];
  let options: Record<string, string> = {};
  const input = () => Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
  async function post(url: string, data: Record<string, string>) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    let result: {
      error?: { message?: string };
      urls: string[];
      captures?: { id: string; files: unknown[] }[];
      failed?: { error: string }[];
    };
    try {
      result = (await response.json()) as typeof result;
    } catch {
      throw new Error('No readable response. Check the library before attempting another capture.');
    }
    if (!response.ok) throw new Error(result.error?.message ?? 'Request failed.');
    return result;
  }
  function render() {
    queue.replaceChildren();
    jobs.forEach((job) => {
      const li = document.createElement('li');
      li.className = 'project-item';
      const text = document.createElement('p');
      text.textContent = `${job.device} · ${job.url}`;
      li.appendChild(text);
      const state = document.createElement('p');
      state.className = 'small';
      // A background queue is not run here; until it is started its pages are only planned.
      const label = background && job.state === 'pending' ? 'Ready to queue' : job.state;
      state.textContent = `${label}${job.error ? ' · ' + job.error : ''}`;
      li.appendChild(state);
      if (job.id) {
        const link = document.createElement('a');
        link.href = `/app/c/${job.id}`;
        link.textContent = 'Open capture →';
        li.appendChild(link);
      }
      if (job.state === 'done' && root!.dataset.project && !job.attached) {
        const attach = document.createElement('button');
        attach.type = 'button';
        attach.className = 'btn btn--outline';
        attach.textContent = 'Retry adding to project';
        attach.disabled = running;
        attach.onclick = async () => {
          attach.disabled = true;
          try {
            await attachJob(job);
            job.error = undefined;
          } catch (e) {
            job.error = String(e);
          }
          render();
        };
        li.appendChild(attach);
      }
      queue.appendChild(li);
    });
    retry.hidden = !jobs.some((j) => j.state === 'failed');
    retry.disabled = running;
    start.disabled = running || !jobs.some((j) => j.state === 'pending');
  }
  async function attachJob(job: Job) {
    await post('/api/projects', { action: 'attach', project_id: root!.dataset.project!, asset_id: job.id! });
    job.attached = true;
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (running) return;
    if (jobs.length && !confirm('Replace this queue? Existing captures stay in your library.')) return;
    const button = document.querySelector<HTMLButtonElement>('#batch-preview')!;
    button.disabled = true;
    clearError();
    status.textContent = 'Checking pages…';
    document.querySelector<HTMLElement>('#batch-start-error')?.setAttribute('hidden', '');
    try {
      const data = input();
      const result = await post('/api/batch-preview', background ? { ...data, background: '1' } : data);
      const devices = data.launch ? ['desktop', 'mobile'] : [data.device];
      const count = result.urls.length * devices.length;
      if (count > limit)
        throw new Error(
          background
            ? `This batch needs ${count} screenshots; your plan takes up to ${limit} in one batch. Reduce the list and preview again.`
            : 'Launch checks support up to 12 URLs. Reduce the list and preview again.',
        );
      if (count > remaining)
        throw new Error(`This queue needs ${count} screenshots; ${remaining} remain. Reduce the list or upgrade.`);
      options = {
        device: data.device,
        mode: data.mode,
        format: data.format,
        hide: data.hide,
        redact_pii: data.redact_pii ?? '0',
        dark_mode: data.dark_mode ?? '0',
        block_ads: data.block_ads ?? '0',
      };
      jobs = (result.urls as string[]).flatMap((url) =>
        devices.map((device) => ({ url, device, state: 'pending' as const })),
      );
      document.querySelector<HTMLElement>('#batch-results')!.hidden = false;
      document.querySelector('#batch-cost')!.textContent =
        `${result.urls.length} pages · ${count} screenshots · ${remaining} remaining`;
      status.textContent = 'Preview ready. Settings below are fixed for this queue; preview again to apply changes.';
      // The queue's Start button is now the one primary action.
      button.classList.replace('btn--lime', 'btn--outline-ink');
      render();
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Preview failed.');
    } finally {
      button.disabled = false;
    }
  });
  /** Hands the previewed queue to the server as one background batch, then follows its progress. */
  async function startBackground() {
    if (running || !jobs.length) return;
    running = true;
    clearError();
    // Shown beside the Start button, not up in the preview panel out of sight.
    const startError = document.querySelector<HTMLElement>('#batch-start-error');
    if (startError) startError.hidden = true;
    start.disabled = true;
    status.textContent = 'Starting the batch…';
    try {
      const batch = await request<Batch & { rejected?: { url: string; error: string }[] }>('/api/batches', {
        ...options,
        urls: [...new Set(jobs.map((job) => job.url))].join('\n'),
        url_lines: '1',
        devices: [...new Set(jobs.map((job) => job.device))].join(','),
        notify: document.querySelector<HTMLInputElement>('#batch-notify')?.checked ? '1' : '0',
        ...(root!.dataset.project ? { project: root!.dataset.project } : {}),
      });
      jobs = [];
      document.querySelector<HTMLElement>('#batch-results')!.hidden = true;
      const skipped = batch.rejected?.length ?? 0;
      status.textContent =
        `Batch started: ${batch.total} capture${batch.total === 1 ? '' : 's'} queued.` +
        (skipped ? ` ${skipped} URL${skipped === 1 ? '' : 's'} could not be queued (${batch.rejected![0]!.error}).` : '') +
        ' It runs in the background — close this tab whenever you like.';
      remaining = Math.max(0, remaining - batch.shots);
      addRecent(batch);
      const params = new URLSearchParams(location.search);
      params.set('batch', batch.id);
      history.replaceState(null, '', `${location.pathname}?${params}`);
      await progress?.open(batch.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The batch could not be started.';
      status.textContent = '';
      if (startError) {
        startError.textContent = message;
        startError.hidden = false;
      } else fail(message);
    } finally {
      running = false;
      render();
    }
  }
  function addRecent(batch: Batch) {
    const list = document.querySelector<HTMLOListElement>('#batch-recent');
    if (!list) return;
    document.querySelector('#batch-recent-empty')?.remove();
    const item = document.createElement('li');
    item.className = 'project-item project-item--row';
    const text = document.createElement('div');
    text.className = 'batch-item__text';
    const name = document.createElement('p');
    name.className = 'batch-recent__label';
    name.textContent = batch.label || 'Batch';
    const line = document.createElement('p');
    line.className = 'small muted';
    line.textContent = recentLine(batch);
    text.appendChild(name);
    text.appendChild(line);
    const link = document.createElement('a');
    link.className = 'btn btn--outline btn--sm';
    link.href = `/app/batch?batch=${encodeURIComponent(batch.id)}`;
    link.textContent = 'View progress';
    item.appendChild(text);
    item.appendChild(link);
    list.insertBefore(item, list.firstChild);
  }
  async function run() {
    if (background) return startBackground();
    if (running) return;
    running = true;
    stopping = false;
    stop.disabled = false;
    form.querySelectorAll<HTMLFieldSetElement>('fieldset').forEach((f) => (f.disabled = true));
    form.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
    try {
      for (const job of jobs) {
        if (stopping) break;
        if (job.state !== 'pending') continue;
        job.state = 'running';
        job.error = undefined;
        render();
        try {
          const result = await post('/api/batch', { ...options, device: job.device, urls: job.url, url_lines: '1' });
          if (result.captures?.[0]) {
            job.id = result.captures[0].id;
            job.state = 'done';
            remaining = Math.max(0, remaining - result.captures[0].files.length);
            if (root!.dataset.project) {
              try {
                await attachJob(job);
              } catch {
                job.error =
                  'Captured successfully; project attachment failed. Retry attachment below without recapturing.';
              }
            }
          } else {
            job.state = 'failed';
            job.error = result.failed?.[0]?.error ?? 'Capture failed.';
          }
        } catch (e) {
          job.state = 'unknown';
          job.error =
            (e instanceof Error ? e.message : 'Request interrupted.') +
            ' Check the library before recapturing; this page will not be retried automatically.';
          stopping = true;
        }
        status.textContent = `${jobs.filter((j) => j.state === 'done').length}/${jobs.length} complete · ${remaining} estimated shots left`;
        render();
      }
    } finally {
      running = false;
      stop.disabled = true;
      form.querySelectorAll<HTMLFieldSetElement>('fieldset').forEach((f) => (f.disabled = false));
      form.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = false));
      render();
      status.textContent += stopping ? ' · Stopped. Pending pages can be continued.' : ' · Queue finished.';
    }
  }
  start.onclick = run;
  stop.onclick = () => {
    stopping = true;
    stop.disabled = true;
    status.textContent = 'Stopping after the current page…';
  };
  retry.onclick = () => {
    jobs.forEach((j) => {
      if (j.state === 'failed') j.state = 'pending';
    });
    void run();
  };
  const opened = new URLSearchParams(location.search).get('batch');
  if (progress && opened) void progress.open(opened);
  window.addEventListener('beforeunload', (e) => {
    if (running) {
      e.preventDefault();
    }
  });
  document.querySelector('#save-preset')?.addEventListener('click', async () => {
    const button = document.querySelector<HTMLButtonElement>('#save-preset')!;
    button.disabled = true;
    clearError();
    try {
      const data = input();
      await post('/api/projects', {
        ...data,
        redact_pii: data.redact_pii ?? '0',
        dark_mode: data.dark_mode ?? '0',
        block_ads: data.block_ads ?? '0',
        action: 'preset',
        project_id: root!.dataset.project!,
        name: document.querySelector<HTMLInputElement>('#preset-name')!.value,
      });
      status.textContent = 'Capture settings saved to this project. URLs and credentials are not saved.';
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Could not save settings.');
    } finally {
      button.disabled = false;
    }
  });
}
