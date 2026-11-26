import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {isObjectKeyWithinPrefix} from './object-key-scope.js';
import type {UploadAdapter,UploadContentStreamAdapter,UploadInitiation} from './index.js';
/** Transport only. Its caller already persisted the real capability and owns
 * recovery/sealing/quota closure. A failed PUT is never proof of absence. */
export async function writeBoundedUploadStream(input:{uploads:UploadAdapter&Partial<UploadContentStreamAdapter>;upload:UploadInitiation;cellId:string;creatorId:string;openBody:()=>AsyncIterable<Uint8Array>;signal?:AbortSignal}):Promise<void>{
 const {uploads,upload,cellId,creatorId}=input,expected=upload.object;
 if(!cellId||!creatorId||!upload.uploadId||!isObjectKeyWithinPrefix(expected.key,`cells/${cellId}/creators/${creatorId}/`)||expected.scope!=='private'||!Number.isSafeInteger(expected.byteLength)||expected.byteLength<1||!/^[a-f0-9]{64}$/.test(expected.checksum??'')||!Number.isFinite(Date.parse(upload.expiresAt))||Date.parse(upload.expiresAt)<=Date.now())throw Error('The stream must match an actual current owned upload capability.');
 let finished=false;
 async function* verified(){let size=0;const hash=createHash('sha256');for await(const chunk of input.openBody()){input.signal?.throwIfAborted();if(!(chunk instanceof Uint8Array)||chunk.byteLength>expected.byteLength-size)throw Error('Upload stream exceeds its exact byte allowance.');size+=chunk.byteLength;hash.update(chunk);yield chunk;}if(size!==expected.byteLength||hash.digest('hex')!==expected.checksum)throw Error('Upload stream does not match its precommitted size and checksum.');finished=true;}
 if(uploads.acceptStream){await uploads.acceptStream({uploadId:upload.uploadId,cellId,creatorId,body:verified(),operation:'upload_content'});if(!finished)throw Error('The provider did not consume and verify the complete upload stream.');return;}
 const parts=upload.parts;
 if(parts?.length!==1||parts[0].partNumber!==1||new URL(parts[0].url).protocol!=='https:')throw Error('A real one-part HTTPS capability or stream adapter is required; multipart is not simulated.');
 const headers=new Headers(parts[0].headers);headers.set('content-length',String(expected.byteLength));
 const body=Readable.toWeb(Readable.from(verified())) as ReadableStream<Uint8Array>;
 const request:RequestInit&{duplex:'half'}={method:'PUT',headers,body,duplex:'half',redirect:'error',signal:input.signal??AbortSignal.timeout(Math.max(1,Math.min(15*60_000,Date.parse(upload.expiresAt)-Date.now())))};
 const response=await fetch(parts[0].url,request);await response.body?.cancel();
 if(!response.ok||!finished)throw Error('Stream transfer requires actual completion recovery.');
}
