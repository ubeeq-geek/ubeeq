import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { RedditClient, RedditApiError } = require('../dist/index.js');
const options = { clientId:'client',clientSecret:'secret',redirectUri:'https://app.test/callback',userAgent:'test' };
test('OAuth requests only identity/read/submit with persistent authorization and never exposes the client secret', () => {
 const url = new URL(new RedditClient(options).authorize('state'));
 assert.equal(url.searchParams.get('duration'),'permanent'); assert.equal(url.searchParams.get('scope'),'identity read submit'); assert.equal(url.searchParams.get('state'),'state'); assert.ok(!url.href.includes('secret'));
});
test('link and text publishing use approved endpoints, user-agent and explicit body formats', async () => {
 const calls=[]; const client=new RedditClient({ ...options,fetch: async (url,init) => { calls.push({url,init}); return new Response(JSON.stringify({json:{data:{name:'t3_abc',url:'https://www.reddit.com/r/test/comments/abc/'}}})); } });
 await client.submit('token',{ kind:'link',subreddit:'test',title:'Title',url:'https://example.test/work' });
 await client.submit('token',{ kind:'self',subreddit:'test',title:'Title',text:'Body' });
 assert.equal(calls[0].url,'https://oauth.reddit.com/api/submit'); assert.equal(calls[0].init.headers['User-Agent'],'test'); assert.equal(new URLSearchParams(calls[0].init.body).get('resubmit'),'false'); assert.equal(new URLSearchParams(calls[1].init.body).get('text'),'Body');
});
test('ambiguous network/5xx writes carry uncertainty while definite rate limits retain backoff', async () => {
 const input={kind:'self',subreddit:'test',title:'Title',text:'Body'};
 for (const fetch of [async()=>{throw Error('network');},async()=>new Response('{}',{status:503})]) await assert.rejects(new RedditClient({...options,fetch}).submit('token',input),error=>error instanceof RedditApiError && error.uncertain);
 await assert.rejects(new RedditClient({...options,fetch:async()=>new Response('{}',{status:429,headers:{'retry-after':'120'}})}).submit('token',input),error=>!error.uncertain && error.retryAfterSeconds===120);
});
test('remote identity and host validation reject unverifiable submissions', async () => {
 const client=new RedditClient({...options,fetch:async()=>new Response(JSON.stringify({json:{data:{name:'t3_abc',url:'https://evil.test/post'}}}))});
 await assert.rejects(client.submit('token',{kind:'self',subreddit:'test',title:'Title'}),error=>error.uncertain);
});
