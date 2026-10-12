import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeUploadClient, transferYouTubeUpload, validateYouTubeUploadSession } from '../dist/esm/index.js';
const session = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=private-session';
const metadata = { title: 'Original', description: '', tags: [], categoryId: '22', privacy: 'private', madeForKids: false, notifySubscribers: false };
test('rejects session destinations before forwarding credentials', () => {
  for (const bad of ['http://www.googleapis.com/upload/youtube/v3/videos?upload_id=x', 'https://evil.test/upload/youtube/v3/videos?upload_id=x',
    'https://www.googleapis.com.evil.test/upload/youtube/v3/videos?upload_id=x', 'https://token@www.googleapis.com/upload/youtube/v3/videos?upload_id=x',
    'https://www.googleapis.com/other?upload_id=x']) assert.throws(() => validateYouTubeUploadSession(bad));
  assert.equal(validateYouTubeUploadSession(session), session);
});
test('initiates only with explicit privacy, audience and notification declarations', async () => {
  let sent;
  const client = new YouTubeUploadClient(async (url, init) => { sent = { url, init }; return new Response(null, { status: 200, headers: { location: session } }); });
  assert.equal(await client.initiate('secret', 100, 'video/mp4', metadata), session);
  assert.equal(new URL(sent.url).searchParams.get('notifySubscribers'), 'false');
  assert.deepEqual(JSON.parse(sent.init.body).status, { privacyStatus: 'private', selfDeclaredMadeForKids: false });
  assert.equal(sent.init.redirect, 'error'); assert.ok(sent.init.signal);
  await assert.rejects(client.initiate('secret', 100, 'video/mp4', { ...metadata, madeForKids: undefined }));
});
test('resumes from the provider offset without resending accepted bytes', async () => {
  const size = 3 * 256 * 1024, ranges = [], reads = [], saved = [];
  const client = new YouTubeUploadClient(async (_url, init) => {
    ranges.push(init.headers['Content-Range']);
    return ranges.length === 1 ? new Response(null, { status: 308, headers: { range: 'bytes=0-262143' } })
      : new Response(JSON.stringify({ id: 'video' }), { status: 200 });
  });
  const result = await transferYouTubeUpload({ client, token: 'secret', session, source: { size, read: async (offset, length) => { reads.push([offset, length]); return new Uint8Array(length); } },
    onProgress: async progress => saved.push(progress) });
  assert.deepEqual(reads, [[262144, 524288]]); assert.deepEqual(ranges, ['bytes */786432', 'bytes 262144-786431/786432']);
  assert.equal(result.videoId, 'video'); assert.equal(saved.at(-1).offset, size);
});
test('a completed status query performs no source reads or duplicate uploads', async () => {
  const client = new YouTubeUploadClient(async () => new Response(JSON.stringify({ id: 'already-complete' }), { status: 200 }));
  const result = await transferYouTubeUpload({ client, token: 'secret', session, source: { size: 100, read: async () => { throw new Error('must not read'); } }, onProgress: async () => {} });
  assert.equal(result.videoId, 'already-complete');
});
test('bounds chunks and rejects malformed, backwards or oversized provider ranges', async () => {
  for (const range of ['bytes=1-20', 'bytes=0-200', 'wrong']) {
    const client = new YouTubeUploadClient(async () => new Response(null, { status: 308, headers: { range } }));
    await assert.rejects(client.query('secret', session, 100));
  }
  const client = new YouTubeUploadClient(async () => { throw new Error('must not call'); });
  await assert.rejects(transferYouTubeUpload({ client, token: 'secret', session, source: { size: 100, read: async () => new Uint8Array() }, maxChunks: 9, onProgress: async () => {} }));
});
test('an uncertain initiation is never reported as a safe new-upload retry', async () => {
  const client = new YouTubeUploadClient(async () => { throw new Error('network failure secret-url'); });
  await assert.rejects(client.initiate('secret', 100, 'video/mp4', metadata), error => error.code === 'AMBIGUOUS_INITIATION' && !error.message.includes('secret-url'));
});
