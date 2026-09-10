import { createElement, useEffect, useRef, useState } from 'react';
import { createPrivateMediaPlayback } from './private-media-playback.js';

export interface PrivateMediaPlayerProps {
  kind: 'audio' | 'video';
  /** Stable per admitted media identity. Caller owns authorization and byte limits. */
  load: () => Promise<Blob>;
  caption?: string;
  buttonClassName?: string;
  copy: { initial: string; loading: string; loaded: string; loadError: string; playbackError: string; button: string; label: string };
}

/** Explicit loading only. No URLs in content, automatic playback, or admission policy. */
export function PrivateMediaPlayer({ kind, load, caption, buttonClassName, copy }: PrivateMediaPlayerProps) {
  const media = useRef<HTMLMediaElement | null>(null);
  const active = useRef<{ playback: ReturnType<typeof createPrivateMediaPlayback>; busy: boolean } | null>(null);
  const [url, setUrl] = useState(''), [status, setStatus] = useState(copy.initial), [busy, setBusy] = useState(false);
  useEffect(() => {
    const session = { playback: createPrivateMediaPlayback(load), busy: false };
    active.current = session;
    setUrl(''); setBusy(false); setStatus(copy.initial);
    const element = media.current;
    return () => {
      if (active.current === session) active.current = null;
      session.playback.dispose();
      element?.pause(); element?.removeAttribute('src'); element?.load();
    };
  }, [load, kind]);
  const onClick = async () => {
    const session = active.current;
    if (!session || session.busy) return;
    session.busy = true; setBusy(true); setStatus(copy.loading);
    try {
      const next = await session.playback.load();
      if (active.current !== session || !next) return;
      setUrl(next); setStatus(copy.loaded);
    } catch (error) {
      if (active.current === session) setStatus(error instanceof Error ? error.message : copy.loadError);
    } finally {
      session.busy = false;
      if (active.current === session) setBusy(false);
    }
  };
  return createElement('figure', null,
    createElement('button', { type: 'button', className: buttonClassName, disabled: busy, onClick }, copy.button),
    createElement('p', { role: 'status' }, status),
    createElement(kind, { ref: media, controls: true, preload: 'none', hidden: !url,
      ...(url ? { src: url } : {}), 'aria-label': caption || copy.label,
      onError: () => setStatus(copy.playbackError) }),
    caption ? createElement('figcaption', null, caption) : null);
}
