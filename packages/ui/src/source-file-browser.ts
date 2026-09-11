/** Metadata catalogue only: never fetch or link unverified storage keys. */
export interface SourceFileBrowserOptions {
  client: { call(path: string, method?: string, body?: Record<string, string | number>): Promise<any> };
  panel: HTMLElement;
  getCreator(): string | undefined;
  getActor(): string | undefined;
  buttonClassName?: string;
}
export const createSourceFileBrowser = ({ client, panel, getCreator, getActor, buttonClassName = '' }: SourceFileBrowserOptions) => {
  const document = panel.ownerDocument;
  const first = document.createElement('button'), next = document.createElement('button');
  const status = document.createElement('p'), list = document.createElement('ul');
  first.type = next.type = 'button'; first.className = next.className = buttonClassName;
  first.textContent = 'Refresh file catalogue'; next.textContent = 'Next file page';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  panel.append(first, next, status, list);
  const form = document.createElement('form'), fields: Record<string, HTMLInputElement> = {};
  for (const [name, title, required] of [['sourceKind', 'Kind (image, video, audio, document, archive or other)', true],
    ['mimeType', 'MIME type', true], ['storageKey', 'Unverified storage reference', true],
    ['originalFilename', 'Original filename', false], ['sizeBytes', 'Size in bytes (optional)', false]] as const) {
    const label = document.createElement('label'), input = document.createElement('input');
    label.textContent = title; input.name = name; input.required = required; input.value = '';
    input.maxLength = name === 'originalFilename' ? 255 : 2048;
    if (name === 'sizeBytes') { input.type = 'number'; input.min = '0'; input.step = '1'; }
    label.append(input); form.append(label); fields[name] = input;
  }
  const save = document.createElement('button'); save.type = 'submit'; save.className = buttonClassName; save.textContent = 'Register metadata only';
  form.append(save); panel.append(form);
  let actor: string | undefined, creator: string | undefined, cursor: string | undefined;
  let generation = 0, loading = false, uncertain = false;
  const active = (stamp: number) => stamp === generation && actor === getActor() && creator === getCreator();
  const render = () => { first.disabled = !actor || !creator || loading; next.disabled = first.disabled || !cursor;
    for (const input of [...Object.values(fields), save]) input.disabled = first.disabled || uncertain;
  };
  const sync = () => {
    if (actor !== getActor() || creator !== getCreator()) {
      actor = getActor(); creator = getCreator(); generation++; loading = false; cursor = undefined;
      uncertain = false; for (const input of Object.values(fields)) input.value = '';
      list.replaceChildren(); status.textContent = actor && creator ? 'Refresh to load this creator’s file metadata.' : 'Sign in and select a creator.';
    }
    render();
  };
  const load = async (after?: string) => {
    if (!active(generation) || !actor || !creator || loading) return;
    const stamp = ++generation; loading = true; render();
    list.replaceChildren(); status.textContent = 'Loading file metadata…';
    try {
      const page = await client.call(`/studio/creators/${encodeURIComponent(creator)}/files?limit=50${after ? `&cursor=${encodeURIComponent(after)}` : ''}`);
      if (!active(stamp)) return;
      const seen = new Set();
      if (!Array.isArray(page?.items) || page.items.length > 50 || page.items.some((file: Record<string, unknown>) => {
        if (!file || file.creatorId !== creator || typeof file.fileId !== 'string' || !file.fileId || seen.has(file.fileId)) return true;
        seen.add(file.fileId); return ['sourceKind', 'mimeType', 'storageKey'].some(key => typeof file[key] !== 'string');
      }) || (page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 8192))) throw new Error('Invalid source-file page.');
      for (const file of page.items) {
        const row = document.createElement('li');
        row.textContent = `${String(file.originalFilename || file.fileId).slice(0, 255)} — ${file.sourceKind.slice(0, 40)} · ${file.mimeType.slice(0, 150)} — unverified metadata`;
        list.append(row);
      }
      cursor = page.nextCursor;
      uncertain = false;
      status.textContent = page.items.length ? `${page.items.length} file records on this page. No object access is implied.` : 'No file records on this page.';
    } catch (error) {
      if (active(stamp)) { cursor = undefined; list.replaceChildren(); status.textContent = error instanceof Error ? error.message : 'File catalogue request failed.'; }
    } finally { if (active(stamp)) { loading = false; render(); } }
  };
  first.addEventListener('click', () => load()); next.addEventListener('click', () => cursor ? load(cursor) : undefined);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled || !active(generation)) return;
    const body: Record<string, string | number> = Object.fromEntries(Object.entries(fields).filter(([, input]) => input.value.trim()).map(([name, input]) => [name, input.value.trim()]));
    if (!['image', 'video', 'audio', 'document', 'archive', 'other'].includes(String(body.sourceKind)) || !body.mimeType || !body.storageKey ||
      (body.sizeBytes !== undefined && (!Number.isSafeInteger(Number(body.sizeBytes)) || Number(body.sizeBytes) < 0))) {
      status.textContent = 'Enter a supported kind, MIME type, storage reference and a non-negative whole-number size.'; return;
    }
    if (body.sizeBytes !== undefined) body.sizeBytes = Number(body.sizeBytes);
    const stamp = ++generation; loading = true; render();
    try {
      await client.call(`/studio/creators/${encodeURIComponent(creator!)}/files`, 'POST', body);
      if (!active(stamp)) return;
      for (const input of Object.values(fields)) input.value = '';
      status.textContent = 'Metadata registered. Refresh the catalogue to inspect it. No object was uploaded.';
    } catch {
      if (active(stamp)) { uncertain = true; status.textContent = 'Registration was not confirmed. Refresh and inspect the catalogue before submitting again; it may already have succeeded.'; }
    } finally { if (active(stamp)) { loading = false; render(); } }
  });
  sync(); return { sync };
};
