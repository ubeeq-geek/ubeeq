/** Release timing only; callers still enforce visibility, status and admission.
 * Early access bypasses publicReleaseAt, never publishAt. Unparseable dates or invalid clocks
 * fail closed instead of silently removing a release restriction.
 */
export const canViewBySchedule = (
  publishAt: string | undefined,
  publicReleaseAt: string | undefined,
  nowMs: number,
  hasEarlyAccess: boolean
): boolean => {
  if (!Number.isFinite(nowMs)) return false;
  const parse = (value: string | undefined): number | undefined => value === undefined || value === '' ? undefined : Date.parse(value);
  const publishAtMs = parse(publishAt), publicReleaseAtMs = parse(publicReleaseAt);
  if ((publishAtMs !== undefined && !Number.isFinite(publishAtMs)) ||
    (publicReleaseAtMs !== undefined && !Number.isFinite(publicReleaseAtMs))) return false;
  if (publishAtMs !== undefined && nowMs < publishAtMs) return false;
  return publicReleaseAtMs === undefined || nowMs >= publicReleaseAtMs || hasEarlyAccess === true;
};
