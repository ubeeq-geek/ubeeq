import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class CredentialEnvelopeError extends Error {
  constructor() { super("Credential envelope is invalid or could not be authenticated."); this.name = "CredentialEnvelopeError"; }
}

const keyBytes = (key: Uint8Array): Buffer => {
  if (key.byteLength !== 32) throw new Error("Credential envelopes require a 32-byte key.");
  return Buffer.from(key);
};

/** Compatible v1 envelope; callers own key generation, custody and rotation. */
export const encryptCredentialEnvelope = (value: string, key: Uint8Array): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
};

/** Authenticate completely before returning plaintext; no partial output on failure. */
export const decryptCredentialEnvelope = (value: string, key: Uint8Array): string => {
  const material = keyBytes(key);
  try {
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw new CredentialEnvelopeError();
    const decode = (encoded: string): Buffer => {
      if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new CredentialEnvelopeError();
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) throw new CredentialEnvelopeError();
      return bytes;
    };
    const iv = decode(parts[1]), tag = decode(parts[2]), ciphertext = decode(parts[3]);
    if (iv.length !== 12 || tag.length !== 16) throw new CredentialEnvelopeError();
    const decipher = createDecipheriv("aes-256-gcm", material, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialEnvelopeError();
  }
};
