import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createLocalAdapterSet, type LocalAdapterConfiguration } from "@ubeeq/adapters-local";
import type { IdentityAdapter, PasswordIdentityAdapter } from "@ubeeq/auth";
import { CellRoutingError, composeReferenceApplication, requireHomeCell, type DependencyDiagnostic } from "@ubeeq/api";
import type { JobQueue } from "@ubeeq/jobs";
import { AdmissionBlockedError, requireAdmission, type ReviewHold } from "@ubeeq/moderation";
import { createCreatorExport, planCreatorImport, validateCreatorExport } from "@ubeeq/portability";
import { LocalImageProcessor, type MediaProcessor } from "@ubeeq/processing";
import { validateRemotePublicationEvent, verifyFederationEnvelope, type FederationReplayStore, type FederationSignatureVerifier } from "@ubeeq/federation";
import type { FederationPolicy } from "@ubeeq/extension-sdk";
import { CellOwnershipError, type AssetRecord, type CreatorRecord, type UbeeqRepositories, type WorkRecord } from "@ubeeq/persistence";
import { cellScopedObjectKey, type DeliveryAdapter, type ObjectStorage, type UploadAdapter, type UploadContentAdapter } from "@ubeeq/storage";

const json = (response: ServerResponse, status: number, body: unknown, requestId: string): void => {
  response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("x-request-id", requestId); response.end(JSON.stringify(body));
};
class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const requireString = (value: unknown, field: string): string => { if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "invalid_request", `${field} is required`); return value.trim(); };
const pageRequest = (url: URL) => ({ cursor: url.searchParams.get("cursor") || undefined, limit: Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 50) || 50)) });
const parseBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = []; let size = 0;
  request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 10 * 1024 * 1024) reject(new HttpError(413, "payload_too_large", "Request body exceeds 10 MiB")); else chunks.push(chunk); });
  request.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new HttpError(400, "invalid_json", "Request body must be JSON")); } });
  request.on("error", reject);
});

export type ReferenceAdapterSet = {
  repositories: UbeeqRepositories;
  storage: ObjectStorage;
  uploads: UploadAdapter & Partial<UploadContentAdapter>;
  delivery: DeliveryAdapter;
  jobs: JobQueue;
  identity: IdentityAdapter;
  localIdentity?: PasswordIdentityAdapter;
  federation?: FederationSignatureVerifier & FederationReplayStore & { keyId: string; publicKey: string };
};

export interface ReferenceApiConfiguration extends Partial<LocalAdapterConfiguration> {
  publicBaseUrl: string;
  instanceId?: string;
  cellId?: string;
  region?: string;
  operator?: string;
  federationPolicy?: FederationPolicy;
  federationVerifier?: FederationSignatureVerifier;
  mediaProcessor?: MediaProcessor;
  adapters?: ReferenceAdapterSet;
  diagnostics?: readonly DependencyDiagnostic[];
}

