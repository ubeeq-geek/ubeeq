export interface ContentCredentialsInspection {
  /** Indicates a text marker only, not a parsed or authenticated credential. */
  present: boolean;
  verification: "not_performed";
  inspectedBytes: number;
  truncated: boolean;
  inspectedAt: string;
  candidateAssertion?: "ai-generated" | "ai-assisted";
  evidence?: "c2pa:credential-marker" | "c2pa:generative-marker" | "c2pa:ai-assisted-marker";
}

/**
 * Bounded preflight hint for routing media to a credential verifier. This does
 * not parse manifests, bind assertions to an asset, or validate signatures/trust.
 * Arbitrary file text can produce a match: never use it as provenance or policy
 * proof. Generic c2pa.created/c2pa.edited actions do not establish AI involvement.
 */
export const inspectContentCredentials = (bytes: Uint8Array, inspectedAt = new Date().toISOString()): ContentCredentialsInspection => {
  const inspectedBytes = Math.min(bytes.byteLength, 2 * 1024 * 1024);
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, inspectedBytes)).toLowerCase();
  const result: ContentCredentialsInspection = { present: /c2pa|content credentials|jumbf/.test(text),
    verification: "not_performed", inspectedBytes, truncated: inspectedBytes < bytes.byteLength, inspectedAt };
  if (!result.present) return result;
  const generated = /trainedalgorithmicmedia|ai[_ -]?(generated|created)|generative[_ -]?ai|stable diffusion|midjourney|dall[·e]/.test(text);
  const assisted = /ai[_ -]?(assist(ed|ance)|edit)|generative fill/.test(text);
  return { ...result, evidence: generated ? "c2pa:generative-marker" : assisted ? "c2pa:ai-assisted-marker" : "c2pa:credential-marker",
    ...(generated ? { candidateAssertion: "ai-generated" as const } : assisted ? { candidateAssertion: "ai-assisted" as const } : {}) };
};
