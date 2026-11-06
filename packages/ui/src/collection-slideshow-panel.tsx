import { useEffect, useState } from 'react';
import { normalizeSlideshowSettings, type SlideshowSettings } from '@ubeeq/core';
import type { CollectionSlideshowApi, CollectionSlideshowRendition } from './collection-slideshow-client.js';

export interface CollectionSlideshowPanelProps {
  collectionId: string;
  client: CollectionSlideshowApi;
  music: readonly { assetId: string; title: string }[];
  enabled: boolean;
  /** Disable generation while collection membership edits are unsaved. */
  disabled?: boolean;
}
export function CollectionSlideshowPanel({ collectionId, client, music, enabled, disabled }: CollectionSlideshowPanelProps) {
  const [optIn, setOptIn] = useState(false), [settings, setSettings] = useState<SlideshowSettings>(() => normalizeSlideshowSettings());
  const [rights, setRights] = useState(false), [renditions, setRenditions] = useState<CollectionSlideshowRendition[]>([]);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const change = (patch: Partial<SlideshowSettings>) => setSettings(current => ({ ...current, ...patch }));
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await client.list(collectionId);
        if (active) setRenditions(result);
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : 'Could not load slideshow status.'); }
      if (active) timer = setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [collectionId, client]);
  const generate = async () => {
    setBusy(true); setMessage('');
    try {
      const normalized = normalizeSlideshowSettings(settings);
      const rendition = await client.generate(collectionId, normalized, rights, crypto.randomUUID());
      setRenditions(current => [...current.filter(r => r.id !== rendition.id), rendition]);
      setMessage('Slideshow queued. You can leave this page while the video renders.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Slideshow generation failed.'); }
    finally { setBusy(false); }
  };
  const download = async (id: string) => {
    setBusy(true);
    try {
      const blob = await client.download(collectionId, id), url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'collection-slideshow.mp4'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Video download failed.'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Slideshow video">
    <h2>Slideshow video</h2>
    <p>Create an MP4 from this collection’s image order. Images keep their proportions, with black borders where needed.</p>
    {!enabled && <p>Slideshow rendering is unavailable on this instance.</p>}
    <label><input type="checkbox" checked={optIn} disabled={!enabled} onChange={event => setOptIn(event.target.checked)}/> Generate slideshow video</label>
    {optIn && <fieldset disabled={busy || disabled || !enabled}>
      <legend>Video settings</legend>
      <label>Slide duration (seconds)<input type="number" min="0.5" max="60" step="0.1" value={settings.slideDurationSeconds} onChange={event => { const duration = Number(event.target.value); change({ slideDurationSeconds: duration, transitionDurationSeconds: Math.min(settings.transitionDurationSeconds, Math.floor(duration * 5) / 10) }); }}/></label>
      <label>Transition<select value={settings.transition} onChange={event => change({ transition: event.target.value as SlideshowSettings['transition'], transitionDurationSeconds: settings.transitionDurationSeconds || Math.min(0.5, Math.floor(settings.slideDurationSeconds * 5) / 10) })}><option value="crossfade">Crossfade</option><option value="cut">Cut</option></select></label>
      {settings.transition === 'crossfade' && <label>Transition duration (seconds)<input type="number" min="0.1" max={Math.min(5, settings.slideDurationSeconds / 2)} step="0.1" value={settings.transitionDurationSeconds} onChange={event => change({ transitionDurationSeconds: Number(event.target.value) })}/></label>}
      <p>Crossfades overlap slides, shortening the total video by the transition duration between each pair.</p>
      <label>Video format<select value={settings.format} onChange={event => change({ format: event.target.value as SlideshowSettings['format'] })}><option value="landscape">Landscape · 1920 × 1080</option><option value="portrait">Portrait · 1080 × 1920</option><option value="square">Square · 1080 × 1080</option></select></label>
      <h3>Music (optional)</h3>
      <p>No music is included by default. Add uploaded tracks in playback order.</p>
      <ol>{settings.music.map((track, index) => <li key={index}>
        <label>Track {index + 1}<select value={track.assetId} onChange={event => { change({ music: settings.music.map((t, i) => i === index ? { ...t, assetId: event.target.value } : t) }); setRights(false); }}>{music.map(option => <option key={option.assetId} value={option.assetId}>{option.title}</option>)}</select></label>
        <label>Start at (seconds)<input type="number" min="0" max="3600" step="0.1" value={track.startSeconds} onChange={event => change({ music: settings.music.map((t, i) => i === index ? { ...t, startSeconds: Number(event.target.value) } : t) })}/></label>
        <label>End at (seconds, optional)<input type="number" min="0.1" max="3600" step="0.1" value={track.endSeconds ?? ''} onChange={event => change({ music: settings.music.map((t, i) => i === index ? { ...t, endSeconds: event.target.value === '' ? undefined : Number(event.target.value) } : t) })}/></label>
        <button type="button" onClick={() => change({ music: settings.music.filter((_, i) => i !== index) })}>Remove track {index + 1}</button>
      </li>)}</ol>
      <button type="button" disabled={!music.length || settings.music.length >= 10} onClick={() => { change({ music: [...settings.music, { assetId: music[0].assetId, startSeconds: 0 }] }); setRights(false); }}>Add music track</button>
      {!music.length && <p>Upload audio to a separate Work to make it available here.</p>}
      {!!settings.music.length && <>
        <label><input type="checkbox" checked={settings.loopMusic} onChange={event => change({ loopMusic: event.target.checked })}/> Loop the playlist to fill the video</label>
        <label>Music fade-out (seconds)<input type="number" min="0" max="10" step="0.1" value={settings.musicFadeOutSeconds} onChange={event => change({ musicFadeOutSeconds: Number(event.target.value) })}/></label>
        <label><input type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)}/> I have permission to use these tracks on the destination platforms.</label>
      </>}
      <button type="button" disabled={!!settings.music.length && !rights} onClick={() => void generate()}>{renditions.length ? 'Generate new video' : 'Generate video'}</button>
    </fieldset>}
    {disabled && <p>Save the collection’s image order before generating a video.</p>}
    <p role="status">{message}</p>
    {renditions.length > 0 && <ul aria-label="Generated videos">{renditions.map(rendition => <li key={rendition.id}>
      <p>{rendition.imageCount} images · {rendition.durationSeconds.toFixed(1)} seconds · {rendition.settings.format} · {rendition.state.replaceAll('_', ' ')}</p>
      {rendition.stale && <p>The collection or its sources changed. Generate a new video.</p>}
      {rendition.error && <p>{rendition.error}</p>}
      {rendition.state === 'completed' && !rendition.stale && <button type="button" disabled={busy} onClick={() => void download(rendition.id)}>Download MP4</button>}
      <button type="button" disabled={busy || !enabled} onClick={() => { setSettings(structuredClone(rendition.settings)); setOptIn(true); setRights(false); }}>Use these settings</button>
    </li>)}</ul>}
  </section>;
}
