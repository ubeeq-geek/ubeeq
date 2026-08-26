import assert from "node:assert/strict";
import test from "node:test";
import { SelfHostConfigurationError, validateSelfHostConfiguration } from "../dist/index.js";

const configuration = {
  instanceId: "community-instance",
  publicOrigin: "https://community.example",
  storage: { adapter: "local", dataDirectory: "/srv/ubeeq" },
  extensions: [{ id: "community.brand", apiVersion: "1" }]
};

test("accepts a neutral self-hosted configuration", () => {
  assert.equal(validateSelfHostConfiguration(configuration), configuration);
});

test("requires secure public origins and local storage paths", () => {
  assert.throws(() => validateSelfHostConfiguration({ ...configuration, publicOrigin: "http://community.example" }), SelfHostConfigurationError);
  assert.throws(() => validateSelfHostConfiguration({ ...configuration, storage: { adapter: "local" } }), SelfHostConfigurationError);
});

test("permits loopback development but rejects duplicate extension ids", () => {
  assert.doesNotThrow(() => validateSelfHostConfiguration({ ...configuration, publicOrigin: "http://127.0.0.1:4000" }));
  assert.throws(() => validateSelfHostConfiguration({ ...configuration, extensions: [{ id: "same", apiVersion: "1" }, { id: "same", apiVersion: "1" }] }), SelfHostConfigurationError);
});
