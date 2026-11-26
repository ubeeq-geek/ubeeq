import type { PatreonAccessMapping } from './patreon.js';

export class PatreonAccessPolicy {
  static evaluateAccess(mapping: PatreonAccessMapping, userTierIds: string[]): boolean {
    if (!mapping.active || mapping.safetyHold) return false;
    if (!mapping.selectorIds.length) return true;
    return mapping.selectorIds.some((id) => userTierIds.includes(id));
  }
}
