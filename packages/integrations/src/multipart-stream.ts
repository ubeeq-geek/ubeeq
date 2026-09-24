import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

export interface MultipartFile {
  fieldName: string; filename: string; contentType: string;
  source: AsyncIterable<Uint8Array | string> & { destroy?: () => void };
}
export type MultipartField = readonly [name: string, value: string, contentType?: string];
/** Streamed files following ordered fields (including typed JSON parts). Caller owns request admission,
 * byte quotas and deadlines, and must dispose when abandoning the request.
 */
export const createMultipartStream = (fields: ReadonlyArray<MultipartField>, file: MultipartFile | readonly MultipartFile[], boundary = `----ubeeq-${randomUUID()}`) => {
  const files: readonly MultipartFile[] = Array.isArray(file) ? file : [file as MultipartFile];
  const closeSources = () => { for (const item of files) item.source.destroy?.(); };
  const validName = (name: string) => /^[A-Za-z0-9_\[\]-]+$/.test(name);
  const validType = (type: string) => Boolean(type) && !/[\r\n]/.test(type);
  try {
    const fileNames = files.map(item => item.fieldName);
    if (!/^[A-Za-z0-9-]{1,70}$/.test(boundary) || new Set(fileNames).size !== fileNames.length
      || fields.some(([name]) => fileNames.includes(name))
      || files.some(item => !validName(item.fieldName) || !validType(item.contentType))
      || fields.some(([name, value, type]) => !validName(name) || typeof value !== 'string' || (type !== undefined && !validType(type)))) throw new Error('Invalid multipart headers or fields.');
    const fieldParts = fields.map(([name, value, type]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n${type ? `Content-Type: ${type}\r\n` : ''}\r\n${value}\r\n`));
    async function* encode() {
      try {
        for (const field of fieldParts) yield field;
        for (const item of files) {
          const filename = item.filename.replace(/["\r\n]/g, '_');
          yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${item.fieldName}"; filename="${filename}"\r\nContent-Type: ${item.contentType}\r\n\r\n`);
          for await (const chunk of item.source) yield chunk;
          yield Buffer.from('\r\n');
        }
        yield Buffer.from(`--${boundary}--\r\n`);
      } finally { closeSources(); }
    }
    const body = Readable.from(encode());
    const dispose = () => { body.destroy(); closeSources(); };
    return { body, boundary, contentType: `multipart/form-data; boundary=${boundary}`, dispose };
  } catch (error) { closeSources(); throw error; }
};
