import {parseFragment} from 'parse5';
export type MediaEmbedKind='video'|'audio';
export const MEDIA_EMBED_ORIGINS=['https://www.youtube-nocookie.com','https://player.vimeo.com','https://player.mediadelivery.net','https://iframe.mediadelivery.net','https://open.spotify.com','https://w.soundcloud.com','https://bandcamp.com'] as const;
export interface MediaEmbed {provider:string;kind:MediaEmbedKind;src:string;height:number;}
const httpsUrl=(value:string)=>{let url:URL;try{url=new URL(value);}catch{throw new Error('Paste a complete HTTPS media link or a player embed code.');}if(url.protocol!=='https:'||url.username||url.password||url.port)throw new Error('Use a public HTTPS media link.');return url;};
/** Extract only a player URL; pasted HTML and its attributes are never rendered. */
export function mediaEmbedInput(value:string):string {
  if(value.length>16_384)throw new Error('Paste a media link or a single player embed code.');
  if(!value.trim().startsWith('<'))return value.trim();
  const pending=[...parseFragment(value).childNodes];let source:string|undefined;
  while(pending.length){const node=pending.pop()!;
    if(node.nodeName==='#text'&&'value' in node&&!node.value.trim())continue;
    if('tagName' in node&&node.tagName==='iframe'){if(source!==undefined)throw new Error('Paste one player embed code at a time.');source=node.attrs.find(attr=>attr.name==='src')?.value??'';continue;}
    if('tagName' in node&&['div','p'].includes(node.tagName)){pending.push(...node.childNodes);continue;}
    throw new Error('Paste a media URL or a single player iframe embed code.');
  }
  if(source===undefined)throw new Error('Paste a media URL or a single player iframe embed code.');
  return source;
}
export function resolveMediaEmbed(input:string,kind:MediaEmbedKind):MediaEmbed {
  const value=mediaEmbedInput(input);if(!value)throw new Error(`Paste a ${kind} URL or embed code.`);
  const url=httpsUrl(value),host=url.hostname.toLowerCase().replace(/^www\./,''),path=url.pathname;
  if(kind==='video'){
    if(['youtube.com','youtube-nocookie.com','youtu.be','m.youtube.com'].includes(host)){
      const id=host==='youtu.be'?path.split('/')[1]:path==='/watch'?url.searchParams.get('v'):path.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1];
      if(!id||!/^[-\w]{11}$/.test(id))throw new Error('Use a YouTube video link, rather than a channel or playlist link.');
      const src=new URL('https://www.youtube-nocookie.com/embed/'+id);const start=url.searchParams.get('start')??url.searchParams.get('t');if(start){const match=start.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/),seconds=/^\d+$/.test(start)?Number(start):match?Number(match[1]??0)*3600+Number(match[2]??0)*60+Number(match[3]??0):0;if(seconds>0&&seconds<86400)src.searchParams.set('start',String(seconds));}
      return {provider:'YouTube',kind,src:src.href,height:0};
    }
    if(host==='vimeo.com'||host==='player.vimeo.com'){
      const match=path.match(/^\/(?:video\/)?(\d+)(?:\/([a-zA-Z0-9]+))?\/?$/);if(!match)throw new Error('Use a Vimeo video link or its player embed code.');
      const src=new URL('https://player.vimeo.com/video/'+match[1]),hash=url.searchParams.get('h')??match[2];if(hash){if(!/^[a-zA-Z0-9]+$/.test(hash))throw new Error('The Vimeo privacy hash is invalid.');src.searchParams.set('h',hash);}
      return {provider:'Vimeo',kind,src:src.href,height:0};
    }
    if(['player.mediadelivery.net','iframe.mediadelivery.net'].includes(host)&&/^\/embed\/\d+\/[a-f0-9-]{36}\/?$/i.test(path)){
      const src=new URL('https://'+host+path);for(const field of ['token','expires']){const value=url.searchParams.get(field);if(value)src.searchParams.set(field,value);}src.searchParams.set('autoplay','false');
      return {provider:'Bunny Stream',kind,src:src.href,height:0};
    }
    throw new Error('Use a YouTube, Vimeo, or Bunny Stream video link or embed code.');
  }
  if(host==='open.spotify.com'){
    const match=path.match(/^\/(?:intl-[a-z]+\/)?(?:embed\/)?(track|album|playlist|episode|show)\/([a-zA-Z0-9]{22})\/?$/);if(!match)throw new Error('Use a Spotify track, album, playlist, episode, or show link.');
    return {provider:'Spotify',kind,src:`https://open.spotify.com/embed/${match[1]}/${match[2]}`,height:['track','episode'].includes(match[1])?152:352};
  }
  if(host==='soundcloud.com'||host==='w.soundcloud.com'){
    const track=host==='w.soundcloud.com'?httpsUrl(url.searchParams.get('url')??''):url;
    if(!['soundcloud.com','www.soundcloud.com','api.soundcloud.com'].includes(track.hostname)||track.pathname.split('/').filter(Boolean).length<2)throw new Error('Use a SoundCloud track or playlist link.');
    const src=new URL('https://w.soundcloud.com/player/');src.searchParams.set('url',track.href);src.searchParams.set('auto_play','false');
    return {provider:'SoundCloud',kind,src:src.href,height:166};
  }
  if(host==='bandcamp.com'&&path.startsWith('/EmbeddedPlayer/')){
    const match=path.match(/\/(album|track)=(\d+)\//);if(!match)throw new Error('Paste the Bandcamp player embed code from Share/Embed.');
    return {provider:'Bandcamp',kind,src:`https://bandcamp.com/EmbeddedPlayer/${match[1]}=${match[2]}/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/`,height:120};
  }
  throw new Error('Use Spotify or SoundCloud, or paste a Bandcamp player embed code.');
}
/** Open the normal viewing page rather than a referrer-dependent standalone YouTube player. */
export function mediaEmbedPublicUrl(embed:MediaEmbed):string {
  if(embed.provider!=='YouTube')return embed.src;
  const player=new URL(embed.src),url=new URL('https://www.youtube.com/watch');
  url.searchParams.set('v',player.pathname.split('/').pop()!);
  const start=player.searchParams.get('start');if(start)url.searchParams.set('t',start+'s');
  return url.href;
}
/** Revalidate archived frames before the preview shell admits any remote player. */
export function mediaEmbedAllowlist(html:string):Array<{original:string;embed:MediaEmbed}> {
  const pending=[...parseFragment(html).childNodes],result:Array<{original:string;embed:MediaEmbed}>=[];
  while(pending.length){const node=pending.pop()!;if('tagName' in node&&node.tagName==='iframe'){
    const kind=node.attrs.find(attr=>attr.name==='data-website-media-embed')?.value,original=node.attrs.find(attr=>attr.name==='src')?.value;
    if(original&&(kind==='video'||kind==='audio'))try{result.push({original,embed:resolveMediaEmbed(original,kind)});}catch{}
  }if('childNodes' in node)pending.push(...node.childNodes);}
  return result;
}
