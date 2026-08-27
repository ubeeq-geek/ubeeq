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
  checksum: string;
  byteLength: number;
  parts?: readonly { partNumber: number; checksum?: string }[];
}

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
  abort?(input: { uploadId: string }): Promise<void>;
}

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
