import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { encryptCredentialEnvelope as seal, decryptCredentialEnvelope as open, CredentialEnvelopeError } from "../dist/index.js";

const key = Buffer.alloc(32, 7);

test("v1 envelopes remain interoperable with the original AES-GCM implementation", () => {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update("legacy-token", "utf8"), cipher.final()]);
  const legacy = ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  assert.equal(open(legacy, key), "legacy-token");
  const [version, ivText, tagText, bodyText] = seal("new-token", key).split(".");
  assert.equal(version, "v1");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  assert.equal(Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString("utf8"), "new-token");
});

test("fresh nonces and UTF-8 or empty plaintext round-trip without mutating the key", () => {
  const before = Buffer.from(key);
  for (const plaintext of ["", "credential", "token-☃-🎨", JSON.stringify({ accessToken: "a", refreshToken: "b" })]) {
    const first = seal(plaintext, key), second = seal(plaintext, key);
    assert.notEqual(first.split(".")[1], second.split(".")[1]);
    assert.equal(open(first, key), plaintext); assert.equal(open(second, key), plaintext);
  }
  assert.deepEqual(key, before);
});

test("wrong keys and tampered nonce, tag or ciphertext never return plaintext", () => {
  const encrypted = seal("sensitive-test-value", key);
  assert.throws(() => open(encrypted, Buffer.alloc(32, 8)), CredentialEnvelopeError);
  for (const position of [1, 2, 3]) {
    const parts = encrypted.split(".");
    const bytes = Buffer.from(parts[position], "base64url"); bytes[0] ^= 1;
    parts[position] = bytes.toString("base64url");
    assert.throws(() => open(parts.join("."), key), CredentialEnvelopeError);
  }
});

test("invalid versions, extra fields, noncanonical encoding and invalid lengths are rejected", () => {
  const encrypted = seal("value", key), parts = encrypted.split(".");
  const invalid = [encrypted + ".ignored", encrypted.replace("v1.", "v2."), "v1.a.b.c",
    [parts[0], parts[1] + "=", parts[2], parts[3]].join("."),
    [parts[0], "", parts[2], parts[3]].join("."),
    [parts[0], parts[1], parts[2].slice(0, 4), parts[3]].join(".")];
  for (const value of invalid) assert.throws(() => open(value, key), CredentialEnvelopeError);
  for (const size of [0, 16, 31, 33]) {
    assert.throws(() => seal("value", new Uint8Array(size)), /32-byte/);
    assert.throws(() => open(encrypted, new Uint8Array(size)), /32-byte/);
  }
});
