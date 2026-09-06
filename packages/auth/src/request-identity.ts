export interface RequestIdentityOptions<T> {
  verify?: (credential: string) => Promise<T | undefined>;
  /** Must be selected explicitly by the local composition, never by request data. */
  allowDevelopmentIdentity?: boolean;
}

/** Credential selection shared by HTTP transports; provider claims and roles stay in adapters. */
export const createRequestIdentityResolver = <T>(options: RequestIdentityOptions<T>) => async (
  authorization: string | undefined,
  developmentIdentity?: (credential?: string) => T | undefined
): Promise<T | undefined> => {
  const match = authorization?.match(/^Bearer[\t ]+(\S+)[\t ]*$/i);
  // An explicitly supplied but malformed/unsupported credential is never a request
  // to use a different identity source, even during local development.
  if (authorization !== undefined && !match) return undefined;
  if (options.verify) {
    if (!match) return undefined;
    try { return await options.verify(match[1]); } catch { return undefined; }
  }
  if (!options.allowDevelopmentIdentity) return undefined;
  return developmentIdentity?.(match?.[1]);
};
