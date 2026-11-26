import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { inheritedPublicationImageSelection, publicationImageCanonicalJson, type PublicationImageDeliveryEvidence,
  type PublicationImageResolution, type PublicationImageSelection, type PublicationImageVariant } from '@ubeeq/core';

export interface PublicationImageReadModel<W> {
  publicationId: string;
  configurationRevision: number;
  selection?: PublicationImageSelection<W>;
  effective: PublicationImageResolution<W>;
  accountLabel: string;
  galleryLabels: readonly string[];
  copyLabel?: string;
  watermarkSummary?: string;
  confirmedImage?: PublicationImageDeliveryEvidence;
}
export interface PublicationImageControlsProps<W> {
  selectedPublicationId: string;
  model?: PublicationImageReadModel<W>;
  variants: readonly { value: PublicationImageVariant; label: string; enabled: boolean }[];
  collections: readonly { id: string; label: string }[];
  /** Reuse the product's existing watermark editor and schema. */
  renderWatermarkEditor?: (value: W, onChange: (value: W) => void) => ReactNode;
  defaultWatermark?: W;
  onSave(input: { publicationId: string; expectedConfigurationRevision: number; requestId: string; selection: PublicationImageSelection<W> }): Promise<PublicationImageReadModel<W>>;
  /** Uses authenticated, expiring preview access for this explicit Publication ID. */
  onPreview(publicationId: string): Promise<void>;
  onReload?(): Promise<PublicationImageReadModel<W>>;
}
/** Keep the selected identity through refreshes. Missing IDs never select a sibling. */
export function selectPublicationImageModel<W>(publicationId: string, models: readonly PublicationImageReadModel<W>[]) {
  return models.find(model => model.publicationId === publicationId);
}
export function PublicationImageControls<W>(props: PublicationImageControlsProps<W>) {
  if (!props.model || props.model.publicationId !== props.selectedPublicationId) return <p role="status">The selected publication is unavailable. Reload to choose a destination.</p>;
  return <PublicationImageForm key={props.selectedPublicationId} {...props} model={props.model}/>;
}
const labels: Record<PublicationImageVariant, string> = {
  original: 'Original', thumbnail: 'Thumbnail', reduced: 'Reduced', share: 'Share', 'share-alternate': 'Alternate Share', 'watermarked-original': 'Watermarked original'
};
function PublicationImageForm<W>({ model, ...props }: PublicationImageControlsProps<W> & { model: PublicationImageReadModel<W> }) {
  const id = useId(), mounted = useRef(true), pending = useRef(false);
  const [draft, setDraft] = useState(() => structuredClone(model.selection ?? inheritedPublicationImageSelection<W>()));
  const [revision, setRevision] = useState(model.configurationRevision);
  const [saved, setSaved] = useState(model);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const receipt = useRef<{ intent: string; id: string }>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = model.configurationRevision >= saved.configurationRevision ? model : saved;
  const edit = (selection: PublicationImageSelection<W>) => { setDraft(selection); setMessage(''); setError(''); };
  const submit = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    const selection = structuredClone(draft), publicationId = props.selectedPublicationId;
    const intent = publicationImageCanonicalJson([publicationId, revision, selection]);
    if (receipt.current?.intent !== intent) receipt.current = { intent, id: globalThis.crypto.randomUUID() };
    try {
      const result = await props.onSave({ publicationId, expectedConfigurationRevision: revision, requestId: receipt.current.id, selection });
      if (result.publicationId !== publicationId) throw new Error('The saved publication did not match the selected destination.');
      if (mounted.current) {
        setSaved(result); setRevision(result.configurationRevision); setDraft(structuredClone(result.selection ?? inheritedPublicationImageSelection<W>()));
        setMessage('Saved for this publication. Remote content changes only after review and publication.'); receipt.current = undefined;
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Image settings could not be saved. Your choices are retained.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const preview = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await props.onPreview(props.selectedPublicationId); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Image preview is unavailable.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const reload = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = props.onReload ? await props.onReload() : current;
      if (result.publicationId !== props.selectedPublicationId) throw new Error('The loaded publication did not match the selected destination.');
      if (mounted.current) {
        setSaved(result); setRevision(result.configurationRevision); setDraft(structuredClone(result.selection ?? inheritedPublicationImageSelection<W>()));
        receipt.current = undefined; setMessage('Loaded saved settings.');
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Settings could not be reloaded. Your choices are retained.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const context = draft.context.mode === 'collection' ? draft.context.collectionId : '';
  const draftVariant = draft.variant.mode === 'override' ? draft.variant.value : undefined;
  const initialWatermark = current.effective.watermark ?? props.defaultWatermark;
  const source = current.effective.provenance.variant;
  const sourceLabel = source.source === 'publication' ? 'This publication' : source.source === 'work' ? 'Work defaults'
    : source.source === 'collection' ? props.collections.find(c => c.id === source.id)?.label ?? 'Collection defaults'
      : source.source === 'creator' ? 'Creator defaults' : 'Platform defaults';
  return <section aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>Image version</h3>
    <dl>
      <dt>Account</dt><dd>{current.accountLabel}</dd>
      <dt>Galleries</dt><dd>{current.galleryLabels.join(', ') || 'No gallery selected'}</dd>
      {current.copyLabel && <><dt>Publication</dt><dd>{current.copyLabel}</dd></>}
      <dt>Effective image</dt><dd>{labels[current.effective.variant]} · {sourceLabel}</dd>
      {current.watermarkSummary && <><dt>Watermark</dt><dd>{current.watermarkSummary}</dd></>}
      {current.effective.dimensions && <><dt>Dimensions</dt><dd>{current.effective.dimensions.width} × {current.effective.dimensions.height}</dd></>}
      <dt>Last confirmed image</dt><dd>{current.confirmedImage ? `${labels[current.confirmedImage.variant]} · ${current.confirmedImage.width} × ${current.confirmedImage.height} · ${current.confirmedImage.fileChecksum.slice(0, 12)}` : 'Unknown'}</dd>
    </dl>
    {current.effective.blockers.length > 0 && <p role="alert">The image or collection context is unavailable. Correct the selection before publishing.</p>}
    {model.configurationRevision > revision && <p role="status">Saved settings changed elsewhere. Your draft is retained; reload before saving.</p>}
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy}>
        <legend>Settings for this publication</legend>
        <label htmlFor={`${id}-variant`}>Image variant</label>
        <select id={`${id}-variant`} value={draft.variant.mode === 'inherit' ? '' : draft.variant.value} onChange={event => edit({ ...draft,
          variant: event.target.value ? { mode: 'override', value: event.target.value as PublicationImageVariant } : { mode: 'inherit' } })}>
          <option value="">Use inherited variant</option>
          {props.variants.map(variant => <option key={variant.value} value={variant.value} disabled={!variant.enabled}>{variant.label}{variant.enabled ? '' : ' (unavailable)'}</option>)}
          {draftVariant && !props.variants.some(v => v.value === draftVariant) && <option value={draftVariant} disabled>{labels[draftVariant]} (unavailable)</option>}
        </select>
        <label htmlFor={`${id}-context`}>Collection context</label>
        <select id={`${id}-context`} value={context} onChange={event => edit({ ...draft, context: event.target.value ? { mode: 'collection', collectionId: event.target.value } : { mode: 'inherit' } })}>
          <option value="">Use inherited context</option>
          {props.collections.map(collection => <option key={collection.id} value={collection.id}>{collection.label}</option>)}
          {context && !props.collections.some(c => c.id === context) && <option value={context} disabled>Saved collection (unavailable)</option>}
        </select>
        <label htmlFor={`${id}-watermark`}>Watermark</label>
        <select id={`${id}-watermark`} value={draft.watermark.mode} onChange={event => edit({ ...draft,
          watermark: event.target.value === 'override' && initialWatermark !== undefined
            ? { mode: 'override', value: structuredClone(initialWatermark) } : { mode: 'inherit' } })}>
          <option value="inherit">Use inherited watermark</option>
          <option value="override" disabled={!props.renderWatermarkEditor || initialWatermark === undefined}>Set for this publication</option>
        </select>
        {draft.watermark.mode === 'override' && props.renderWatermarkEditor?.(draft.watermark.value, value => edit({ ...draft, watermark: { mode: 'override', value } }))}
        {current.effective.watermarkDormant && <p>The watermark is retained and dormant for the effective image variant.</p>}
        <p>Saving changes this publication’s desired settings. Remote content changes only after review and publication.</p>
        <button type="submit">{busy ? 'Working…' : 'Save for this publication'}</button>
        <button type="button" onClick={() => edit(inheritedPublicationImageSelection<W>())}>Use inherited settings</button>
        <button type="button" onClick={() => { void preview(); }}>Preview saved image</button>
        <button type="button" onClick={() => { void reload(); }}>Reload saved settings</button>
      </fieldset>
    </form>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
