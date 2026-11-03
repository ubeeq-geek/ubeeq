/** Asset labels are display titles and need not contain the original file extension. */
export function commerceDownloadFilename(label: string, contentType: string): string {
  const extensions: Record<string, readonly string[]> = {
    'image/jpeg': ['jpg', 'jpeg', 'jpe'],
    'image/png': ['png'], 'image/webp': ['webp'], 'image/gif': ['gif'],
    'image/avif': ['avif'], 'image/tiff': ['tif', 'tiff'],
    'image/svg+xml': ['svg'], 'image/bmp': ['bmp'],
    'image/heic': ['heic'], 'image/heif': ['heif'],
    'application/zip': ['zip'], 'application/x-zip-compressed': ['zip'],
    'application/pdf': ['pdf'], 'video/mp4': ['mp4'],
    'video/webm': ['webm'], 'audio/mpeg': ['mp3'],
    'audio/mp4': ['m4a'], 'audio/wav': ['wav'], 'audio/ogg': ['ogg'],
  };
  const allowed = extensions[contentType.split(';')[0].trim().toLowerCase()];
  const safe = label.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+|\.+$/g, '') || 'download';
  if (!allowed) return safe.slice(0, 150);
  const suffix = safe.match(/\.([A-Za-z0-9]+)$/)?.[1];
  const extension = suffix && allowed.includes(suffix.toLowerCase()) ? suffix : allowed[0];
  const stem = suffix && allowed.includes(suffix.toLowerCase()) ? safe.slice(0, -(suffix.length + 1)) : safe;
  return `${stem.slice(0, 149 - extension.length)}.${extension}`;
}
