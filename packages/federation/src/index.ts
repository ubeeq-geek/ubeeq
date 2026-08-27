export type FederationVisibility = "public" | "unlisted" | "private";
export const FEDERATION_PROTOCOL_VERSION = "1" as const;

export interface FederationInstanceDocument {
  protocolVersion: typeof FEDERATION_PROTOCOL_VERSION;
  instanceId: string;
  instanceUrl: string;
  actorDocumentUrl: string;
  publicationInboxUrl: string;
  signingKeyId: string;
  signingPublicKey: string;
  capabilities: readonly ("publication-reference" | "withdrawal")[];
}

export interface SignedFederationEnvelope<TPayload> {
  id: string;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
  payload: TPayload;
  signature: string;
}

export interface FederationSignatureVerifier {
  verify(input: { keyId: string; message: string; signature: string }): Promise<boolean>;
}
/** Resolves an instance-discovered public key without coupling federation to a key provider. */
export interface FederationPublicKeyResolver extends FederationSignatureVerifier {
  register?(input: { keyId: string; publicKey: string }): Promise<void>;
}
export interface FederationSigner { keyId: string; sign(message: string): Promise<string>; }
export const signFederationEnvelope = async <TPayload>(input: Omit<SignedFederationEnvelope<TPayload>, "keyId" | "signature">, signer: FederationSigner): Promise<SignedFederationEnvelope<TPayload>> => ({ ...input, keyId: signer.keyId, signature: await signer.sign(federationSigningInput({ ...input, keyId: signer.keyId })) });

/** Durable replay protection belongs to an adapter; this port keeps it independent of a database choice. */
export interface FederationReplayStore { consume(input: { envelopeId: string; expiresAt: string }): Promise<boolean>; }

export interface RemoteActor {
  id: string;
  host: string;
  handle: string;
  profileUrl: string;
  inboxUrl: string;
}

export interface RemotePublication {
  id: string;
  actorId: string;
  canonicalUrl: string;
  publishedAt: string;
  visibility: FederationVisibility;
}

/** A signed event binds the remote actor and publication body to its operation. */
export interface RemotePublicationEvent {
  type: "publication_reference" | "publication_updated" | "publication_withdrawn";
  actor: RemoteActor;
  publication: RemotePublication;
}

export interface FederationReference {
  id: string;
  host: string;
}

const normalizeHttpsUrl = (value: string, field: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${field} must be an absolute HTTPS URL without credentials`);
  }
  return parsed;
};

export const stableFederationJson = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
export const federationSigningInput = <TPayload>(envelope: Omit<SignedFederationEnvelope<TPayload>, "signature">): string => stableFederationJson(envelope);

export const createFederationInstanceDocument = (document: FederationInstanceDocument): FederationInstanceDocument => {
  if (document.protocolVersion !== FEDERATION_PROTOCOL_VERSION || !document.instanceId.trim() || !document.signingKeyId.trim() || !document.signingPublicKey.trim()) throw new Error("Federation instance document is incomplete or incompatible.");
  const instanceUrl = normalizeHttpsUrl(document.instanceUrl, "instanceUrl");
  const actorDocumentUrl = normalizeHttpsUrl(document.actorDocumentUrl, "actorDocumentUrl");
  const publicationInboxUrl = normalizeHttpsUrl(document.publicationInboxUrl, "publicationInboxUrl");
  if (actorDocumentUrl.host !== instanceUrl.host || publicationInboxUrl.host !== instanceUrl.host) throw new Error("Federation instance endpoints must belong to the instance host.");
  return { ...document, instanceUrl: instanceUrl.toString(), actorDocumentUrl: actorDocumentUrl.toString(), publicationInboxUrl: publicationInboxUrl.toString(), capabilities: [...new Set(document.capabilities)].sort() as FederationInstanceDocument["capabilities"] };
};

export const verifyFederationEnvelope = async <TPayload>(envelope: SignedFederationEnvelope<TPayload>, verifier: FederationSignatureVerifier, replayStore: FederationReplayStore, now = new Date()): Promise<void> => {
  if (!envelope.id.trim() || !envelope.keyId.trim() || !envelope.signature.trim() || Number.isNaN(Date.parse(envelope.issuedAt)) || Number.isNaN(Date.parse(envelope.expiresAt))) throw new Error("Federation envelope is malformed.");
  if (Date.parse(envelope.expiresAt) <= now.getTime()) throw new Error("Federation envelope has expired.");
  const { signature, ...unsigned } = envelope;
  if (!await verifier.verify({ keyId: envelope.keyId, message: federationSigningInput(unsigned), signature })) throw new Error("Federation envelope signature is invalid.");
  if (!await replayStore.consume({ envelopeId: envelope.id, expiresAt: envelope.expiresAt })) throw new Error("Federation envelope was already delivered.");
};

/** Returns a canonical remote host without making a trust or visibility decision. */
export const normalizeFederationHost = (host: string): string => {
  const parsed = normalizeHttpsUrl(`https://${host}`, "host");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("host must not include a path, query, or fragment");
  return parsed.host.toLowerCase();
};

/** Validates protocol shape only; products decide whether a remote actor is trusted or visible. */
export const validateRemoteActor = (actor: RemoteActor): RemoteActor => {
  if (!actor.id.trim() || !actor.handle.trim()) throw new Error("Remote actor id and handle are required");
  const host = normalizeFederationHost(actor.host);
  const profileUrl = normalizeHttpsUrl(actor.profileUrl, "profileUrl");
  const inboxUrl = normalizeHttpsUrl(actor.inboxUrl, "inboxUrl");
  if (profileUrl.host.toLowerCase() !== host || inboxUrl.host.toLowerCase() !== host) {
    throw new Error("Remote actor URLs must belong to its declared host");
  }
  return { ...actor, host, profileUrl: profileUrl.toString(), inboxUrl: inboxUrl.toString() };
};

/** Validates portable publication metadata without applying a product's federation policy. */
export const validateRemotePublication = (publication: RemotePublication): RemotePublication => {
  if (!publication.id.trim() || !publication.actorId.trim()) throw new Error("Remote publication id and actor id are required");
  const canonicalUrl = normalizeHttpsUrl(publication.canonicalUrl, "canonicalUrl");
  if (Number.isNaN(Date.parse(publication.publishedAt))) throw new Error("publishedAt must be an ISO date-time");
  return { ...publication, canonicalUrl: canonicalUrl.toString() };
};

export const validateRemotePublicationEvent = (event: RemotePublicationEvent): RemotePublicationEvent => {
  if (event?.type !== "publication_reference" && event?.type !== "publication_updated" && event?.type !== "publication_withdrawn") throw new Error("Federation publication event type is unsupported");
  const actor = validateRemoteActor(event.actor);
  const publication = validateRemotePublication(event.publication);
  if (publication.actorId !== actor.id) throw new Error("Federation publication event actor does not match the publication");
  return { type: event.type, actor, publication };
};
