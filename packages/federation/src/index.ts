export type FederationVisibility = "public" | "unlisted" | "private";

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
