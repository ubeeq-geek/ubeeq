import { CopyObjectCommand, DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';

export interface PublicDerivativeStore {
  copy(input: { sourceBucket: string; sourceObjectKey: string; destinationBucket: string; destinationObjectKey: string; contentType: string; contentHash: string }): Promise<void>;
  remove(input: { bucket: string; objectKey: string }): Promise<void>;
}

/** Low-level storage mechanism, not publication admission or a cleanup policy.
 * Callers must authorize both locations, validate the derivative and own its key.
 * Hash metadata is supplied by the caller; copying does not verify content bytes.
 */
export const createS3PublicDerivativeStore = (client: Pick<S3Client, 'send'>): PublicDerivativeStore => ({
  copy: async input => {
    await client.send(new CopyObjectCommand({
      Bucket: input.destinationBucket,
      Key: input.destinationObjectKey,
      CopySource: `${encodeURIComponent(input.sourceBucket)}/${input.sourceObjectKey.split('/').map(encodeURIComponent).join('/')}`,
      ContentType: input.contentType,
      CacheControl: 'public, max-age=300, s-maxage=300, must-revalidate',
      MetadataDirective: 'REPLACE',
      // Retain destination bucket encryption defaults; never override with aws/s3.
      Metadata: { sha256: input.contentHash }
    }));
  },
  remove: async ({ bucket, objectKey }) => {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  }
});
