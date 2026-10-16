import test from 'node:test';
import assert from 'node:assert/strict';
import { FacebookPagesClient, LinkedInPostsClient, ProfessionalPublishingError } from '../dist/professional-publishing.js';
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const page = { provider: 'facebook', kind: 'facebook_page', id: '1', name: 'Page', pageAccessToken: 'page-token', tasks: ['CREATE_CONTENT'] };
const fb = options => new FacebookPagesClient({ appId: 'app', appSecret: 'secret', redirectUri: 'https://example.test/callback', graphApiVersion: 'v26.0', ...options });
const li = options => new LinkedInPostsClient({ clientId: 'app', clientSecret: 'secret', redirectUri: 'https://example.test/callback', apiVersion: '202609', ...options });
const member = { kind: 'linkedin_member', id: 'person-1', name: 'Member' };

test('Facebook discovers all pages without following credential-bearing pagination URLs and uses the post ID for photos', async () => {
  const calls = [], client = fb({ fetch: async (url, init) => { calls.push([url, init]);
    if (url.includes('/me/accounts')) return response({ data: [{ id: '1', name: 'Page', access_token: 'pt', tasks: ['CREATE_CONTENT'] }],
      ...(!url.includes('after=') ? { paging: { next: 'https://attacker.test/collect', cursors: { after: 'next' } } } : {}) });
    return response({ id: '20', post_id: '1_30' }); } });
  const pages = await client.pages('user-token'); assert.equal(pages.length, 2); assert.equal(new URL(calls[1][0]).origin, 'https://graph.facebook.com');
  assert.deepEqual(await client.publish(pages[0], { caption: 'Preview', previewUrl: 'https://cdn.example.test/preview.jpg', altText: 'Description' }), { id: '1_30', mediaId: '20' });
  assert.equal(JSON.parse(calls[2][1].body).alt_text_custom, 'Description');
});
test('private addresses, credentials, unsupported targets and malformed local input fail before any write', async () => {
  let calls = 0; const client = fb({ fetch: async () => { calls++; return response({ id: '1' }); } });
  for (const previewUrl of ['file:///original', 'http://cdn.example.test/x', 'https://127.1/x', 'https://[::ffff:127.0.0.1]/x', 'https://100.64.0.1/x', 'https://localhost./x', 'https://user:secret@cdn.example.test/x'])
    await assert.rejects(() => client.publish(page, { caption: 'x', previewUrl }), e => e instanceof ProfessionalPublishingError && e.code === 'invalid_media');
  await assert.rejects(() => client.publish({ ...page, tasks: [] }, { caption: 'x' }), e => e.code === 'permission');
  await assert.rejects(() => client.publish({ ...page, id: 'me/feed?secret' }, { caption: 'x' }));
  await assert.rejects(() => client.publish(page, { caption: '' }));
  assert.equal(calls, 0);
});
test('LinkedIn uses a real calendar version, explicit article title and exact creation receipt', async () => {
  const calls = [], client = li({ fetch: async (url, init) => { calls.push([url, init]); return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:123' } }); } });
  assert.deepEqual(await client.publish('token', member, { commentary: 'x', articleUrl: 'https://example.test/work', articleTitle: 'Work' }), { id: 'urn:li:share:123' });
  assert.equal(calls[0][1].headers['LinkedIn-Version'], '202609'); assert.equal(JSON.parse(calls[0][1].body).content.article.title, 'Work');
  await assert.rejects(() => client.publish('token', { ...member, kind: 'linkedin_organization' }, { commentary: 'x' }), e => e.code === 'unsupported');
  await assert.rejects(() => client.publish('token', member, { commentary: 'x', articleUrl: 'https://example.test' }));
  assert.throws(() => li({ apiVersion: '202699' }));
});
test('uncertain writes stay uncertain for HTML errors, oversized replies and missing photo/post receipts', async () => {
  for (const result of [() => new Response('<html>error', { status: 503 }), () => response({ id: '1' }), () => response({ id: '1', large: 'x'.repeat(1000) })]) {
    const client = fb({ maxResponseBytes: 100, fetch: async () => result() });
    await assert.rejects(() => client.publish(page, { caption: 'x', previewUrl: 'https://cdn.example.test/x.jpg' }), e => e.code === 'outcome_unknown');
  }
  await assert.rejects(() => li({ fetch: async () => response({}, 200) }).publish('t', member, { commentary: 'x' }), e => e.code === 'outcome_unknown');
});
test('HTTP rejections retain normalized retry information and do not expose provider secrets', async () => {
  const client = fb({ fetch: async () => response({ error: { message: 'SECRET TOKEN' } }, 429, { 'retry-after': '42' }) });
  await assert.rejects(() => client.publish(page, { caption: 'x' }), e => e.code === 'rate_limit' && e.retryAfterSeconds === 42 && !e.message.includes('SECRET'));
});
test('deadline covers a stalled provider body and a fetch that ignores AbortSignal', async () => {
  for (const fetch of [async () => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const client = fb({ fetch, timeoutMs: 10 });
    await assert.rejects(() => client.publish(page, { caption: 'x' }), e => e.code === 'outcome_unknown');
  }
});
test('Facebook token verification binds application, grants, user identity and expiry', async () => {
  const good = { is_valid: true, app_id: 'app', type: 'USER', user_id: '123', expires_at: Math.floor(Date.now() / 1000) + 3600,
    scopes: ['pages_manage_posts', 'pages_show_list', 'pages_read_engagement'] };
  for (const change of [{ app_id: 'other' }, { is_valid: false }, { expires_at: 1 }, { scopes: [] }])
    await assert.rejects(() => fb({ fetch: async () => response({ data: { ...good, ...change } }) }).verifyToken('token'), e => e.code === 'permission');
  const result = await fb({ fetch: async () => response({ data: good }) }).verifyToken('token'); assert.equal(result.principalId, '123');
});
test('LinkedIn introspection and userinfo bind member authorization to this application', async () => {
  const metadata = { active: true, client_id: 'app', auth_type: '3L', expires_at: Math.floor(Date.now() / 1000) + 3600, scope: 'openid,profile,w_member_social' };
  const client = li({ fetch: async url => url.includes('introspectToken') ? response(metadata) : response({ sub: 'member', name: 'Member' }) });
  assert.deepEqual((await client.verifyToken('token')).scopes, ['openid', 'profile', 'w_member_social']);
  for (const change of [{ active: false }, { client_id: 'other' }, { auth_type: '2L' }, { scope: 'openid,profile' }])
    await assert.rejects(() => li({ fetch: async () => response({ ...metadata, ...change }) }).verifyToken('token'), e => e.code === 'permission');
});
