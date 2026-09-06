export interface EditorAsset { assetId: string; mimeType: string; originalFilename?: string; status: string }
/** Input must already be authorized and attached to the edited Work.
 * Blob thumbnails are supplied by the caller after authenticated retrieval;
 * stored object locations never become public media URLs here.
 */
export const assetEditorOptions = (assets: readonly EditorAsset[], thumbnails: Readonly<Record<string, string>> = {}) =>
  assets.flatMap(asset => {
    const family = asset.mimeType.split('/')[0];
    const kind = ['image', 'video', 'audio'].includes(family) ? family : 'file';
    if (asset.status === 'deleted') return [];
    const thumbnail = thumbnails[asset.assetId];
    return [{ mediaId: asset.assetId, label: asset.originalFilename || asset.assetId,
      assetType: kind as 'image' | 'video' | 'audio' | 'file', mimeType: asset.mimeType,
      ...(['image', 'video'].includes(kind) && thumbnail?.startsWith('blob:') ? { thumbnailUrl: thumbnail } : {}) }];
  });
