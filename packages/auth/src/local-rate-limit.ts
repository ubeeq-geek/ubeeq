/** A synchronous, single-process sliding window. Not durable or distributed.
 * Products own keys and thresholds; serverless deployments need a shared
 * enforcement adapter or gateway for cross-instance limits.
 */
export class LocalSlidingWindowRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  check(key: string, windowMs: number, maxAttempts: number): boolean {
    if (!key || !Number.isFinite(windowMs) || windowMs <= 0 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
      throw new Error('Invalid local rate-limit configuration.');
    }
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error('Invalid rate-limit clock.');
    const valid = (this.attempts.get(key) || []).filter(time => now - time < windowMs);
    if (valid.length >= maxAttempts) {
      this.attempts.set(key, valid);
      return false;
    }
    valid.push(now);
    this.attempts.set(key, valid);
    return true;
  }
}
