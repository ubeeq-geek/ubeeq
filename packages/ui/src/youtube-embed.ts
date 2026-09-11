/** URL construction only: never loads a provider, grants consent or starts playback. */
export const resolveYouTubeEmbedUrl = (url?: string, options: { autoplay?: boolean; muted?: boolean; origin?: string } = {}): { src: string; isShort: boolean } | null => {
  if (typeof url !== 'string' || !url || url.length > 8192) return null;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) return null;
    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    let videoId = '', isShort = false;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (hostname === 'youtu.be') videoId = parts[0] || '';
    else if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(hostname)) {
      if (parts[0] === 'shorts') { videoId = parts[1] || ''; isShort = true; }
      else if (parts[0] === 'embed') videoId = parts[1] || '';
      else videoId = parsed.searchParams.get('v') || '';
    }
    // Retain the stored identifier acceptance contract, not provider availability validation.
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return null;
    const embed = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
    if (options.autoplay) embed.searchParams.set('autoplay', '1');
    embed.searchParams.set('mute', options.muted === false ? '0' : '1');
    embed.searchParams.set('playsinline', '1'); embed.searchParams.set('enablejsapi', '1');
    if (options.origin !== undefined) {
      const origin = new URL(options.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null;
      embed.searchParams.set('origin', origin.origin);
    }
    return { src: embed.toString(), isShort };
  } catch { return null; }
};