export const createReferenceApi = (configuration: ReferenceApiConfiguration): { server: Server; handle(request: IncomingMessage, response: ServerResponse): Promise<void>; runNextJob(workerId: string): Promise<unknown>; close(): Promise<void> } => {
  const cellId = configuration.cellId ?? "local-single-cell";
  const region = configuration.region ?? "local";
  const cellOwned = { homeCellId: cellId, dataHomeRegion: region, dataHomeAssignedAt: new Date().toISOString(), routingRevision: 1 };
  const dataHomeOf = (record: Pick<CreatorRecord, "homeCellId" | "dataHomeRegion" | "dataHomeAssignedAt" | "routingRevision">) => ({ homeCellId: record.homeCellId, dataHomeRegion: record.dataHomeRegion, dataHomeAssignedAt: record.dataHomeAssignedAt, routingRevision: record.routingRevision });
  const localConfiguration: LocalAdapterConfiguration = {
    databasePath: configuration.databasePath ?? "./var/reference/ubeeq.sqlite",
    dataDirectory: configuration.dataDirectory ?? "./var/reference",
    publicBaseUrl: configuration.publicBaseUrl,
    cellId,
    sessionTtlSeconds: configuration.sessionTtlSeconds,
    credentialEncryptionKey: configuration.credentialEncryptionKey,
  };
  const localAdapters = configuration.adapters ? undefined : createLocalAdapterSet(localConfiguration);
  const adapters: ReferenceAdapterSet = configuration.adapters ?? {
    repositories: localAdapters!.repositories, storage: localAdapters!.storage, uploads: localAdapters!.storage,
    delivery: localAdapters!.storage, jobs: localAdapters!.jobs, identity: localAdapters!.identity,
    localIdentity: localAdapters!.identity, federation: localAdapters!.federation,
  };
  const composition = composeReferenceApplication({
    instanceId: configuration.instanceId ?? "local-reference",
    cell: { id: cellId, region, operator: configuration.operator ?? "self-hosted" },
    publicBaseUrl: configuration.publicBaseUrl,
    extensions: [], requiredExtensions: {},
    ...(configuration.adapters ? {} : { localAdapter: { sqliteDatabasePath: localConfiguration.databasePath, storageDirectory: localConfiguration.dataDirectory } })
  }, {
    identity: adapters.identity, repositories: adapters.repositories, objectStorage: adapters.storage, delivery: adapters.delivery, jobs: adapters.jobs,
    diagnostics: configuration.diagnostics ?? [{ name: configuration.adapters ? "persistence" : "sqlite", check: async () => { await adapters.repositories.creators.list({ limit: 1 }); return { status: "ok" as const }; } }]
  });
  const { repositories } = composition.dependencies;
  const processor = configuration.mediaProcessor ?? new LocalImageProcessor();

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
  const ownedWork = async (workId: string, subjectId: string): Promise<WorkRecord> => {
    const work = await repositories.works.get(workId);
    if (!work) throw new HttpError(404, "work_not_found", "Work was not found");
    const creator = await creatorFor(subjectId);
    requireHomeCell({ cellId }, creator);
    requireHomeCell({ cellId }, work);
    if (work.creatorId !== creator.id) throw new HttpError(403, "work_not_owned", "Work does not belong to the current creator");
    if (work.dataHomeRegion !== creator.dataHomeRegion || work.routingRevision !== creator.routingRevision) throw new HttpError(409, "data_home_mismatch", "Work and creator data homes do not match");
    return work;
  };
  const audit = async (input: { action: string; actorId?: string; subjectId?: string; payload?: Record<string, unknown> }): Promise<void> => {
    await repositories.auditEvents.create({ id: randomUUID(), instanceId: configuration.instanceId ?? "local-reference", ...cellOwned, action: input.action, actorId: input.actorId, subjectId: input.subjectId, payload: input.payload ?? {} });
  };
  const requireClearAdmission = async (operation: string, subjectIds: readonly string[]): Promise<void> => {
    const holds = (await repositories.moderationHolds.list({ limit: 100 })).items
      .filter((hold) => hold.state === "active" && subjectIds.includes(hold.subjectId))
      .map((hold): ReviewHold => ({ id: hold.id, cellId: hold.homeCellId, subjectId: hold.subjectId, active: true, sourceId: hold.id, reasonCode: hold.reason ?? "review_hold", createdAt: hold.createdAt }));
    requireAdmission(subjectIds.map((subjectId) => ({ subjectId })), holds, operation);
  };
  const existingImportIds = async () => ({ publication: (await repositories.publications.list({ limit: 100 })).items.map(({ id }) => id), publicationIntent: (await repositories.publicationIntents.list({ limit: 100 })).items.map(({ id }) => id), moderationEvidence: (await repositories.moderationEvidence.list({ limit: 100 })).items.map(({ id }) => id), moderationHold: (await repositories.moderationHolds.list({ limit: 100 })).items.map(({ id }) => id), reviewCase: (await repositories.reviewCases.list({ limit: 100 })).items.map(({ id }) => id), auditEvent: (await repositories.auditEvents.list({ limit: 100 })).items.map(({ id }) => id), usageEvent: (await repositories.usageEvents.list({ limit: 100 })).items.map(({ id }) => id), integrationAccount: (await repositories.integrationAccounts.list({ limit: 100 })).items.map(({ id }) => id) });
  const runNextJob = async (workerId: string) => {
    const lease = await adapters.jobs.lease<{ assetId: string }>({ cellId, types: ["asset.process"], leaseDurationSeconds: 60, workerId });
    if (!lease) return undefined;
    try {
      if (lease.job.cellId !== cellId) throw new Error(`Foreign-cell job ${lease.job.cellId} rejected by ${cellId}`);
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
      const rendition = { bucket: cellId, key: cellScopedObjectKey({ cellId, creatorId: processing.creatorId, kind: "renditions", objectId: processing.id }), versionId: randomUUID(), contentType: processing.mimeType, byteLength: source.body.byteLength, checksum: processing.checksum, scope: "public" as const };
      await adapters.storage.put({ object: rendition, body: source.body });
      const processed = await repositories.transaction(async (transaction) => {
        const ready = await repositories.assets.update(processing.id, processing.revision, { status: "ready", storage: rendition, originalStorage: storage } as Partial<AssetRecord>, { transaction });
        await repositories.moderationEvidence.create({ id: randomUUID(), instanceId: processing.instanceId, ...dataHomeOf(processing), subjectType: "asset", subjectId: processing.id, source: "local.processing", payload: { checksum: processing.checksum, sourceVersionId: processing.objectVersion, ...processingResult.metadata, renditions: processingResult.renditions, outputLineage: processingResult.renditions.map((rendition) => ({ outputId: rendition.id, sourceVersionId: rendition.sourceVersionId, role: rendition.role })) } }, { transaction });
        await repositories.usageEvents.create({ id: randomUUID(), instanceId: processing.instanceId, ...dataHomeOf(processing), accountId: processing.creatorId, meter: "processing_units", quantity: 1, idempotencyKey: `asset-processing:${processing.id}:${processing.objectVersion}` }, { transaction, idempotencyKey: `asset-processing:${processing.id}:${processing.objectVersion}` });
        await repositories.auditEvents.create({ id: randomUUID(), instanceId: processing.instanceId, ...dataHomeOf(processing), action: "asset.processing_completed", subjectId: processing.id, payload: { jobId: lease.job.id, sourceVersionId: processing.objectVersion } }, { transaction });
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
      if (method === "GET" && url.pathname === "/.well-known/ubeeq") { const publicUrl = new URL(configuration.publicBaseUrl); const enabled = publicUrl.protocol === "https:" && !!adapters.federation; return json(response, 200, { protocolVersion: "1", instanceId: configuration.instanceId ?? "local-reference", federationEnabled: enabled, ...(enabled ? { instanceUrl: publicUrl.toString(), actorDocumentUrl: new URL("/v1/federation/actors", publicUrl).toString(), publicationInboxUrl: new URL("/v1/federation/inbox", publicUrl).toString(), signingKeyId: adapters.federation!.keyId, signingPublicKey: adapters.federation!.publicKey, capabilities: ["publication-reference", "withdrawal"] } : {}), requestId }, requestId); }
      if ((method === "GET" && url.pathname === "/ready") || (method === "GET" && url.pathname === "/diagnostics")) {
        const dependencies = await Promise.all((composition.dependencies.diagnostics ?? []).map(async (dependency) => ({ name: dependency.name, ...(await dependency.check()) })));
        const ready = dependencies.every((dependency) => dependency.status === "ok");
        return json(response, ready ? 200 : 503, { ok: ready, status: ready ? "ok" : "degraded", cell: composition.configuration.cell, routingRevision: 1, dependencies, requestId }, requestId);
      }
      if (!url.pathname.startsWith("/v1/")) throw new HttpError(404, "not_found", "Route was not found");

      if (method === "POST" && url.pathname === "/v1/federation/inbox") {
        const body = await parseBody(request); const envelope = body.envelope as Parameters<typeof verifyFederationEnvelope>[0];
        if (!envelope || !envelope.payload) throw new HttpError(400, "invalid_federation_reference", "A signed federation event is required");
        const event = validateRemotePublicationEvent(envelope.payload as Parameters<typeof validateRemotePublicationEvent>[0]);
        const decision = configuration.federationPolicy ? await configuration.federationPolicy.evaluateRemote({ actorId: event.actor.id, host: event.actor.host }) : "deny";
        if (decision !== "allow") throw new HttpError(403, "federation_not_accepted", "The instance policy did not accept this remote reference");
        if (!adapters.federation && !configuration.federationVerifier) throw new HttpError(503, "federation_unavailable", "Federation verification is not configured");
        await verifyFederationEnvelope(envelope, configuration.federationVerifier ?? adapters.federation!, adapters.federation!);
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

      if (method === "POST" && url.pathname === "/v1/auth/sign-up") { if (!adapters.localIdentity) throw new HttpError(404, "local_auth_unavailable", "This instance uses an external identity provider"); const body = await parseBody(request); const account = await adapters.localIdentity.register({ email: requireString(body.email, "email"), password: requireString(body.password, "password") }); return json(response, 201, { account, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/auth/sign-in") { if (!adapters.localIdentity) throw new HttpError(404, "local_auth_unavailable", "This instance uses an external identity provider"); const body = await parseBody(request); const result = await adapters.localIdentity.authenticate({ email: requireString(body.email, "email"), password: requireString(body.password, "password") }); return json(response, 200, { token: result.token, expiresAt: result.session.expiresAt, requestId }, requestId); }

      if (method === "POST" && url.pathname === "/v1/creators") { const identity = await session(request); const body = await parseBody(request); const creator = await repositories.creators.create({ id: randomUUID(), instanceId: configuration.instanceId ?? "local-reference", ...cellOwned, handle: requireString(body.handle, "handle"), displayName: requireString(body.displayName, "displayName"), subjectId: identity.subject.id }); return json(response, 201, { creator, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/creators/me") { const identity = await session(request); return json(response, 200, { creator: await creatorFor(identity.subject.id), requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/works") { const identity = await session(request); const creator = await creatorFor(identity.subject.id); requireHomeCell({ cellId }, creator); const body = await parseBody(request); const work = await repositories.works.create({ id: randomUUID(), instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, title: requireString(body.title, "title"), status: "draft" }); return json(response, 201, { work, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/collections") { const identity = await session(request); const creator = await creatorFor(identity.subject.id); requireHomeCell({ cellId }, creator); const body = await parseBody(request); const collection = await repositories.collections.create({ id: randomUUID(), instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, title: requireString(body.title, "title"), visibility: body.visibility === "public" || body.visibility === "unlisted" ? body.visibility : "private" }); return json(response, 201, { collection, requestId }, requestId); }

      if (method === "POST" && url.pathname === "/v1/uploads") { const identity = await session(request); const body = await parseBody(request); const work = await ownedWork(requireString(body.workId, "workId"), identity.subject.id); requireHomeCell({ cellId }, work); const byteLength = Number(body.byteLength); if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new HttpError(400, "invalid_request", "byteLength must be a non-negative integer"); const object = { bucket: cellId, key: cellScopedObjectKey({ cellId, creatorId: work.creatorId, kind: "uploads", objectId: randomUUID() }), contentType: requireString(body.mimeType, "mimeType"), byteLength, scope: "private" as const }; const upload = await adapters.uploads.initiate({ object, checksumAlgorithm: "sha256", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }); return json(response, 201, { upload, requestId }, requestId); }
      const contentMatch = url.pathname.match(/^\/v1\/uploads\/([^/]+)\/content$/);
      if (method === "PUT" && contentMatch) { const identity = await session(request); if (!adapters.uploads.accept) throw new HttpError(405, "direct_upload_required", "Upload content must be sent to the issued direct-upload URL"); const creator = await creatorFor(identity.subject.id); const body = await parseBody(request); const base64 = requireString(body.base64, "base64"); await adapters.uploads.accept({ uploadId: contentMatch[1], cellId, creatorId: creator.id, body: Buffer.from(base64, "base64"), operation: "upload_content" }); return json(response, 204, undefined, requestId); }
      const completeMatch = url.pathname.match(/^\/v1\/uploads\/([^/]+)\/complete$/);
      if (method === "POST" && completeMatch) { const identity = await session(request); const body = await parseBody(request); const work = await ownedWork(requireString(body.workId, "workId"), identity.subject.id); const object = await adapters.uploads.complete({ uploadId: completeMatch[1], cellId, creatorId: work.creatorId, checksum: requireString(body.checksum, "checksum"), byteLength: Number(body.byteLength) }); const result = await repositories.transaction(async (transaction) => { const asset = await repositories.assets.create({ id: randomUUID(), instanceId: work.instanceId, ...dataHomeOf(work), creatorId: work.creatorId, workId: work.id, mimeType: object.contentType, checksum: object.checksum!, objectVersion: object.versionId!, status: "pending", storage: object } as AssetRecord & { storage: typeof object }, { transaction }); await repositories.moderationEvidence.create({ id: randomUUID(), instanceId: work.instanceId, ...dataHomeOf(work), subjectType: "asset", subjectId: asset.id, source: "reference.upload", payload: { checksum: object.checksum, byteLength: object.byteLength } }, { transaction }); await repositories.auditEvents.create({ id: randomUUID(), instanceId: work.instanceId, ...dataHomeOf(work), action: "asset.upload_completed", actorId: identity.subject.id, subjectId: asset.id, payload: { workId: work.id } }, { transaction }); const job = await adapters.jobs.enqueue({ cellId, type: "asset.process", payload: { assetId: asset.id }, idempotencyKey: `asset-process:${asset.id}:${asset.objectVersion}`, maxAttempts: 3, correlationId: requestId }); return { asset, job }; }); return json(response, 202, { ...result, requestId }, requestId); }

      if (method === "POST" && url.pathname === "/v1/operations/jobs/run-next") { await session(request); const body = await parseBody(request); const result = await runNextJob(typeof body.workerId === "string" && body.workerId.trim() ? body.workerId.trim() : "local-reference-worker"); return json(response, 200, { result: result ?? null, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/jobs") { await session(request); const states = url.searchParams.getAll("state").filter((state): state is import("@ubeeq/jobs").JobState => ["queued", "leased", "completed", "retry_scheduled", "dead_lettered", "cancelled"].includes(state)); return json(response, 200, { jobs: await adapters.jobs.list({ cellId, states, limit: Number(url.searchParams.get("limit") ?? 50) }), requestId }, requestId); }
      const recoverJobMatch = url.pathname.match(/^\/v1\/operations\/jobs\/([^/]+)\/recover$/);
      if (method === "POST" && recoverJobMatch) { const identity = await session(request); const existingJob = await adapters.jobs.get(recoverJobMatch[1]); if (!existingJob) throw new HttpError(404, "job_not_found", "Job was not found"); if (existingJob.cellId !== cellId) throw new CellRoutingError(cellId, existingJob.cellId); const job = await adapters.jobs.recover({ id: existingJob.id }); await audit({ action: "job.recovered", actorId: identity.subject.id, subjectId: job.id, payload: { type: job.type } }); return json(response, 200, { job, requestId }, requestId); }
      const cancelJobMatch = url.pathname.match(/^\/v1\/operations\/jobs\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelJobMatch) { const identity = await session(request); const body = await parseBody(request); const job = await adapters.jobs.get(cancelJobMatch[1]); if (!job) throw new HttpError(404, "job_not_found", "Job was not found"); if (job.cellId !== cellId) throw new CellRoutingError(cellId, job.cellId); await adapters.jobs.cancel({ id: job.id, reason: typeof body.reason === "string" ? body.reason : undefined }); await audit({ action: "job.cancelled", actorId: identity.subject.id, subjectId: job.id }); return json(response, 204, undefined, requestId); }
      if (method === "POST" && url.pathname === "/v1/operations/holds") { const identity = await session(request); const body = await parseBody(request); const hold = await repositories.moderationHolds.create({ id: randomUUID(), instanceId: configuration.instanceId ?? "local-reference", ...cellOwned, subjectType: requireString(body.subjectType, "subjectType"), subjectId: requireString(body.subjectId, "subjectId"), state: "active", reason: typeof body.reason === "string" ? body.reason : undefined }); await audit({ action: "moderation.hold_created", actorId: identity.subject.id, subjectId: hold.subjectId, payload: { holdId: hold.id, reason: hold.reason } }); return json(response, 201, { hold, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/holds") { await session(request); const page = await repositories.moderationHolds.list(pageRequest(url)); return json(response, 200, { cell: { cellId, region, routingRevision: 1 }, holds: page.items, nextCursor: page.nextCursor, requestId }, requestId); }
      const releaseHoldMatch = url.pathname.match(/^\/v1\/operations\/holds\/([^/]+)\/release$/);
      if (method === "POST" && releaseHoldMatch) { const identity = await session(request); const hold = await repositories.moderationHolds.get(releaseHoldMatch[1]); if (!hold) throw new HttpError(404, "hold_not_found", "Moderation hold was not found"); requireHomeCell({ cellId }, hold); const released = await repositories.moderationHolds.update(hold.id, hold.revision, { state: "released" }); await audit({ action: "moderation.hold_released", actorId: identity.subject.id, subjectId: released.subjectId, payload: { holdId: released.id } }); return json(response, 200, { hold: released, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/operations/review-cases") { const identity = await session(request); const body = await parseBody(request); const reviewCase = await repositories.reviewCases.create({ id: randomUUID(), instanceId: configuration.instanceId ?? "local-reference", ...cellOwned, subjectId: requireString(body.subjectId, "subjectId"), state: "open" }); await audit({ action: "moderation.review_case_opened", actorId: identity.subject.id, subjectId: reviewCase.subjectId, payload: { reviewCaseId: reviewCase.id } }); return json(response, 201, { reviewCase, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/review-cases") { await session(request); const page = await repositories.reviewCases.list(pageRequest(url)); return json(response, 200, { cell: { cellId, region, routingRevision: 1 }, reviewCases: page.items, nextCursor: page.nextCursor, requestId }, requestId); }
      const reviewCaseMatch = url.pathname.match(/^\/v1\/operations\/review-cases\/([^/]+)$/);
      if (method === "POST" && reviewCaseMatch) { const identity = await session(request); const existing = await repositories.reviewCases.get(reviewCaseMatch[1]); if (!existing) throw new HttpError(404, "review_case_not_found", "Review case was not found"); requireHomeCell({ cellId }, existing); const body = await parseBody(request); const state = requireString(body.state, "state"); if (!["open", "assigned", "decided", "closed"].includes(state)) throw new HttpError(400, "invalid_request", "Review case state is invalid"); const updated = await repositories.reviewCases.update(existing.id, existing.revision, { state: state as typeof existing.state, assigneeId: typeof body.assigneeId === "string" ? body.assigneeId : existing.assigneeId }); await audit({ action: "moderation.review_case_updated", actorId: identity.subject.id, subjectId: updated.subjectId, payload: { reviewCaseId: updated.id, state: updated.state } }); return json(response, 200, { reviewCase: updated, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/moderation-evidence") { await session(request); const page = await repositories.moderationEvidence.list(pageRequest(url)); return json(response, 200, { cell: { cellId, region, routingRevision: 1 }, evidence: page.items, nextCursor: page.nextCursor, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/audit-events") { await session(request); const page = await repositories.auditEvents.list(pageRequest(url)); return json(response, 200, { cell: { cellId, region, routingRevision: 1 }, events: page.items, nextCursor: page.nextCursor, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/usage-events") { await session(request); const page = await repositories.usageEvents.list(pageRequest(url)); return json(response, 200, { cell: { cellId, region, routingRevision: 1 }, events: page.items, nextCursor: page.nextCursor, requestId }, requestId); }

      const publicationMatch = url.pathname.match(/^\/v1\/works\/([^/]+)\/publications$/);
      if (method === "POST" && publicationMatch) { const identity = await session(request); const work = await ownedWork(publicationMatch[1], identity.subject.id); const assets = (await repositories.assets.list({ limit: 100 })).items.filter((asset) => asset.workId === work.id); if (!assets.length || assets.some((asset) => asset.status !== "ready")) throw new HttpError(409, "processing_incomplete", "All Work assets must finish processing before publication"); await requireClearAdmission("Publication", [work.id, work.creatorId, ...assets.map((asset) => asset.id)]); const body = await parseBody(request); const destination = requireString(body.destination, "destination"); const intent = await repositories.publicationIntents.create({ id: randomUUID(), instanceId: work.instanceId, ...dataHomeOf(work), workId: work.id, destination, idempotencyKey: request.headers["idempotency-key"]?.toString() || randomUUID() }); const publication = await repositories.publications.create({ id: randomUUID(), instanceId: work.instanceId, ...dataHomeOf(work), workId: work.id, destination, status: "live" }); const publishedWork = await repositories.works.update(work.id, work.revision, { status: "published" }); await audit({ action: "work.published", actorId: identity.subject.id, subjectId: work.id, payload: { publicationId: publication.id, destination } }); return json(response, 201, { intent, publication, work: publishedWork, requestId }, requestId); }
      const publicMatch = url.pathname.match(/^\/v1\/public\/works\/([^/]+)$/);
      if (method === "GET" && publicMatch) { const work = await repositories.works.get(publicMatch[1]); if (!work || work.status !== "published") throw new HttpError(404, "work_not_found", "Published work was not found"); const assets = (await repositories.assets.list({ limit: 100 })).items.filter((asset) => asset.workId === work.id && asset.status === "ready"); const publications = (await repositories.publications.list({ limit: 100 })).items.filter((publication) => publication.workId === work.id && publication.status === "live"); const delivered = await Promise.all(assets.map(async (asset) => { const storage = (asset as AssetRecord & { storage: { key: string; versionId?: string } }).storage; return { ...asset, delivery: await adapters.delivery.issue({ object: { bucket: cellId, key: storage.key, versionId: storage.versionId, scope: "public" }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) }; })); return json(response, 200, { work, assets: delivered, publications, requestId }, requestId); }
      const deliveryMatch = url.pathname.match(/^\/v1\/delivery\/([^/]+)$/);
      if (method === "GET" && deliveryMatch) { const developmentStorage = adapters.storage as ObjectStorage & { verifyDeliveryToken(token: string): { bucket: string; key: string; versionId?: string; scope: string; disposition?: string } }; if (typeof developmentStorage.verifyDeliveryToken !== "function") throw new HttpError(404, "delivery_not_found", "This delivery URL is served by the configured delivery provider"); let object; try { object = developmentStorage.verifyDeliveryToken(deliveryMatch[1]); } catch { throw new HttpError(403, "delivery_denied", "Delivery token is invalid or expired"); } if (object.scope !== "public") throw new HttpError(403, "delivery_denied", "This development delivery URL is not public"); const found = await adapters.storage.get(object); response.statusCode = 200; response.setHeader("content-type", found.object.contentType); if (object.disposition) response.setHeader("content-disposition", object.disposition); response.setHeader("cache-control", "public, max-age=300, s-maxage=3600"); response.setHeader("x-request-id", requestId); response.end(found.body); return; }
      if (method === "GET" && url.pathname === "/v1/exports/me") {
        const identity = await session(request); const creator = await creatorFor(identity.subject.id); requireHomeCell({ cellId }, creator);
        const works = (await repositories.works.list({ limit: 100 })).items.filter((record) => record.creatorId === creator.id); const workIds = new Set(works.map(({ id }) => id));
        const assets = (await repositories.assets.list({ limit: 100 })).items.filter((record) => record.creatorId === creator.id); const collections = (await repositories.collections.list({ limit: 100 })).items.filter((record) => record.creatorId === creator.id);
        const publications = (await repositories.publications.list({ limit: 100 })).items.filter((record) => workIds.has(record.workId)); const publicationIntents = (await repositories.publicationIntents.list({ limit: 100 })).items.filter((record) => workIds.has(record.workId));
        const subjectIds = new Set([creator.id, ...works.map(({ id }) => id), ...assets.map(({ id }) => id)]); const moderationEvidence = (await repositories.moderationEvidence.list({ limit: 100 })).items.filter((record) => subjectIds.has(record.subjectId)); const moderationHolds = (await repositories.moderationHolds.list({ limit: 100 })).items.filter((record) => subjectIds.has(record.subjectId)); const reviewCases = (await repositories.reviewCases.list({ limit: 100 })).items.filter((record) => subjectIds.has(record.subjectId)); const auditEvents = (await repositories.auditEvents.list({ limit: 100 })).items.filter((record) => Boolean(record.subjectId && subjectIds.has(record.subjectId))); const usageEvents = (await repositories.usageEvents.list({ limit: 100 })).items.filter((record) => record.accountId === creator.id);
        const integrationAccounts = (await repositories.integrationAccounts.list({ limit: 100 })).items.filter((record) => record.creatorId === creator.id).map(({ credentialReference: _credentialReference, ...record }) => ({ ...record, credentialExcluded: true as const })); const exportCheckpoints = (await repositories.exportManifests.list({ limit: 100 })).items.filter((record) => record.creatorId === creator.id); const importCheckpoints = (await repositories.importCheckpoints.list({ limit: 100 })).items.filter((record) => record.creatorId === creator.id);
        const objectInventory = assets.map((asset) => { const storage = (asset as AssetRecord & { storage?: { key?: string; versionId?: string; byteLength?: number } }).storage; return { assetId: asset.id, key: storage?.key, versionId: storage?.versionId ?? asset.objectVersion, checksum: asset.checksum, byteLength: storage?.byteLength, transferState: "manifest_only" as const }; }); const processing = assets.map((asset) => ({ id: `asset-processing:${asset.id}`, assetId: asset.id, ...dataHomeOf(asset), state: asset.status }));
        const manifest = createCreatorExport({ exportedAt: new Date().toISOString(), creator, works, assets, collections, publications, publicationIntents, processing, moderationEvidence, moderationHolds, reviewCases, auditEvents, usageEvents, integrationAccounts, exportCheckpoints, importCheckpoints, objectInventory }); await repositories.exportManifests.create({ id: `export-${manifest.checksum}`, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, schemaVersion: manifest.schemaVersion, checksum: manifest.checksum, objectReference: `inline:${manifest.checksum}` }, { idempotencyKey: `export:${manifest.checksum}` }); await audit({ action: "creator.export_generated", actorId: identity.subject.id, subjectId: creator.id, payload: { checksum: manifest.checksum } }); return json(response, 200, { ...manifest, requestId }, requestId);
      }
      if (method === "POST" && url.pathname === "/v1/imports/validate") { await session(request); const body = await parseBody(request); let manifest; try { manifest = validateCreatorExport(body.manifest); } catch (error) { throw new HttpError(400, "invalid_export_manifest", error instanceof Error ? error.message : "Export manifest is invalid"); } const plan = planCreatorImport(manifest, { targetCreatorId: "validation", existingWorkIds: (await repositories.works.list({ limit: 100 })).items.map(({ id }) => id), existingAssetIds: (await repositories.assets.list({ limit: 100 })).items.map(({ id }) => id), existingCollectionIds: (await repositories.collections.list({ limit: 100 })).items.map(({ id }) => id), existingIds: await existingImportIds() }); return json(response, 200, { plan, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/imports") {
        const identity = await session(request); const body = await parseBody(request); let manifest;
        try { manifest = validateCreatorExport(body.manifest); } catch (error) { throw new HttpError(400, "invalid_export_manifest", error instanceof Error ? error.message : "Export manifest is invalid"); }
        const creator = await creatorFor(identity.subject.id);
        const importId = typeof body.importId === "string" && body.importId.trim() ? body.importId.trim() : randomUUID();
        const existing = await repositories.importCheckpoints.get(importId);
        if (existing?.state === "completed") return json(response, 200, { importId, checkpoint: existing, idempotent: true, requestId }, requestId);
        const allWorks = (await repositories.works.list({ limit: 100 })).items, allAssets = (await repositories.assets.list({ limit: 100 })).items, allCollections = (await repositories.collections.list({ limit: 100 })).items;
        const plan = planCreatorImport(manifest, { targetCreatorId: creator.id, existingWorkIds: allWorks.map(({ id }) => id), existingAssetIds: allAssets.map(({ id }) => id), existingCollectionIds: allCollections.map(({ id }) => id), existingIds: await existingImportIds() });
        if (body.dryRun !== false || !plan.valid) return json(response, 200, { dryRun: true, plan, requestId }, requestId);
        const checkpoint = existing ?? await repositories.importCheckpoints.create({ id: importId, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, importId, state: "planned", cursor: manifest.checksum }, { idempotencyKey: `import:${importId}` });
        const running = await repositories.importCheckpoints.update(checkpoint.id, checkpoint.revision, { state: "running", cursor: manifest.checksum });
        try {
          await repositories.transaction(async (transaction) => {
            for (const work of manifest.works) await repositories.works.create({ ...work, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, status: work.status === "published" ? "ready" : work.status }, { transaction, idempotencyKey: `import:${importId}:work:${work.id}` });
            for (const asset of manifest.assets) { const { storage: _storage, originalStorage: _originalStorage, ...portableAsset } = asset as AssetRecord & { storage?: unknown; originalStorage?: unknown }; await repositories.assets.create({ ...portableAsset, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, status: "pending" }, { transaction, idempotencyKey: `import:${importId}:asset:${asset.id}` }); }
            for (const collection of manifest.collections) await repositories.collections.create({ ...collection, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id }, { transaction, idempotencyKey: `import:${importId}:collection:${collection.id}` });
            for (const publication of manifest.publications) await repositories.publications.create({ ...publication, instanceId: creator.instanceId, ...dataHomeOf(creator), status: "draft" }, { transaction, idempotencyKey: `import:${importId}:publication:${publication.id}` });
            for (const intent of manifest.publicationIntents) await repositories.publicationIntents.create({ ...intent, instanceId: creator.instanceId, ...dataHomeOf(creator) }, { transaction, idempotencyKey: `import:${importId}:intent:${intent.id}` });
            for (const evidence of manifest.moderationEvidence) await repositories.moderationEvidence.create({ ...evidence, instanceId: creator.instanceId, ...dataHomeOf(creator) }, { transaction, idempotencyKey: `import:${importId}:evidence:${evidence.id}` });
            for (const hold of manifest.moderationHolds) await repositories.moderationHolds.create({ ...hold, instanceId: creator.instanceId, ...dataHomeOf(creator) }, { transaction, idempotencyKey: `import:${importId}:hold:${hold.id}` });
            for (const reviewCase of manifest.reviewCases) await repositories.reviewCases.create({ ...reviewCase, instanceId: creator.instanceId, ...dataHomeOf(creator) }, { transaction, idempotencyKey: `import:${importId}:review:${reviewCase.id}` });
            for (const event of manifest.auditEvents) await repositories.auditEvents.create({ ...event, instanceId: creator.instanceId, ...dataHomeOf(creator), actorId: undefined }, { transaction, idempotencyKey: `import:${importId}:audit:${event.id}` });
            for (const event of manifest.usageEvents) await repositories.usageEvents.create({ ...event, instanceId: creator.instanceId, ...dataHomeOf(creator), accountId: creator.id }, { transaction, idempotencyKey: `import:${importId}:usage:${event.id}` });
            for (const account of manifest.integrationAccounts) { const { credentialExcluded: _credentialExcluded, ...portableAccount } = account; await repositories.integrationAccounts.create({ ...portableAccount, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, health: "blocked", credentialReference: undefined }, { transaction, idempotencyKey: `import:${importId}:integration:${account.id}` }); }
          });
          const completed = await repositories.importCheckpoints.update(running.id, running.revision, { state: "completed", cursor: manifest.checksum });
          await audit({ action: "creator.import_completed", actorId: identity.subject.id, subjectId: creator.id, payload: { importId, checksum: manifest.checksum, plan: plan.itemCounts, originalFilesTransferred: false } });
          return json(response, 201, { importId, checkpoint: completed, plan, originalFilesTransferred: false, requestId }, requestId);
        } catch (error) { await repositories.importCheckpoints.update(running.id, running.revision, { state: "failed", cursor: manifest.checksum }).catch(() => undefined); throw error; }
      }
      throw new HttpError(404, "not_found", "Route was not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof AdmissionBlockedError ? 409 : error instanceof CellRoutingError || error instanceof CellOwnershipError ? 409 : 500;
      const code = error instanceof HttpError ? error.code : error instanceof AdmissionBlockedError ? "admission_blocked" : error instanceof CellRoutingError || error instanceof CellOwnershipError ? "foreign_cell" : "internal_error";
      const message = error instanceof Error ? error.message : "Unexpected error";
      const details = error instanceof AdmissionBlockedError ? error.decision : undefined;
      json(response, status, { error: { code, message, requestId, ...(details ? { details } : {}) } }, requestId);
    }
  };
  const server = createServer((request, response) => { void handle(request, response); });
  return { server, handle, runNextJob, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
};

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const port = Number(process.env.PORT ?? 4100); const dataDirectory = process.env.UBEEQ_DATA_DIRECTORY ?? "./var/reference";
  const api = createReferenceApi({ databasePath: process.env.UBEEQ_DATABASE_PATH ?? `${dataDirectory}/ubeeq.sqlite`, dataDirectory, publicBaseUrl: process.env.UBEEQ_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`, cellId: process.env.UBEEQ_CELL_ID ?? "local-single-cell", region: process.env.UBEEQ_CELL_REGION ?? "local", operator: process.env.UBEEQ_CELL_OPERATOR ?? "self-hosted" });
  const host = process.env.UBEEQ_LISTEN_HOST ?? "127.0.0.1";
  api.server.listen(port, host, () => console.log(`Ubeeq reference API listening on http://${host}:${port}`));
}
