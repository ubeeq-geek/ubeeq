import { createHash } from 'node:crypto';
import { parseCreatorContentExport } from './content-export-validation.js';
import { stableJson } from './index.js';

/** Never copies objects or activates provider state. The product transforms and admits the parsed records. */
export function prepareCreatorContentRestore(json: string, target: { tenantId: string; creatorId: string; restoreId: string }, bindings: unknown = []) {
  if (![target.tenantId, target.creatorId, target.restoreId].every(value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value)))
    throw new Error('Invalid restore target.');
  const parsed = parseCreatorContentExport(json);
  return { parsed, target: { ...target }, fingerprint: createHash('sha256').update(stableJson({ manifest: parsed.manifest, target, bindings })).digest('hex') };
}
