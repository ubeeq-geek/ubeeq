/** Consume streamed response bytes within a caller-selected budget. Fetch URL,
 * redirects, status admission and deadlines remain caller responsibilities.
 */
export const readBoundedResponseText = async (response: Response, maxBytes: number): Promise<string> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Response byte limit must be a positive safe integer.');
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0;
  const parts: string[] = [];
  try {
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes) throw new Error('Provider response exceeds byte limit.');
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error('Provider response exceeds byte limit.');
      if (next.value.byteLength) parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    try { await reader.cancel(error); } catch { /* Preserve the original read/budget error. */ }
    throw error;
  } finally { reader.releaseLock(); }
};
