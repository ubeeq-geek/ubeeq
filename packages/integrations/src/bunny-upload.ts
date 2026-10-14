export type BunnyUploadGrant = { id: string; service: 'stream' | 'storage'; remoteId: string; mimeType?: string; endpoint?: string; libraryId?: string; videoId?: string; signature?: string; expires?: number; url?: string };
/** Narrow upload capabilities only; API keys and Storage passwords never reach this module. */
export async function uploadBunnyFile(file: File, grant: BunnyUploadGrant, signal: AbortSignal, progress: (percent: number) => void, fetcher: typeof fetch = fetch) {
  if (grant.service === 'storage') {
    const url = new URL(grant.url!);
    if (!/^https:$/.test(url.protocol) || !/^(de|ny|la|sg|syd|uk|se|jh)-s3\.storage\.bunnycdn\.com$/.test(url.hostname) || url.username || url.password || url.port) throw new Error('Unexpected Bunny upload destination.');
    const response = await fetcher(url.href, { method: 'PUT', headers: { 'Content-Type': grant.mimeType || file.type }, body: file, signal, redirect: 'error' });
    if (!response.ok) throw new Error('Bunny Storage upload did not complete. Retry the same upload or refresh its folder.');
    progress(100); return;
  }
  if (grant.endpoint !== 'https://video.bunnycdn.com/tusupload' || !/^[a-f0-9]{64}$/i.test(grant.signature || '') || !grant.libraryId || !grant.videoId || !grant.expires) throw new Error('Invalid Bunny upload authorization.');
  const headers = { AuthorizationSignature: grant.signature!, AuthorizationExpire: String(grant.expires), LibraryId: grant.libraryId, VideoId: grant.videoId, 'Tus-Resumable': '1.0.0' };
  const key = `ubeeq:bunny-upload:${grant.id}`;
  const valid = (value: string) => { const url = new URL(value); if (url.origin !== 'https://video.bunnycdn.com' || !url.pathname.startsWith('/tusupload/') || url.username || url.password || url.port) throw new Error('Unexpected Bunny resume URL.'); return url.href; };
  let saved: string | null = null;
  try { saved = sessionStorage.getItem(key); } catch { /* Upload still works without resume persistence. */ }
  let target = saved ? valid(saved) : '';
  let offset = 0;
  if (target) {
    const head = await fetcher(target, { method: 'HEAD', headers, signal, redirect: 'error' });
    if (head.status === 404) target = '';
    else { if (!head.ok) throw new Error('Could not resume this Bunny upload. Retry with the same file.'); offset = Number(head.headers.get('Upload-Offset')); if (Number(head.headers.get('Upload-Length')) !== file.size) throw new Error('The saved Bunny upload belongs to a different file.'); }
  }
  if (!target) {
    const encode = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
    const created = await fetcher(grant.endpoint, { method: 'POST', headers: { ...headers, 'Upload-Length': String(file.size), 'Upload-Metadata': `filetype ${encode(grant.mimeType || file.type)},title ${encode(file.name)}` }, signal, redirect: 'error' });
    const location = created.headers.get('Location');
    if (!created.ok || !location) throw new Error('Could not start the Bunny upload. Retry the same file.');
    target = valid(new URL(location, grant.endpoint).href);
    try { sessionStorage.setItem(key, target); } catch { /* Best effort resume. */ }
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new Error('Invalid Bunny upload offset.');
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + 8 * 1024 ** 2, file.size));
    const response = await fetcher(target, { method: 'PATCH', headers: { ...headers, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: chunk, signal, redirect: 'error' });
    if (!response.ok || Number(response.headers.get('Upload-Offset')) !== offset + chunk.size) throw new Error('The Bunny upload was interrupted. Retry with the same file to resume.');
    offset += chunk.size; progress(Math.round(offset / file.size * 100));
  }
  try { sessionStorage.removeItem(key); } catch { /* Best effort resume. */ }
}
