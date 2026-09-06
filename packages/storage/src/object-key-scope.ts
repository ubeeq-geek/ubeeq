/** Compare canonical application-generated keys by path segment. This is not an
 * authorization decision: the caller must derive the allowed prefix from verified
 * identity/ownership, never from the submitted key. No URL decoding is performed. */
export const isObjectKeyWithinPrefix = (key: string, prefix: string): boolean => {
  const canonical = (value: string) => value.length > 0 && !/[\\%\u0000-\u001f\u007f]/.test(value) &&
    value.split('/').every(segment => Boolean(segment) && segment !== '.' && segment !== '..');
  const root = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return canonical(key) && canonical(root) && key.startsWith(`${root}/`);
};
