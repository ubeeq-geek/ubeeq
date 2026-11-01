import type {StoredPostBlock} from '@ubeeq/core';
import {mediaEmbedPublicUrl,resolveMediaEmbed,type MediaEmbedKind} from './media-embed.js';
export function MediaEmbedEditor({block,selected,readOnly,onChange}:{block:StoredPostBlock;selected:boolean;readOnly:boolean;onChange:(block:StoredPostBlock)=>void}) {
  const kind=block.payload?.embedKind as MediaEmbedKind;
  let embed:ReturnType<typeof resolveMediaEmbed>|undefined,error='';
  if(block.url?.trim())try{embed=resolveMediaEmbed(block.url,kind);}catch(value){error=value instanceof Error?value.message:'This media link could not be read.';}
  return <div className="portable-media-embed-editor">
    {selected&&!readOnly&&<div className="portable-media-embed-fields">
      <label>{kind==='video'?'Video':'Audio'} URL or embed code<textarea maxLength={2048} value={block.url??''} placeholder={kind==='video'?'YouTube, Vimeo, or Bunny Stream':'Spotify, SoundCloud, or Bandcamp embed code'} onChange={event=>onChange({...block,url:event.target.value})} onBlur={()=>{if(embed&&block.url!==embed.src)onChange({...block,url:embed.src});}}/></label>
      <label>Player title<input value={block.label??''} placeholder={embed?`${embed.provider} ${kind} player`:`${kind==='video'?'Video':'Audio'} player`} onChange={event=>onChange({...block,label:event.target.value})}/></label>
      <small>{kind==='video'?'Paste a video link or the player embed code. Bunny Stream requires its player URL or embed code.':'Paste a Spotify or SoundCloud link. For Bandcamp, use Share/Embed and paste the player embed code.'}</small>
      {error&&<p role="alert">{error}</p>}
    </div>}
    {embed?<div className={`portable-media-embed-preview website-media-embed website-media-embed-${kind}`}><iframe src={embed.src} title={block.label||`${embed.provider} ${kind} player`} height={embed.height||undefined} loading="lazy" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" referrerPolicy="strict-origin-when-cross-origin" style={{pointerEvents:selected?'auto':'none'}}/></div>:<div className="portable-media-embed-placeholder">{error||`Select to add ${kind==='audio'?'an audio':'a video'} embed.`}</div>}
    {embed&&<small><a href={mediaEmbedPublicUrl(embed)} target="_blank" rel="noopener noreferrer">Open on {embed.provider}</a></small>}
  </div>;
}
