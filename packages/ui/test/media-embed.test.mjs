import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveMediaEmbed,mediaEmbedAllowlist,mediaEmbedPublicUrl} from '../dist/media-embed.js';

test('normalizes video links and retains unlisted Vimeo and signed Bunny access parameters',()=>{
 assert.equal(resolveMediaEmbed('https://youtu.be/M7lc1UVf-VE?t=1m2s','video').src,'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?start=62');
 assert.equal(resolveMediaEmbed('https://www.youtube.com/shorts/M7lc1UVf-VE','video').provider,'YouTube');
 assert.equal(resolveMediaEmbed('https://vimeo.com/76979871/abc123','video').src,'https://player.vimeo.com/video/76979871?h=abc123');
 const bunny=resolveMediaEmbed('<iframe src="https://iframe.mediadelivery.net/embed/123/12345678-1234-1234-1234-123456789012?token=abc&amp;expires=123&amp;autoplay=true" onload="alert(1)"></iframe>','video');
 assert.match(bunny.src,/token=abc&expires=123&autoplay=false$/);assert.doesNotMatch(bunny.src,/onload|iframe /);
 assert.equal(resolveMediaEmbed('<div style="position:relative"><iframe src="'+bunny.src+'"></iframe></div>','video').src,bunny.src);
});
test('normalizes audio links without fetching arbitrary provider metadata',()=>{
 assert.equal(resolveMediaEmbed('https://open.spotify.com/track/0Lr4kGOYn9l83EjuK6cZFQ?si=ignore','audio').src,'https://open.spotify.com/embed/track/0Lr4kGOYn9l83EjuK6cZFQ');
 assert.match(resolveMediaEmbed('https://soundcloud.com/artist/track','audio').src,/^https:\/\/w.soundcloud.com\/player\/\?url=/);
 assert.equal(resolveMediaEmbed('<iframe src="https://bandcamp.com/EmbeddedPlayer/album=123/size=large/"></iframe>','audio').provider,'Bandcamp');
});
test('rejects unsafe or unsupported URLs and never trusts arbitrary iframe attributes',()=>{
 for(const url of ['javascript:alert(1)','http://www.youtube.com/watch?v=M7lc1UVf-VE','https://www.youtube.com.evil.example/embed/M7lc1UVf-VE','https://user:pass@www.youtube.com/embed/M7lc1UVf-VE','https://www.youtube.com:444/embed/M7lc1UVf-VE','https://example.com/video'])assert.throws(()=>resolveMediaEmbed(url,'video'));
 assert.throws(()=>resolveMediaEmbed('https://w.soundcloud.com/player/?url=https://example.com/private','audio'));
 assert.throws(()=>resolveMediaEmbed('<script>alert(1)</script><iframe src="https://www.youtube.com/embed/M7lc1UVf-VE"></iframe>','video'));
 assert.throws(()=>resolveMediaEmbed('https://open.spotify.com/track/0Lr4kGOYn9l83EjuK6cZFQ','video'));
 const allowed=mediaEmbedAllowlist('<iframe src="https://example.com"></iframe><iframe data-website-media-embed="video" src="https://www.youtube-nocookie.com/embed/M7lc1UVf-VE" srcdoc="bad" onload="bad()"></iframe>');
 assert.equal(allowed.length,1);assert.equal(allowed[0].embed.provider,'YouTube');assert.doesNotMatch(JSON.stringify(allowed),/srcdoc|onload|bad/);
});

test('YouTube fallback links open the viewing page and preserve the start time',()=>{
 assert.equal(mediaEmbedPublicUrl(resolveMediaEmbed('https://www.youtube-nocookie.com/embed/aUOQFtYMCd8','video')),'https://www.youtube.com/watch?v=aUOQFtYMCd8');
 assert.equal(mediaEmbedPublicUrl(resolveMediaEmbed('https://youtu.be/M7lc1UVf-VE?t=62','video')),'https://www.youtube.com/watch?v=M7lc1UVf-VE&t=62s');
});
