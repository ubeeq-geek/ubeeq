export interface UbeeqWorkPosition { updatedAt: string; workId: string; }
export interface UbeeqWorkPage<W> { items: W[]; next?: UbeeqWorkPosition; }
export interface UbeeqWorkPageOptions { limit: number; after?: UbeeqWorkPosition; }
export function validateUbeeqWorkPageOptions(options: UbeeqWorkPageOptions): void {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error('Invalid inventory limit.');
  const after = options.after;
  if (after && (typeof after.updatedAt !== 'string' || after.updatedAt.length > 100 || /[#\u0000-\u001f]/.test(after.updatedAt)
    || !Number.isFinite(Date.parse(after.updatedAt)) || typeof after.workId !== 'string' || !after.workId || after.workId.length > 500 || /[\u0000-\u001f]/.test(after.workId)))
    throw new Error('Invalid inventory cursor position.');
}
export const ubeeqWorkSortKey = (position: UbeeqWorkPosition) => `WORK#${position.updatedAt}#${position.workId}`;
