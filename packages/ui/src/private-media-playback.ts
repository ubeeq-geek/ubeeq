/** Own a user-requested private media Blob URL. Never downloads until load(),
 * never starts playback, and discards late responses after disposal.
 * The caller owns authorization, input size limits and media rendering.
 */
export const createPrivateMediaPlayback = (download: () => Promise<Blob>, urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL) => {
  let disposed = false;
  let url: string | undefined;
  let pending: Promise<string | undefined> | undefined;
  return {
    load(): Promise<string | undefined> {
      if (disposed) return Promise.resolve(undefined);
      if (url) return Promise.resolve(url);
      if (pending) return pending;
      pending = (async () => {
        const blob = await download();
        if (disposed) return undefined;
        url = urls.createObjectURL(blob);
        return url;
      })().finally(() => { pending = undefined; });
      return pending;
    },
    dispose(): void {
      disposed = true;
      if (url) { urls.revokeObjectURL(url); url = undefined; }
    }
  };
};
