/** Documented OAuth gallery operations; account eligibility remains provider-owned. */
export const DEVIANTART_GALLERY_CAPABILITIES = Object.freeze({
  regularCreation: true, subgalleryCreation: true,
  premiumCreation: false, watchersOnlyCreation: false, featuredOnPublish: true
});

export type DeviantArtGalleryKind = 'regular' | 'premium' | 'watchers_only';
export interface DeviantArtGalleryCreate {
  name: string;
  kind?: DeviantArtGalleryKind;
  description?: string;
  parentFolderId?: string;
}

export class DeviantArtGalleryError extends Error {
  constructor(message: string, readonly code: 'invalid_gallery' | 'unsupported_gallery') {
    super(message); this.name = 'DeviantArtGalleryError';
  }
}

/** Never downgrade a restricted gallery request to a public folder. */
export function deviantArtGalleryCreateForm(input: DeviantArtGalleryCreate): URLSearchParams {
  if (input.kind === 'premium' || input.kind === 'watchers_only') {
    throw new DeviantArtGalleryError('Create Premium and Watchers-Only galleries on DeviantArt, then synchronize the account.', 'unsupported_gallery');
  }
  if (input.kind !== undefined && input.kind !== 'regular') throw new DeviantArtGalleryError('Choose a supported gallery type.', 'invalid_gallery');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 50 || /[\u0000-\u001f\u007f]/.test(input.name)) {
    throw new DeviantArtGalleryError('Enter a gallery name of up to 50 characters.', 'invalid_gallery');
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 10000)) {
    throw new DeviantArtGalleryError('Gallery descriptions must contain at most 10,000 characters.', 'invalid_gallery');
  }
  if (input.parentFolderId !== undefined && !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.parentFolderId)) {
    throw new DeviantArtGalleryError('Choose a valid parent gallery.', 'invalid_gallery');
  }
  const form = new URLSearchParams({ folder: input.name.trim() });
  if (input.description !== undefined) form.set('description', input.description);
  if (input.parentFolderId !== undefined) form.set('parent_folderid', input.parentFolderId);
  return form;
}

/** Featured is independent of folder membership. Empty folders means Featured-only. */
export function deviantArtGalleryPublicationForm(galleryIds: readonly string[] = [], feature = true): URLSearchParams {
  if (typeof feature !== 'boolean' || !Array.isArray(galleryIds) || galleryIds.length > 160 || galleryIds.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 200)) {
    throw new DeviantArtGalleryError('Choose valid gallery destinations and a Featured setting.', 'invalid_gallery');
  }
  if (!feature && !galleryIds.length) throw new DeviantArtGalleryError('Choose at least one gallery or include the work in Featured.', 'invalid_gallery');
  const form = new URLSearchParams({ feature: String(feature) });
  for (const id of new Set(galleryIds)) form.append('galleryids[]', id);
  return form;
}
