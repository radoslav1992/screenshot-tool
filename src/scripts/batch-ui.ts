const root = document.querySelector<HTMLElement>('#batch-workspace');
if (root) {
  const form = document.querySelector<HTMLFormElement>('#batch-form')!;
  const status = document.querySelector<HTMLElement>('#batch-status')!;
  const queue = document.querySelector<HTMLOListElement>('#batch-queue')!;
  const start = document.querySelector<HTMLButtonElement>('#batch-start')!;
  const stop = document.querySelector<HTMLButtonElement>('#batch-stop')!;
  const retry = document.querySelector<HTMLButtonElement>('#batch-retry')!;
  let remaining = Number(root.dataset.remaining),
    running = false,
    stopping = false;
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
      state.textContent = `${job.state}${job.error ? ' · ' + job.error : ''}`;
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
    status.textContent = 'Checking pages…';
    try {
      const data = input();
      const result = await post('/api/batch-preview', data);
      const devices = data.launch ? ['desktop', 'mobile'] : [data.device];
      const count = result.urls.length * devices.length;
      if (count > 25) throw new Error('Launch checks support up to 12 URLs. Reduce the list and preview again.');
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
      render();
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : 'Preview failed.';
    } finally {
      button.disabled = false;
    }
  });
  async function run() {
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
  window.addEventListener('beforeunload', (e) => {
    if (running) {
      e.preventDefault();
    }
  });
  document.querySelector('#save-preset')?.addEventListener('click', async () => {
    const button = document.querySelector<HTMLButtonElement>('#save-preset')!;
    button.disabled = true;
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
      status.textContent = e instanceof Error ? e.message : 'Could not save settings.';
    } finally {
      button.disabled = false;
    }
  });
}
