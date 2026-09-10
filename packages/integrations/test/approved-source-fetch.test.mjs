import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchApprovedSource, SourceUrlPolicyError } from '../dist/index.js';
const config = () => ({ url: 'https://media.example/start', approveUrl: value => new URL(value).hostname === 'media.example', signal: new AbortController().signal });
const redirect = (location, cancelled, status = 302) => new Response(new ReadableStream({ cancel() { cancelled.push(location); } }), { status, headers: location === undefined ? {} : { location } });

test('validates every relative redirect, discards intermediate bodies and leaves final body caller-owned', async () => {
  const calls = [], approved = [], cancelled = [], options = config();
  const final = new Response('bytes');
  options.approveUrl = url => { approved.push(url); return new URL(url).hostname === 'media.example'; };
  const response = await fetchApprovedSource({ ...options, fetcher: async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit'); assert.equal(init.method, 'GET');
    assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.signal, options.signal); assert.equal(init.headers, undefined);
    return calls.length === 1 ? redirect('/final', cancelled) : final;
  } });
  assert.equal(response, final); assert.equal(await response.text(), 'bytes');
  assert.deepEqual(approved, ['https://media.example/start', 'https://media.example/final']);
  assert.deepEqual(calls, approved); assert.deepEqual(cancelled, ['/final']);
});

test('unapproved, credentialed, insecure and nondefault-port redirects are never fetched', async () => {
  for (const location of ['https://evil.example/private', 'http://media.example/private', 'https://user:pass@media.example/private', 'https://media.example:444/private', '//127.0.0.1/private', 'x'.repeat(8193)]) {
    const cancelled = []; let calls = 0;
    await assert.rejects(fetchApprovedSource({ ...config(), fetcher: async () => { calls++; return redirect(location, cancelled); } }), SourceUrlPolicyError);
    assert.equal(calls, 1); assert.equal(cancelled.length, 1);
  }
});

test('loops, absent locations and redirect-budget exhaustion terminate within request bound', async () => {
  for (const location of ['/start#fragment', undefined, '/next']) {
    const cancelled = []; let calls = 0;
    await assert.rejects(fetchApprovedSource({ ...config(), maxRedirects: location === '/next' ? 0 : 3, fetcher: async () => { calls++; return redirect(location, cancelled); } }), SourceUrlPolicyError);
    assert.equal(calls, 1); assert.equal(cancelled.length, 1);
  }
  let calls = 0;
  await assert.rejects(fetchApprovedSource({ ...config(), maxRedirects: 3, fetcher: async () => redirect(`/hop${++calls}`, []) }), /budget/);
  assert.equal(calls, 4);
});

test('all supported redirect statuses are inspected; terminal errors remain caller-owned', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const response = await fetchApprovedSource({ ...config(), fetcher: async () => ++calls === 1 ? redirect('/final', [], status) : new Response('unavailable', { status: 503 }) });
    assert.equal(response.status, 503); assert.equal(await response.text(), 'unavailable'); assert.equal(calls, 2);
  }
});

test('invalid configuration and aborted calls do not access the transport', async () => {
  for (const change of [{ maxRedirects: -1 }, { maxRedirects: 11 }, { maxRedirects: 0.5 }, { url: 'http://media.example' }, { approveUrl: () => false }]) {
    await assert.rejects(fetchApprovedSource({ ...config(), ...change, fetcher: async () => assert.fail('no access') }));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchApprovedSource({ ...config(), signal: controller.signal, fetcher: async () => assert.fail('no access') }));
});

test('abort after headers disposes the response and unexpected transport redirects reject', async () => {
  const controller = new AbortController(), cancelled = [];
  await assert.rejects(fetchApprovedSource({ ...config(), signal: controller.signal, fetcher: async () => { controller.abort(); return redirect('/next', cancelled); } }));
  assert.equal(cancelled.length, 1);
  const response = redirect('/next', cancelled); Object.defineProperty(response, 'redirected', { value: true });
  await assert.rejects(fetchApprovedSource({ ...config(), fetcher: async () => response }), SourceUrlPolicyError);
  assert.equal(cancelled.length, 2);
});
