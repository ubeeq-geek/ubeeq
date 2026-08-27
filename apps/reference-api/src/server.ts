import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createLocalAdapterSet, type LocalAdapterConfiguration } from "@ubeeq/adapters-local";
import { composeReferenceApplication } from "@ubeeq/api";
import type { AssetRecord, CreatorRecord, PublicationIntentRecord, PublicationRecord, WorkRecord } from "@ubeeq/persistence";

const json = (response: ServerResponse, status: number, body: unknown, requestId: string): void => {
  response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("x-request-id", requestId); response.end(JSON.stringify(body));
};
class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const requireString = (value: unknown, field: string): string => { if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "invalid_request", `${field} is required`); return value.trim(); };
const parseBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = []; let size = 0;
  request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 10 * 1024 * 1024) reject(new HttpError(413, "payload_too_large", "Request body exceeds 10 MiB")); else chunks.push(chunk); });
  request.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new HttpError(400, "invalid_json", "Request body must be JSON")); } });
  request.on("error", reject);
});

export interface ReferenceApiConfiguration extends LocalAdapterConfiguration { instanceId?: string; }

export const createReferenceApi = (configuration: ReferenceApiConfiguration): { server: Server; close(): Promise<void> } => {
  const adapters = createLocalAdapterSet(configuration);
  const composition = composeReferenceApplication({
    instanceId: configuration.instanceId ?? "local-reference",
    publicBaseUrl: configuration.publicBaseUrl,
    extensions: [], requiredExtensions: {},
    localAdapter: { sqliteDatabasePath: configuration.databasePath, storageDirectory: configuration.dataDirectory }
  }, {
    identity: adapters.identity, repositories: adapters.repositories, objectStorage: adapters.storage, delivery: adapters.storage, jobs: adapters.jobs,
    diagnostics: [
      { name: "sqlite", check: async () => { await adapters.repositories.creators.list({ limit: 1 }); return { status: "ok" as const }; } },
      { name: "filesystem", check: async () => { await adapters.storage.put({ object: { bucket: "diagnostics", key: "probe", contentType: "text/plain", byteLength: 0, scope: "private" }, body: new Uint8Array() }); await adapters.storage.remove({ bucket: "diagnostics", key: "probe" }); return { status: "ok" as const }; } }
    ]
  });
  const { repositories } = composition.dependencies;

  const session = async (request: IncomingMessage) => {
    const credential = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!credential || credential === request.headers.authorization) throw new HttpError(401, "authentication_required", "A bearer session is required");
    const verified = await adapters.identity.verifySession({ credential });
    if (!verified) throw new HttpError(401, "authentication_invalid", "The session is invalid or expired");
    return verified;
  };
  const creatorFor = async (subjectId: string): Promise<CreatorRecord> => {
    let cursor: string | undefined;
    do { const page = await repositories.creators.list({ limit: 100, cursor }); const found = page.items.find((creator) => creator.subjectId === subjectId); if (found) return found; cursor = page.nextCursor; } while (cursor);
    throw new HttpError(404, "creator_not_found", "No creator profile belongs to the current subject");
  };
  const ownedWork = async (workId: string, subjectId: string): Promise<WorkRecord> => { const work = await repositories.works.get(workId); if (!work) throw new HttpError(404, "work_not_found", "Work was not found"); const creator = await creatorFor(subjectId); if (work.creatorId !== creator.id) throw new HttpError(403, "work_not_owned", "Work does not belong to the current creator"); return work; };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = request.headers["x-request-id"]?.toString() || randomUUID();
    try {
      const url = new URL(request.url ?? "/", configuration.publicBaseUrl);
      const method = request.method ?? "GET";
      if (method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, requestId }, requestId);
      if ((method === "GET" && url.pathname === "/ready") || (method === "GET" && url.pathname === "/diagnostics")) {
        const dependencies = await Promise.all((composition.dependencies.diagnostics ?? []).map(async (dependency) => ({ name: dependency.name, ...(await dependency.check()) })));
        const ready = dependencies.every((dependency) => dependency.status === "ok");
        return json(response, ready ? 200 : 503, { ok: ready, status: ready ? "ok" : "degraded", dependencies, requestId }, requestId);
      }
      if (!url.pathname.startsWith("/v1/")) throw new HttpError(404, "not_found", "Route was not found");

      if (method === "POST" && url.pathname === "/v1/auth/sign-up") { const body = await parseBody(request); const account = await adapters.identity.register({ email: requireString(body.email, "email"), password: requireString(body.password, "password") }); return json(response, 201, { account, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/auth/sign-in") { const body = await parseBody(request); const result = await adapters.identity.authenticate({ email: requireString(body.email, "email"), password: requireString(body.password, "password") }); return json(response, 200, { token: result.token, expiresAt: result.session.expiresAt, requestId }, requestId); }

      if (method === "POST" && url.pathname === "/v1/creators") { const identity = await session(request); const body = await parseBody(request); const creator = await repositories.creators.create({ id: randomUUID(), instanceId: configuration.instanceId ?? "local-reference", handle: requireString(body.handle, "handle"), displayName: requireString(body.displayName, "displayName"), subjectId: identity.subject.id }); return json(response, 201, { creator, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/creators/me") { const identity = await session(request); return json(response, 200, { creator: await creatorFor(identity.subject.id), requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/works") { const identity = await session(request); const creator = await creatorFor(identity.subject.id); const body = await parseBody(request); const work = await repositories.works.create({ id: randomUUID(), instanceId: creator.instanceId, creatorId: creator.id, title: requireString(body.title, "title"), status: "draft" }); return json(response, 201, { work, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/collections") { const identity = await session(request); const creator = await creatorFor(identity.subject.id); const body = await parseBody(request); const collection = await repositories.collections.create({ id: randomUUID(), instanceId: creator.instanceId, creatorId: creator.id, title: requireString(body.title, "title"), visibility: body.visibility === "public" || body.visibility === "unlisted" ? body.visibility : "private" }); return json(response, 201, { collection, requestId }, requestId); }

      if (method === "POST" && url.pathname === "/v1/uploads") { const identity = await session(request); const body = await parseBody(request); const work = await ownedWork(requireString(body.workId, "workId"), identity.subject.id); const byteLength = Number(body.byteLength); if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new HttpError(400, "invalid_request", "byteLength must be a non-negative integer"); const object = { bucket: "local", key: `creator/${work.creatorId}/work/${work.id}/${randomUUID()}`, contentType: requireString(body.mimeType, "mimeType"), byteLength, scope: "private" as const }; const upload = await adapters.storage.initiate({ object, checksumAlgorithm: "sha256", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }); return json(response, 201, { upload, requestId }, requestId); }
      const contentMatch = url.pathname.match(/^\/v1\/uploads\/([^/]+)\/content$/);
      if (method === "PUT" && contentMatch) { await session(request); const body = await parseBody(request); const base64 = requireString(body.base64, "base64"); await adapters.storage.acceptUpload(contentMatch[1], Buffer.from(base64, "base64")); return json(response, 204, undefined, requestId); }
      const completeMatch = url.pathname.match(/^\/v1\/uploads\/([^/]+)\/complete$/);
      if (method === "POST" && completeMatch) { const identity = await session(request); const body = await parseBody(request); const object = await adapters.storage.complete({ uploadId: completeMatch[1], checksum: requireString(body.checksum, "checksum"), byteLength: Number(body.byteLength) }); const work = await ownedWork(requireString(body.workId, "workId"), identity.subject.id); const asset = await repositories.assets.create({ id: randomUUID(), instanceId: work.instanceId, creatorId: work.creatorId, workId: work.id, mimeType: object.contentType, checksum: object.checksum!, objectVersion: object.versionId!, status: "ready", storage: object } as AssetRecord & { storage: typeof object }); return json(response, 201, { asset, requestId }, requestId); }

      const publicationMatch = url.pathname.match(/^\/v1\/works\/([^/]+)\/publications$/);
      if (method === "POST" && publicationMatch) { const identity = await session(request); const work = await ownedWork(publicationMatch[1], identity.subject.id); const body = await parseBody(request); const destination = requireString(body.destination, "destination"); const intent = await repositories.publicationIntents.create({ id: randomUUID(), instanceId: work.instanceId, workId: work.id, destination, idempotencyKey: request.headers["idempotency-key"]?.toString() || randomUUID() }); const publication = await repositories.publications.create({ id: randomUUID(), instanceId: work.instanceId, workId: work.id, destination, status: "live" }); const publishedWork = await repositories.works.update(work.id, work.revision, { status: "published" }); return json(response, 201, { intent, publication, work: publishedWork, requestId }, requestId); }
      const publicMatch = url.pathname.match(/^\/v1\/public\/works\/([^/]+)$/);
      if (method === "GET" && publicMatch) { const work = await repositories.works.get(publicMatch[1]); if (!work || work.status !== "published") throw new HttpError(404, "work_not_found", "Published work was not found"); const assets = (await repositories.assets.list({ limit: 100 })).items.filter((asset) => asset.workId === work.id && asset.status === "ready"); const publications = (await repositories.publications.list({ limit: 100 })).items.filter((publication) => publication.workId === work.id && publication.status === "live"); const delivered = await Promise.all(assets.map(async (asset) => ({ ...asset, delivery: await adapters.storage.issue({ object: { bucket: "local", key: (asset as AssetRecord & { storage: { key: string } }).storage.key, versionId: asset.objectVersion, scope: "public" }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) }))); return json(response, 200, { work, assets: delivered, publications, requestId }, requestId); }
      const deliveryMatch = url.pathname.match(/^\/v1\/delivery\/([^/]+)$/);
      if (method === "GET" && deliveryMatch) { const object = JSON.parse(Buffer.from(deliveryMatch[1], "base64url").toString("utf8")); if (object.scope !== "public") throw new HttpError(403, "delivery_denied", "This development delivery URL is not public"); const found = await adapters.storage.get(object); response.statusCode = 200; response.setHeader("content-type", found.object.contentType); response.setHeader("x-request-id", requestId); response.end(found.body); return; }
      if (method === "GET" && url.pathname === "/v1/exports/me") { const identity = await session(request); const creator = await creatorFor(identity.subject.id); const works = (await repositories.works.list({ limit: 100 })).items.filter((work) => work.creatorId === creator.id); const assets = (await repositories.assets.list({ limit: 100 })).items.filter((asset) => asset.creatorId === creator.id); const collections = (await repositories.collections.list({ limit: 100 })).items.filter((collection) => collection.creatorId === creator.id); return json(response, 200, { schemaVersion: "1", creator, works, assets, collections, secretsExcluded: true, requestId }, requestId); }
      throw new HttpError(404, "not_found", "Route was not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500; const code = error instanceof HttpError ? error.code : "internal_error"; const message = error instanceof Error ? error.message : "Unexpected error";
      json(response, status, { error: { code, message, requestId } }, requestId);
    }
  };
  const server = createServer((request, response) => { void handle(request, response); });
  return { server, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
};

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const port = Number(process.env.PORT ?? 4100); const dataDirectory = process.env.UBEEQ_DATA_DIRECTORY ?? "./var/reference";
  const api = createReferenceApi({ databasePath: process.env.UBEEQ_DATABASE_PATH ?? `${dataDirectory}/ubeeq.sqlite`, dataDirectory, publicBaseUrl: process.env.UBEEQ_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}` });
  api.server.listen(port, "127.0.0.1", () => console.log(`Ubeeq reference API listening on http://127.0.0.1:${port}`));
}
