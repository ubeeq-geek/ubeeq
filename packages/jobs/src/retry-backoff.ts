/** Equal-jitter delay calculation. Retry eligibility and budgets belong to callers. */
export const equalJitterRetryDelaySeconds = (input: {
  attempt: number;
  baseDelaySeconds: number;
  maximumDelaySeconds: number;
  maximumExponent: number;
}, random: () => number = Math.random): number => {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0 ||
      !Number.isSafeInteger(input.baseDelaySeconds) || input.baseDelaySeconds < 1 ||
      !Number.isSafeInteger(input.maximumDelaySeconds) || input.maximumDelaySeconds < 1 ||
      !Number.isSafeInteger(input.maximumExponent) || input.maximumExponent < 0) {
    throw new Error("Retry delays require non-negative integer attempts/exponents and positive integer delays.");
  }
  const exponent = Math.min(Math.max(0, input.attempt - 1), input.maximumExponent);
  const ceiling = Math.min(input.maximumDelaySeconds, input.baseDelaySeconds * 2 ** exponent);
  const lower = Math.ceil(ceiling / 2);
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error("Retry jitter requires a random sample in [0, 1).");
  return lower + Math.floor(sample * (ceiling - lower + 1));
};
