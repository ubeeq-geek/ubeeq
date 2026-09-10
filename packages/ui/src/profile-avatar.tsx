import type { CSSProperties } from 'react';

export interface ProfileAvatarProps {
  src?: string;
  alt?: string;
  className?: string;
  /** Caller-selected outer, inner and core colors; no product palette is assumed. */
  fallbackPalette: readonly [string, string, string];
}

export function ProfileAvatar({ src, alt = '', className = '', fallbackPalette }: ProfileAvatarProps) {
  if (src) return <img className={className} src={src} alt={alt} />;
  const [outer, inner, core] = fallbackPalette;
  const style = {
    '--profile-avatar-outer': outer,
    '--profile-avatar-inner': inner,
    '--profile-avatar-core': core
  } as CSSProperties;
  return <span className={`${className} ubeeq-profile-fallback`.trim()} style={style}
    role={alt ? 'img' : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true}>
    <span className="ubeeq-profile-fallback-mark" aria-hidden="true" />
  </span>;
}
