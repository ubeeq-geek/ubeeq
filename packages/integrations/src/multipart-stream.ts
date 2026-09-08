import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

export interface MultipartFile {
  fieldName: string; filename: string; contentType: string;
  source: AsyncIterable<Uint8Array | string> & { destroy?: () => void };
}
/** One streamed file following ordered text fields. Caller owns request admission,
 * byte quotas and deadlines, and must dispose when abandoning the request.
 */
export const createMultipartStream = (fields: ReadonlyArray<readonly [string, string]>, file: MultipartFile, boundary = `----ubeeq-${randomUUID()}`) => {
  const validName = (name: string) => /^[A-Za-z0-9_\[\]-]+$/.test(name);
  try {
    if (!/^[A-Za-z0-9-]{1,70}$/.test(boundary) || !validName(file.fieldName) ||
      !file.contentType || /[\r\n]/.test(file.contentType) || fields.some(([name, value]) => !validName(name) || typeof value !== 'string')) throw new Error('Invalid multipart headers or fields.');
    const filename = file.filename.replace(/["\r\n]/g, '_');
    const fieldParts = fields.map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`);
    async function* encode() {
      try {
        for (const field of fieldParts) yield field;
        yield header;
        for await (const chunk of file.source) yield chunk;
        yield Buffer.from(`\r\n--${boundary}--\r\n`);
      } finally { file.source.destroy?.(); }
    }
    const body = Readable.from(encode());
    const dispose = () => { body.destroy(); file.source.destroy?.(); };
    return { body, boundary, contentType: `multipart/form-data; boundary=${boundary}`, dispose };
  } catch (error) { file.source.destroy?.(); throw error; }
};
