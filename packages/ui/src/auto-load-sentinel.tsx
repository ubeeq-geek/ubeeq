import { useEffect, useRef } from 'react';

export interface AutoLoadSentinelProps {
  enabled: boolean;
  loading: boolean;
  onLoadMore: () => Promise<void> | void;
  rootMargin?: string;
  className?: string;
  loadLabel?: string;
  loadingLabel?: string;
}

/** Caller owns pagination, request errors, and loading state. */
export function AutoLoadSentinel({ enabled, loading, onLoadMore, rootMargin = '240px 0px',
  className = '', loadLabel = 'Load more', loadingLabel = 'Loading...' }: AutoLoadSentinelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!enabled || loading || !ref.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void onLoadMore();
    }, { rootMargin });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [enabled, loading, onLoadMore, rootMargin]);
  if (!enabled) return null;
  return <div ref={ref} className={className}>
    <button type="button" onClick={() => void onLoadMore()} disabled={loading}>{loading ? loadingLabel : loadLabel}</button>
  </div>;
}
