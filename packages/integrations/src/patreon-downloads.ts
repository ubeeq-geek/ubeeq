export const memberDownloadFilename = (title: string, originalFilename?: string): string => {
  const base = title.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const ext = originalFilename?.includes('.') ? originalFilename.slice(originalFilename.lastIndexOf('.')) : '';
  return `${base || 'download'}${ext}`;
};

export const memberDownloadFileEligible = (asset: { status: string; kind: string; deletedAt?: string }): boolean =>
  asset.status === 'ready' && !asset.deletedAt;
