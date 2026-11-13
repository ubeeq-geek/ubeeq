import {createHash} from 'node:crypto';
import {isObjectKeyWithinPrefix} from './object-key-scope.js';
import type {UploadAdapter, UploadContentAdapter, UploadInitiation} from './index.js';

/** Sends exact internal output bytes through an owned upload capability. The
 * caller persists the capability first and reconciles every uncertain outcome
 * with completion recovery or sealing; this transport never assumes absence. */
export async function writeBoundedUploadContent(input: {
  uploads: UploadAdapter & Partial<UploadContentAdapter>;
  upload: UploadInitiation;
  cellId: string;
  creatorId: string;
  body: Uint8Array;
}): Promise<void> {
  const {uploads, upload, cellId, creatorId}=input, body=Buffer.from(input.body);
  if (!cellId || !creatorId || !upload.uploadId || !isObjectKeyWithinPrefix(upload.object.key,`cells/${cellId}/creators/${creatorId}/`)
    || body.byteLength!==upload.object.byteLength || createHash('sha256').update(body).digest('hex')!==upload.object.checksum) throw new Error('Internal upload content conflicts with its owned capability.');
  if (uploads.accept) return uploads.accept({uploadId:upload.uploadId,cellId,creatorId,body,operation:'upload_content'});
  const parts=upload.parts;
  if (parts?.length!==1 || parts[0].partNumber!==1 || new URL(parts[0].url).protocol!=='https:') throw new Error('A bounded HTTPS output upload is required.');
  const response=await fetch(parts[0].url,{method:'PUT',headers:parts[0].headers,body,redirect:'error',signal:AbortSignal.timeout(60_000)});
  await response.body?.cancel();
  if(!response.ok)throw new Error('Output upload requires recovery.');
}
