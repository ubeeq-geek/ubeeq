import assert from "node:assert/strict";
import test from "node:test";
import { createReferenceApp } from "../src/server.mjs";

test("serves a neutral workspace and proxies only to the configured reference API", async (context) => {
  const upstream = await new Promise((resolve) => {
    const server = createReferenceApp();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  const app = createReferenceApp({ referenceApiUrl: `http://127.0.0.1:${upstream.address().port}` });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  context.after(() => { app.close(); upstream.close(); });
  const address = app.address();

  const health = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.deepEqual(await health.json(), { status: "ok" });
  const contracts = await fetch(`http://127.0.0.1:${address.port}/extension-contracts`);
  assert.deepEqual(await contracts.json(), {
    apiVersion: "1",
    contracts: ["brand", "moderation-policy", "billing-provider", "discovery", "integration-provider", "federation-policy", "operations"]
  });
  const workspace = await fetch(`http://127.0.0.1:${address.port}/workspace`);
  assert.match(await workspace.text(), /Ubeeq reference workspace/);
  const websites = await fetch(`http://127.0.0.1:${address.port}/websites`);
  assert.match(await websites.text(), /website-editor.js/);
  assert.match(websites.headers.get('content-security-policy'), /script-src[^;]*'self'/, 'the external editor bundle must be allowed by the page policy');
  const editor = await fetch(`http://127.0.0.1:${address.port}/website-editor.js`);
  assert.equal(editor.status, 200);
  assert.match(editor.headers.get('content-type'), /javascript/);
  const configuration = await fetch(`http://127.0.0.1:${address.port}/api-configuration`);
  assert.deepEqual(await configuration.json(), { apiPath: "/api", referenceApiUrl: `http://127.0.0.1:${upstream.address().port}` });
  const proxied = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.deepEqual(await proxied.json(), { status: "ok" });
});

test('preserves commerce paths, original callback bytes and PayPal headers alongside legacy proxy paths', async context => {
  const {createServer}=await import('node:http');
  const upstream=createServer(async(request,response)=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);response.setHeader('content-type','application/json');response.setHeader('cache-control','private, no-store');response.end(JSON.stringify({path:request.url,signature:request.headers['paypal-transmission-sig'],body:Buffer.concat(chunks).toString()}));});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const app=createReferenceApp({referenceApiUrl:'http://127.0.0.1:'+upstream.address().port});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  context.after(()=>{app.close();upstream.close();});const base='http://127.0.0.1:'+app.address().port;
  assert.equal((await (await fetch(base+'/api/health')).json()).path,'/health');
  assert.equal((await (await fetch(base+'/api/v1/creators/me')).json()).path,'/v1/creators/me');
  assert.equal((await (await fetch(base+'/api/storefront?owner=creator')).json()).path,'/api/storefront?owner=creator');
  const raw='{ "id": "EVENT", "resource": {} }';const result=await fetch(base+'/api/webhooks/paypal/connection',{method:'POST',headers:{'content-type':'application/json','paypal-transmission-sig':'verified-fixture-signature'},body:raw});
  assert.equal(result.headers.get('cache-control'),'private, no-store');assert.deepEqual(await result.json(),{path:'/api/webhooks/paypal/connection',signature:'verified-fixture-signature',body:raw});
});
