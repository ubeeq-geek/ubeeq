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

export const validateStoredObject = (object: StoredObject): void => {
  if (!object.bucket.trim() || !object.key.trim() || !object.contentType.trim()) throw new Error("Stored object location and content type are required");
  if (!Number.isSafeInteger(object.byteLength) || object.byteLength < 0) throw new Error("Stored object byte length must be a non-negative integer");
};

