import assert from "node:assert/strict";
import test from "node:test";
import { createRequestIdentityResolver } from "../dist/index.js";

test("request identity defaults to no development fallback", async () => {
  const resolve = createRequestIdentityResolver({});
  assert.equal(await resolve(undefined, () => ({ id: "forged" })), undefined);
  assert.equal(await resolve("Bearer anything", () => ({ id: "forged" })), undefined);
});
test("verified identity never falls back on missing, invalid or rejected credentials", async () => {
  let developmentCalls = 0;
  const fallback = () => { developmentCalls++; return { id: "forged" }; };
  const resolve = createRequestIdentityResolver({ allowDevelopmentIdentity: true,
    verify: async (token) => { if (token !== "valid") throw new Error("rejected"); return { id: "verified" }; } });
  for (const header of [undefined, "Basic valid", "Bearer ", "Bearer a b", "Bearer rejected"]) {
    assert.equal(await resolve(header, fallback), undefined);
  }
  assert.deepEqual(await resolve("bearer valid", fallback), { id: "verified" });
  assert.equal(developmentCalls, 0);
});
test("explicit local composition may supply identity, but malformed credentials do not trigger it", async () => {
  const resolve = createRequestIdentityResolver({ allowDevelopmentIdentity: true });
  assert.deepEqual(await resolve(undefined, () => ({ id: "local" })), { id: "local" });
  assert.deepEqual(await resolve("Bearer seed", (credential) => ({ credential })), { credential: "seed" });
  assert.equal(await resolve("Basic seed", () => ({ id: "local" })), undefined);
});
