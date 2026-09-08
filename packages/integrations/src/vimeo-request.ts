import { readBoundedResponseText } from './bounded-response-text.js';

export class VimeoApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean, readonly retryAfterSeconds?: number) {
    super(message); this.name = 'VimeoApiError';
  }
}

/** Caller owns URL admission, credentials, and recovery. Never retries a request. */
export async function requestVimeo(
  fetcher: typeof fetch, url: string, init: RequestInit = {},
  limits: { timeoutMs?: number; maxResponseBytes?: number } = {}
): Promise<Response> {
  const timeoutMs = limits.timeoutMs ?? 30_000, maxBytes = limits.maxResponseBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('Invalid Vimeo request limits.');
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  // Transport failures retain their original identity. A caller must reconcile
  // uncertain writes, not infer that a rejected fetch means no remote effect.
  const response = await fetcher(url, { ...init, redirect: 'error', signal });
  let body: string;
  try { body = await readBoundedResponseText(response, maxBytes); }
  catch (error) {
    if (response.ok) throw error;
    throw statusError(response);
  }
  if (!response.ok) throw statusError(response, body);
  // Return a bounded, detached response so existing JSON consumers keep working.
  return new Response(body || null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function statusError(response: Response, body?: string): VimeoApiError {
  const raw = Number(response.headers.get('retry-after'));
  const retryAfter = Number.isFinite(raw) && raw > 0 ? raw : undefined;
  let message = '';
  try {
    const value = JSON.parse(body ?? '') as { developer_message?: unknown; error?: unknown } | null;
    const candidate = value?.developer_message || value?.error;
    if (typeof candidate === 'string') message = candidate;
  } catch { /* Never include proxy HTML in errors. */ }
  return new VimeoApiError(message || `Vimeo request failed (${response.status})`, response.status,
    response.status === 408 || response.status === 429 || response.status >= 500, retryAfter);
}
