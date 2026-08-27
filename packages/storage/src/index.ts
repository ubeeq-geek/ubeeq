import { createHash } from "node:crypto";

/** Storage and delivery ports with no product-specific retention or access policy. */
export type ObjectAccessScope = "private" | "restricted" | "public";

export interface StoredObject {
  bucket: string;
  key: string;
  versionId?: string;
  contentType: string;
  byteLength: number;
  checksum?: string;
  scope: ObjectAccessScope;
}

export interface ObjectStorage {
  put(input: { object: StoredObject; body: Uint8Array }): Promise<void>;
  get(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<{ object: StoredObject; body: Uint8Array }>;
  remove(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<void>;
}

export interface DeliveryRequest {
  object: Pick<StoredObject, "bucket" | "key" | "versionId" | "scope">;
  expiresAt: string;
  disposition?: "inline" | "attachment";
}

export interface DeliveryAdapter {
  issue(request: DeliveryRequest): Promise<{ url: string; expiresAt: string }>;
  revoke?(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<void>;
}

export interface UploadInitiation {
  uploadId: string;
  object: StoredObject;
  parts?: readonly { partNumber: number; url: string; expiresAt: string }[];
  completeUrl?: string;
  expiresAt: string;
}

export interface UploadCompletion {
  uploadId: string;
  /** The authenticated aggregate scope expected by the API completing this upload. */
  cellId: string;
  creatorId: string;
  checksum: string;
  byteLength: number;
  parts?: readonly { partNumber: number; checksum?: string }[];
}
export interface UploadAcceptance { uploadId: string; cellId: string; creatorId: string; body: Uint8Array; operation: "upload_content"; }

export const requireCreatorScopedObject = (key: string, input: { cellId: string; creatorId: string }): void => {
  const prefix = `cells/${input.cellId}/creators/${input.creatorId}/`;
  if (!key.startsWith(prefix)) throw new Error(`Object key is not scoped to creator ${input.creatorId} in cell ${input.cellId}`);
};

export interface ObjectLifecycleSignal {
  type: "deleted" | "restored" | "eligible_for_garbage_collection";
  object: Pick<StoredObject, "bucket" | "key" | "versionId">;
  occurredAt: string;
  reason?: string;
}

/** Direct/multipart upload is optional so simple object stores can implement ObjectStorage alone. */
export interface UploadAdapter {
  initiate(input: { object: StoredObject; checksumAlgorithm: "sha256"; multipart?: boolean; expiresAt: string }): Promise<UploadInitiation>;
  complete(input: UploadCompletion): Promise<StoredObject>;
  abort?(input: { uploadId: string; cellId: string; creatorId: string }): Promise<void>;
}

/** Storage endpoints that proxy upload bytes (compact/local profile) authenticate the same scope as completion. */
export interface UploadContentAdapter extends UploadAdapter { accept(input: UploadAcceptance): Promise<void>; }

export const verifyUploadContentAdapterContract = async (adapter: UploadContentAdapter): Promise<void> => {
  const body = new TextEncoder().encode("upload-contract"); const checksum = createHash("sha256").update(body).digest("hex");
  const initiate = (objectId: string, expiresAt = new Date(Date.now() + 60_000).toISOString()) => adapter.initiate({ object: { bucket: "cell-a", key: cellScopedObjectKey({ cellId: "cell-a", creatorId: "creator-a", kind: "uploads", objectId }), contentType: "text/plain", byteLength: body.byteLength, checksum, scope: "private" }, checksumAlgorithm: "sha256", expiresAt });
  const scoped = await initiate("scoped");
  for (const input of [{ cellId: "cell-b", creatorId: "creator-a" }, { cellId: "cell-a", creatorId: "creator-b" }]) {
    let rejected = false; try { await adapter.accept({ uploadId: scoped.uploadId, ...input, body, operation: "upload_content" }); } catch { rejected = true; } if (!rejected) throw new Error("Upload contract violation: foreign content was accepted.");
  }
  await adapter.abort?.({ uploadId: scoped.uploadId, cellId: "cell-b", creatorId: "creator-a" });
  for (const invalidBody of [new Uint8Array(body.byteLength), body.slice(1)]) { let wrong = false; try { await adapter.accept({ uploadId: scoped.uploadId, cellId: "cell-a", creatorId: "creator-a", body: invalidBody, operation: "upload_content" }); } catch { wrong = true; } if (!wrong) throw new Error("Upload contract violation: wrong checksum or size was accepted."); }
  await adapter.accept({ uploadId: scoped.uploadId, cellId: "cell-a", creatorId: "creator-a", body, operation: "upload_content" });
  for (const input of [{ cellId: "cell-b", creatorId: "creator-a" }, { cellId: "cell-a", creatorId: "creator-b" }]) { let rejected = false; try { await adapter.complete({ uploadId: scoped.uploadId, ...input, checksum, byteLength: body.byteLength }); } catch { rejected = true; } if (!rejected) throw new Error("Upload contract violation: foreign completion succeeded."); }
  await adapter.complete({ uploadId: scoped.uploadId, cellId: "cell-a", creatorId: "creator-a", checksum, byteLength: body.byteLength });
  let replayed = false; try { await adapter.complete({ uploadId: scoped.uploadId, cellId: "cell-a", creatorId: "creator-a", checksum, byteLength: body.byteLength }); } catch { replayed = true; } if (!replayed) throw new Error("Upload contract violation: completion replay succeeded.");
  const expired = await initiate("expired", new Date(Date.now() - 1_000).toISOString()); let acceptedExpired = false; try { await adapter.accept({ uploadId: expired.uploadId, cellId: "cell-a", creatorId: "creator-a", body, operation: "upload_content" }); acceptedExpired = true; } catch {} if (acceptedExpired) throw new Error("Upload contract violation: expired content was accepted.");
};

/** Delivery policy is expressed in Ubeeq grants, not provider-specific URL mechanisms. */
export interface DeliveryGrant {
  subjectId?: string;
  scopes: readonly string[];
  entitlements?: readonly string[];
  object: Pick<StoredObject, "bucket" | "key" | "versionId" | "scope">;
  expiresAt: string;
}

export interface GrantAwareDeliveryAdapter extends DeliveryAdapter {
  issueGranted(request: DeliveryGrant & { disposition?: "inline" | "attachment" }): Promise<{ url: string; expiresAt: string }>;
}

export interface ObjectLifecycleAdapter {
  signal(input: ObjectLifecycleSignal): Promise<void>;
}

export const validateStoredObject = (object: StoredObject): void => {
  if (!object.bucket.trim() || !object.key.trim() || !object.contentType.trim()) throw new Error("Stored object location and content type are required");
  if (!Number.isSafeInteger(object.byteLength) || object.byteLength < 0) throw new Error("Stored object byte length must be a non-negative integer");
};

const SAFE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Canonical regional key: cells/<cell>/creators/<creator>/<kind>/<id>. */
export const cellScopedObjectKey = (input: { cellId: string; creatorId: string; kind: "originals" | "renditions" | "exports" | "uploads"; objectId: string }): string => {
  for (const [name, value] of Object.entries(input)) {
    if (!SAFE_KEY_SEGMENT.test(value)) throw new Error(`Invalid ${name} for a cell-scoped object key`);
  }
  return `cells/${input.cellId}/creators/${input.creatorId}/${input.kind}/${input.objectId}`;
};

export const requireCellScopedObject = (key: string, cellId: string): void => {
  if (!key.startsWith(`cells/${cellId}/`)) throw new Error(`Object key is not scoped to cell ${cellId}`);
};

/** Executable baseline for provider-neutral object storage adapters. */
export const verifyObjectStorageContract = async (storage: ObjectStorage): Promise<void> => {
  // Object versions are assigned by the storage provider. A generic adapter contract
  // must not fabricate one (for example, S3 rejects unknown VersionIds).
  const object: StoredObject = { bucket: "contract", key: "object", contentType: "text/plain", byteLength: 8, scope: "private" };
  const body = new TextEncoder().encode("contract");
  await storage.put({ object, body });
  const loaded = await storage.get(object);
  if (loaded.object.checksum !== object.checksum || loaded.object.byteLength !== body.byteLength || new TextDecoder().decode(loaded.body) !== "contract") throw new Error("Object storage contract violation: stored object was not preserved.");
  await storage.remove(object);
  let removed = false; try { await storage.get(object); } catch { removed = true; }
  if (!removed) throw new Error("Object storage contract violation: removed object remains available.");
};
