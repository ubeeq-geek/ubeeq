/** Stable provider identity, independent of a credential/connection record. */
export interface PublicationAccountIdentity {
  providerNamespace: string;
  remoteAccountId: string;
}
export type PublicationPurpose = 'UNCLASSIFIED' | 'PUBLIC_PREVIEW' | 'WORK_SALE' | 'COLLECTION_FULL' | 'VOLUME_FULL' | 'CUSTOM';
export interface PublicationCopyIdentity {
  slotId: string;
  creationRequestId: string;
  account: PublicationAccountIdentity;
  purpose: PublicationPurpose;
  context?: { collectionId?: string; volumeId?: string };
}
/** An approved operation is independent of the long-lived desired destination. */
export interface PublicationOperation {
  operationId: string;
  tenantId: string;
  creatorId: string;
  publicationId: string;
  intendedRevision: number;
  sourceRevision: number;
  kind: 'CREATE' | 'UPDATE' | 'REMOVE' | 'DETACH';
  state: 'PREPARED' | 'IN_FLIGHT' | 'AMBIGUOUS' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';
  version: number;
  createdAt: string;
  updatedAt: string;
  remoteId?: string;
}

export function assertPublicationCopyIdentity(copy: PublicationCopyIdentity): void {
  const id = (value: unknown) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
  if (!copy || !id(copy.slotId) || !id(copy.creationRequestId) || !id(copy.account?.providerNamespace) || !id(copy.account?.remoteAccountId)
    || !['UNCLASSIFIED', 'PUBLIC_PREVIEW', 'WORK_SALE', 'COLLECTION_FULL', 'VOLUME_FULL', 'CUSTOM'].includes(copy.purpose)
    || (copy.context !== undefined && (!copy.context || Object.keys(copy.context).some(key => !['collectionId', 'volumeId'].includes(key))
      || Object.values(copy.context).some(value => !id(value))))
    || (copy.purpose === 'COLLECTION_FULL' && !copy.context?.collectionId)
    || (copy.purpose === 'VOLUME_FULL' && !copy.context?.volumeId)) {
    throw new Error('A stable account, slot, creation request and valid purpose/context are required.');
  }
}
