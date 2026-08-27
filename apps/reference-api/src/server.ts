import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createLocalAdapterSet, type LocalAdapterConfiguration } from "@ubeeq/adapters-local";
import { composeReferenceApplication } from "@ubeeq/api";
import { AdmissionBlockedError, requireAdmission, type ReviewHold } from "@ubeeq/moderation";
import { createCreatorExport, planCreatorImport, validateCreatorExport } from "@ubeeq/portability";
import { LocalImageProcessor } from "@ubeeq/processing";
import { validateRemotePublicationEvent, verifyFederationEnvelope } from "@ubeeq/federation";
import type { FederationPolicy } from "@ubeeq/extension-sdk";
import type { AssetRecord, CreatorRecord, WorkRecord } from "@ubeeq/persistence";

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

export interface ReferenceApiConfiguration extends LocalAdapterConfiguration { instanceId?: string; federationPolicy?: FederationPolicy; }

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
  const processor = new LocalImageProcessor();

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
  const audit = async (input: { action: string; actorId?: string; subjectId?: string; payload?: Record<string, unknown> }): Promise<void> => {
    await repositories.auditEvents.create({ id: randomUUID(), instanceId: configuration.instanceId ?? "local-reference", action: input.action, actorId: input.actorId, subjectId: input.subjectId, payload: input.payload ?? {} });
  };
  const requireClearAdmission = async (operation: string, subjectIds: readonly string[]): Promise<void> => {
    const holds = (await repositories.moderationHolds.list({ limit: 100 })).items
      .filter((hold) => hold.state === "active" && subjectIds.includes(hold.subjectId))
      .map((hold): ReviewHold => ({ id: hold.id, subjectId: hold.subjectId, active: true, sourceId: hold.id, reasonCode: hold.reason ?? "review_hold", createdAt: hold.createdAt }));
    requireAdmission(subjectIds.map((subjectId) => ({ subjectId })), holds, operation);
  };
  const runNextJob = async (workerId: string) => {
    const lease = await adapters.jobs.lease<{ assetId: string }>({ types: ["asset.process"], leaseDurationSeconds: 60, workerId });
    if (!lease) return undefined;
    try {
      const asset = await repositories.assets.get(lease.job.payload.assetId);
      if (!asset) throw new Error("Processing asset was not found.");
      if (asset.status === "ready") {
        await adapters.jobs.complete({ id: lease.job.id, leaseToken: lease.leaseToken });
        return { job: await adapters.jobs.get(lease.job.id), asset };
      }
      const storage = (asset as AssetRecord & { storage?: { bucket: string; key: string; versionId?: string } }).storage;
      if (!storage) throw new Error("Processing asset has no source object.");
      const processing = await repositories.assets.update(asset.id, asset.revision, { status: "processing" });
      const source = await adapters.storage.get(storage);
      if (source.object.checksum !== processing.checksum || source.object.byteLength <= 0) throw new Error("Processing source object failed checksum or metadata verification.");
      const processingResult = await processor.process({ assetId: processing.id, contentType: processing.mimeType, source: source.body, sourceVersionId: processing.objectVersion });
      const processed = await repositories.transaction(async (transaction) => {
        const ready = await repositories.assets.update(processing.id, processing.revision, { status: "ready" }, { transaction });
        await repositories.moderationEvidence.create({ id: randomUUID(), instanceId: processing.instanceId, subjectType: "asset", subjectId: processing.id, source: "local.processing", payload: { checksum: processing.checksum, sourceVersionId: processing.objectVersion, ...processingResult.metadata, renditions: processingResult.renditions } }, { transaction });
        await repositories.usageEvents.create({ id: randomUUID(), instanceId: processing.instanceId, accountId: processing.creatorId, meter: "processing_units", quantity: 1, idempotencyKey: `asset-processing:${processing.id}:${processing.objectVersion}` }, { transaction, idempotencyKey: `asset-processing:${processing.id}:${processing.objectVersion}` });
        await repositories.auditEvents.create({ id: randomUUID(), instanceId: processing.instanceId, action: "asset.processing_completed", subjectId: processing.id, payload: { jobId: lease.job.id, sourceVersionId: processing.objectVersion } }, { transaction });
        return ready;
      });
      await adapters.jobs.complete({ id: lease.job.id, leaseToken: lease.leaseToken });
      return { job: await adapters.jobs.get(lease.job.id), asset: processed };
    } catch (error) {
      const details = { code: "processing_failed", message: error instanceof Error ? error.message : "Unknown processing failure" };
      await audit({ action: "asset.processing_failed", subjectId: lease.job.payload.assetId, payload: { jobId: lease.job.id, attempt: lease.job.attempt + 1, error: details } });
      if (lease.job.attempt >= lease.job.maxAttempts) await adapters.jobs.deadLetter({ id: lease.job.id, leaseToken: lease.leaseToken, error: details });
      else await adapters.jobs.retry({ id: lease.job.id, leaseToken: lease.leaseToken, error: details, retryAt: new Date(Date.now() + 1_000).toISOString() });
      throw error;
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = request.headers["x-request-id"]?.toString() || randomUUID();
    try {
      const url = new URL(request.url ?? "/", configuration.publicBaseUrl);
      const method = request.method ?? "GET";
      if (method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, requestId }, requestId);
      if (method === "GET" && url.pathname === "/.well-known/ubeeq") { const publicUrl = new URL(configuration.publicBaseUrl); const enabled = publicUrl.protocol === "https:"; return json(response, 200, { protocolVersion: "1", instanceId: configuration.instanceId ?? "local-reference", federationEnabled: enabled, ...(enabled ? { instanceUrl: publicUrl.toString(), actorDocumentUrl: new URL("/v1/federation/actors", publicUrl).toString(), publicationInboxUrl: new URL("/v1/federation/inbox", publicUrl).toString(), capabilities: ["publication-reference", "withdrawal"] } : {}), requestId }, requestId); }
      if ((method === "GET" && url.pathname === "/ready") || (method === "GET" && url.pathname === "/diagnostics")) {
        const dependencies = await Promise.all((composition.dependencies.diagnostics ?? []).map(async (dependency) => ({ name: dependency.name, ...(await dependency.check()) })));
        const ready = dependencies.every((dependency) => dependency.status === "ok");
        return json(response, ready ? 200 : 503, { ok: ready, status: ready ? "ok" : "degraded", dependencies, requestId }, requestId);
      }
      if (!url.pathname.startsWith("/v1/")) throw new HttpError(404, "not_found", "Route was not found");

      if (method === "POST" && url.pathname === "/v1/federation/inbox") {
        const body = await parseBody(request); const envelope = body.envelope as Parameters<typeof verifyFederationEnvelope>[0];
        if (!envelope || !envelope.payload) throw new HttpError(400, "invalid_federation_reference", "A signed federation event is required");
        const event = validateRemotePublicationEvent(envelope.payload as Parameters<typeof validateRemotePublicationEvent>[0]);
        const decision = configuration.federationPolicy ? await configuration.federationPolicy.evaluateRemote({ actorId: event.actor.id, host: event.actor.host }) : "deny";
        if (decision !== "allow") throw new HttpError(403, "federation_not_accepted", "The instance policy did not accept this remote reference");
        await verifyFederationEnvelope(envelope, adapters.federation, adapters.federation);
        const actorRecord = await repositories.federationActors.get(event.actor.id) ?? await repositories.federationActors.create({ id: event.actor.id, instanceId: configuration.instanceId ?? "local-reference", actorUri: event.actor.id, host: event.actor.host });
        const existing = await repositories.remotePublicationReferences.get(event.publication.id);
        if (existing && existing.actorId !== actorRecord.id) throw new HttpError(409, "federation_reference_conflict", "A remote publication identifier cannot change actors");
        if (event.type === "publication_withdrawn") {
          if (!existing) throw new HttpError(404, "federation_reference_not_found", "The remote publication reference was not accepted");
          const reference = await repositories.remotePublicationReferences.update(existing.id, existing.revision, { state: "withdrawn" });
          await audit({ action: "federation.reference_withdrawn", subjectId: reference.id, payload: { actorId: event.actor.id, publicationUrl: event.publication.canonicalUrl } });
          return json(response, 200, { reference, requestId }, requestId);
        }
        const reference = existing
          ? await repositories.remotePublicationReferences.update(existing.id, existing.revision, { publicationUri: event.publication.canonicalUrl, immutableId: event.publication.id, state: "accepted" })
          : await repositories.remotePublicationReferences.create({ id: event.publication.id, instanceId: configuration.instanceId ?? "local-reference", actorId: actorRecord.id, publicationUri: event.publication.canonicalUrl, immutableId: event.publication.id, state: "accepted" });
        await audit({ action: event.type === "publication_updated" ? "federation.reference_updated" : "federation.reference_accepted", subjectId: reference.id, payload: { actorId: event.actor.id, publicationUrl: event.publication.canonicalUrl } });
        return json(response, existing ? 200 : 201, { reference, requestId }, requestId);
      }

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
      if (method === "POST" && completeMatch) { const identity = await session(request); const body = await parseBody(request); const object = await adapters.storage.complete({ uploadId: completeMatch[1], checksum: requireString(body.checksum, "checksum"), byteLength: Number(body.byteLength) }); const work = await ownedWork(requireString(body.workId, "workId"), identity.subject.id); const result = await repositories.transaction(async (transaction) => { const asset = await repositories.assets.create({ id: randomUUID(), instanceId: work.instanceId, creatorId: work.creatorId, workId: work.id, mimeType: object.contentType, checksum: object.checksum!, objectVersion: object.versionId!, status: "pending", storage: object } as AssetRecord & { storage: typeof object }, { transaction }); await repositories.moderationEvidence.create({ id: randomUUID(), instanceId: work.instanceId, subjectType: "asset", subjectId: asset.id, source: "local.upload", payload: { checksum: object.checksum, byteLength: object.byteLength } }, { transaction }); await repositories.auditEvents.create({ id: randomUUID(), instanceId: work.instanceId, action: "asset.upload_completed", actorId: identity.subject.id, subjectId: asset.id, payload: { workId: work.id } }, { transaction }); const job = await adapters.jobs.enqueue({ type: "asset.process", payload: { assetId: asset.id }, idempotencyKey: `asset-process:${asset.id}:${asset.objectVersion}`, maxAttempts: 3, correlationId: requestId }); return { asset, job }; }); return json(response, 202, { ...result, requestId }, requestId); }

      if (method === "POST" && url.pathname === "/v1/operations/jobs/run-next") { await session(request); const body = await parseBody(request); const result = await runNextJob(typeof body.workerId === "string" && body.workerId.trim() ? body.workerId.trim() : "local-reference-worker"); return json(response, 200, { result: result ?? null, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/jobs") { await session(request); const states = url.searchParams.getAll("state").filter((state): state is import("@ubeeq/jobs").JobState => ["queued", "leased", "completed", "retry_scheduled", "dead_lettered", "cancelled"].includes(state)); return json(response, 200, { jobs: await adapters.jobs.list({ states, limit: Number(url.searchParams.get("limit") ?? 50) }), requestId }, requestId); }
      const recoverJobMatch = url.pathname.match(/^\/v1\/operations\/jobs\/([^/]+)\/recover$/);
      if (method === "POST" && recoverJobMatch) { const identity = await session(request); const job = await adapters.jobs.recover({ id: recoverJobMatch[1] }); await audit({ action: "job.recovered", actorId: identity.subject.id, subjectId: job.id, payload: { type: job.type } }); return json(response, 200, { job, requestId }, requestId); }
      const cancelJobMatch = url.pathname.match(/^\/v1\/operations\/jobs\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelJobMatch) { const identity = await session(request); const body = await parseBody(request); await adapters.jobs.cancel({ id: cancelJobMatch[1], reason: typeof body.reason === "string" ? body.reason : undefined }); await audit({ action: "job.cancelled", actorId: identity.subject.id, subjectId: cancelJobMatch[1] }); return json(response, 204, undefined, requestId); }
      if (method === "POST" && url.pathname === "/v1/operations/holds") { const identity = await session(request); const body = await parseBody(request); const hold = await repositories.moderationHolds.create({ id: randomUUID(), instanceId: configuration.instanceId ?? "local-reference", subjectType: requireString(body.subjectType, "subjectType"), subjectId: requireString(body.subjectId, "subjectId"), state: "active", reason: typeof body.reason === "string" ? body.reason : undefined }); await audit({ action: "moderation.hold_created", actorId: identity.subject.id, subjectId: hold.subjectId, payload: { holdId: hold.id, reason: hold.reason } }); return json(response, 201, { hold, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/holds") { await session(request); return json(response, 200, { holds: (await repositories.moderationHolds.list({ limit: 100 })).items, requestId }, requestId); }
      const releaseHoldMatch = url.pathname.match(/^\/v1\/operations\/holds\/([^/]+)\/release$/);
      if (method === "POST" && releaseHoldMatch) { const identity = await session(request); const hold = await repositories.moderationHolds.get(releaseHoldMatch[1]); if (!hold) throw new HttpError(404, "hold_not_found", "Moderation hold was not found"); const released = await repositories.moderationHolds.update(hold.id, hold.revision, { state: "released" }); await audit({ action: "moderation.hold_released", actorId: identity.subject.id, subjectId: released.subjectId, payload: { holdId: released.id } }); return json(response, 200, { hold: released, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/operations/review-cases") { const identity = await session(request); const body = await parseBody(request); const reviewCase = await repositories.reviewCases.create({ id: randomUUID(), instanceId: configuration.instanceId ?? "local-reference", subjectId: requireString(body.subjectId, "subjectId"), state: "open" }); await audit({ action: "moderation.review_case_opened", actorId: identity.subject.id, subjectId: reviewCase.subjectId, payload: { reviewCaseId: reviewCase.id } }); return json(response, 201, { reviewCase, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/review-cases") { await session(request); return json(response, 200, { reviewCases: (await repositories.reviewCases.list({ limit: 100 })).items, requestId }, requestId); }

      const publicationMatch = url.pathname.match(/^\/v1\/works\/([^/]+)\/publications$/);
      if (method === "POST" && publicationMatch) { const identity = await session(request); const work = await ownedWork(publicationMatch[1], identity.subject.id); const assets = (await repositories.assets.list({ limit: 100 })).items.filter((asset) => asset.workId === work.id); if (!assets.length || assets.some((asset) => asset.status !== "ready")) throw new HttpError(409, "processing_incomplete", "All Work assets must finish processing before publication"); await requireClearAdmission("Publication", [work.id, work.creatorId, ...assets.map((asset) => asset.id)]); const body = await parseBody(request); const destination = requireString(body.destination, "destination"); const intent = await repositories.publicationIntents.create({ id: randomUUID(), instanceId: work.instanceId, workId: work.id, destination, idempotencyKey: request.headers["idempotency-key"]?.toString() || randomUUID() }); const publication = await repositories.publications.create({ id: randomUUID(), instanceId: work.instanceId, workId: work.id, destination, status: "live" }); const publishedWork = await repositories.works.update(work.id, work.revision, { status: "published" }); await audit({ action: "work.published", actorId: identity.subject.id, subjectId: work.id, payload: { publicationId: publication.id, destination } }); return json(response, 201, { intent, publication, work: publishedWork, requestId }, requestId); }
      const publicMatch = url.pathname.match(/^\/v1\/public\/works\/([^/]+)$/);
      if (method === "GET" && publicMatch) { const work = await repositories.works.get(publicMatch[1]); if (!work || work.status !== "published") throw new HttpError(404, "work_not_found", "Published work was not found"); const assets = (await repositories.assets.list({ limit: 100 })).items.filter((asset) => asset.workId === work.id && asset.status === "ready"); const publications = (await repositories.publications.list({ limit: 100 })).items.filter((publication) => publication.workId === work.id && publication.status === "live"); const delivered = await Promise.all(assets.map(async (asset) => ({ ...asset, delivery: await adapters.storage.issue({ object: { bucket: "local", key: (asset as AssetRecord & { storage: { key: string } }).storage.key, versionId: asset.objectVersion, scope: "public" }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) }))); return json(response, 200, { work, assets: delivered, publications, requestId }, requestId); }
      const deliveryMatch = url.pathname.match(/^\/v1\/delivery\/([^/]+)$/);
      if (method === "GET" && deliveryMatch) { const object = JSON.parse(Buffer.from(deliveryMatch[1], "base64url").toString("utf8")); if (object.scope !== "public") throw new HttpError(403, "delivery_denied", "This development delivery URL is not public"); const found = await adapters.storage.get(object); response.statusCode = 200; response.setHeader("content-type", found.object.contentType); response.setHeader("x-request-id", requestId); response.end(found.body); return; }
      if (method === "GET" && url.pathname === "/v1/exports/me") { const identity = await session(request); const creator = await creatorFor(identity.subject.id); const works = (await repositories.works.list({ limit: 100 })).items.filter((work) => work.creatorId === creator.id); const assets = (await repositories.assets.list({ limit: 100 })).items.filter((asset) => asset.creatorId === creator.id); const collections = (await repositories.collections.list({ limit: 100 })).items.filter((collection) => collection.creatorId === creator.id); const publications = (await repositories.publications.list({ limit: 100 })).items.filter((publication) => works.some((work) => work.id === publication.workId)); const manifest = createCreatorExport({ exportedAt: new Date().toISOString(), creator, works, assets, collections, publications }); await repositories.exportManifests.create({ id: `export-${manifest.checksum}`, instanceId: creator.instanceId, creatorId: creator.id, schemaVersion: manifest.schemaVersion, checksum: manifest.checksum, objectReference: `inline:${manifest.checksum}` }, { idempotencyKey: `export:${manifest.checksum}` }); await audit({ action: "creator.export_generated", actorId: identity.subject.id, subjectId: creator.id, payload: { checksum: manifest.checksum } }); return json(response, 200, { ...manifest, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/imports/validate") { await session(request); const body = await parseBody(request); let manifest; try { manifest = validateCreatorExport(body.manifest); } catch (error) { throw new HttpError(400, "invalid_export_manifest", error instanceof Error ? error.message : "Export manifest is invalid"); } const plan = planCreatorImport(manifest, { targetCreatorId: "validation", existingWorkIds: (await repositories.works.list({ limit: 100 })).items.map(({ id }) => id), existingAssetIds: (await repositories.assets.list({ limit: 100 })).items.map(({ id }) => id), existingCollectionIds: (await repositories.collections.list({ limit: 100 })).items.map(({ id }) => id) }); return json(response, 200, { plan, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/imports") {
        const identity = await session(request); const body = await parseBody(request); let manifest;
        try { manifest = validateCreatorExport(body.manifest); } catch (error) { throw new HttpError(400, "invalid_export_manifest", error instanceof Error ? error.message : "Export manifest is invalid"); }
        const creator = await creatorFor(identity.subject.id);
        const importId = typeof body.importId === "string" && body.importId.trim() ? body.importId.trim() : randomUUID();
        const existing = await repositories.importCheckpoints.get(importId);
        if (existing?.state === "completed") return json(response, 200, { importId, checkpoint: existing, idempotent: true, requestId }, requestId);
        const allWorks = (await repositories.works.list({ limit: 100 })).items, allAssets = (await repositories.assets.list({ limit: 100 })).items, allCollections = (await repositories.collections.list({ limit: 100 })).items;
        const plan = planCreatorImport(manifest, { targetCreatorId: creator.id, existingWorkIds: allWorks.map(({ id }) => id), existingAssetIds: allAssets.map(({ id }) => id), existingCollectionIds: allCollections.map(({ id }) => id) });
        if (body.dryRun !== false || !plan.valid) return json(response, 200, { dryRun: true, plan, requestId }, requestId);
        const checkpoint = existing ?? await repositories.importCheckpoints.create({ id: importId, instanceId: creator.instanceId, importId, state: "planned", cursor: manifest.checksum }, { idempotencyKey: `import:${importId}` });
        const running = await repositories.importCheckpoints.update(checkpoint.id, checkpoint.revision, { state: "running", cursor: manifest.checksum });
        try {
          await repositories.transaction(async (transaction) => {
            for (const work of manifest.works) await repositories.works.create({ ...work, instanceId: creator.instanceId, creatorId: creator.id, status: work.status === "published" ? "ready" : work.status }, { transaction, idempotencyKey: `import:${importId}:work:${work.id}` });
            for (const asset of manifest.assets) { const { storage: _storage, ...portableAsset } = asset as AssetRecord & { storage?: unknown }; await repositories.assets.create({ ...portableAsset, instanceId: creator.instanceId, creatorId: creator.id, status: "pending" }, { transaction, idempotencyKey: `import:${importId}:asset:${asset.id}` }); }
            for (const collection of manifest.collections) await repositories.collections.create({ ...collection, instanceId: creator.instanceId, creatorId: creator.id }, { transaction, idempotencyKey: `import:${importId}:collection:${collection.id}` });
            for (const publication of manifest.publications) await repositories.publications.create({ ...publication, instanceId: creator.instanceId, status: "draft" }, { transaction, idempotencyKey: `import:${importId}:publication:${publication.id}` });
          });
          const completed = await repositories.importCheckpoints.update(running.id, running.revision, { state: "completed", cursor: manifest.checksum });
          await audit({ action: "creator.import_completed", actorId: identity.subject.id, subjectId: creator.id, payload: { importId, checksum: manifest.checksum, plan: plan.itemCounts, originalFilesTransferred: false } });
          return json(response, 201, { importId, checkpoint: completed, plan, originalFilesTransferred: false, requestId }, requestId);
        } catch (error) { await repositories.importCheckpoints.update(running.id, running.revision, { state: "failed", cursor: manifest.checksum }).catch(() => undefined); throw error; }
      }
      throw new HttpError(404, "not_found", "Route was not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof AdmissionBlockedError ? 409 : 500;
      const code = error instanceof HttpError ? error.code : error instanceof AdmissionBlockedError ? "admission_blocked" : "internal_error";
      const message = error instanceof Error ? error.message : "Unexpected error";
      const details = error instanceof AdmissionBlockedError ? error.decision : undefined;
      json(response, status, { error: { code, message, requestId, ...(details ? { details } : {}) } }, requestId);
    }
  };
  const server = createServer((request, response) => { void handle(request, response); });
  return { server, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
};

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const port = Number(process.env.PORT ?? 4100); const dataDirectory = process.env.UBEEQ_DATA_DIRECTORY ?? "./var/reference";
  const api = createReferenceApi({ databasePath: process.env.UBEEQ_DATABASE_PATH ?? `${dataDirectory}/ubeeq.sqlite`, dataDirectory, publicBaseUrl: process.env.UBEEQ_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}` });
  const host = process.env.UBEEQ_LISTEN_HOST ?? "127.0.0.1";
  api.server.listen(port, host, () => console.log(`Ubeeq reference API listening on http://${host}:${port}`));
}
