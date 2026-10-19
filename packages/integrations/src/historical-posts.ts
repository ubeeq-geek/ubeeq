import { historicalPublicQueryParameter, historicalPublicUrl, sanitizeHistoricalSourceData } from "@ubeeq/core";
import { createHash } from "node:crypto";
import type {
  HistoricalContentSnapshot,
  ImportedSourceAttribution,
} from "@ubeeq/core";
export interface HistoricalRemotePost {
  remoteId: string;
  sourceUrl?: string;
  attribution: ImportedSourceAttribution;
  postedAt: string | null;
  remoteEditedAt: string | null;
  snapshot: HistoricalContentSnapshot;
  visibility: "public" | "restricted" | "unknown";
  completeness: "full" | "partial" | "metadata_only" | "unavailable";
  reasons: string[];
  /** Ephemeral retrieval URLs, never serialize into previews, records, jobs or logs. */
  retrieval: { attachmentId: string; url: string }[];
}
type Row = Record<string, any>;
const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const list = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((value) => value && typeof value === "object").map(row)
    : [];
const text = (value: unknown, max = 10000): string =>
  typeof value === "string"
    ? value
        .slice(0, max)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    : "";
export const remotePostId = (value: unknown): string =>
  typeof value === "string" && /^[\w:-]{1,100}$/.test(value)
    ? value
    : Number.isSafeInteger(value) && Number(value) >= 0
      ? String(value)
      : "";
export function unsignedHistoricalUrl(
  value: unknown,
  publicLink = false,
): string | undefined {
  if(publicLink)return historicalPublicUrl(value);
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || url.username || url.password) return;
    for (const key of Array.from(url.searchParams.keys()))
      if (
        !publicLink ||
        !historicalPublicQueryParameter(
          url.hostname,
          url.pathname,
          key,
          url.searchParams.get(key) || "",
        )
      )
        url.searchParams.delete(key);
    url.hash = "";
    return url.toString();
  } catch {
    return;
  }
}
const date = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const timestamp = (value: unknown): string | null =>
  typeof value === "number" &&
  value > 0 &&
  Number.isFinite(new Date(value * 1000).getTime())
    ? new Date(value * 1000).toISOString()
    : null;
const plain = (html: unknown): string =>
  text(html, 100000)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      (entity) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&nbsp;": " ",
        })[entity] || "",
    )
    .trim();
function legacyFormattedText(value:unknown) {
  const html=text(value,100000).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,"");
  let result="";const formatting:Row[]=[],open:{tag:string;type:string;start:number;url?:string;hex?:string}[]=[];
  const count=()=>Array.from(result).length;
  const decode=(part:string)=>part.replace(/&#(x[0-9a-f]+|[0-9]+);|&(amp|lt|gt|quot|apos|nbsp);/gi,(_,number:string,name:string)=>{
    if(number){const code=number[0].toLowerCase()==="x"?parseInt(number.slice(1),16):Number(number);return code>0&&code<=0x10ffff?String.fromCodePoint(code):"�";}
    return ({amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "} as Record<string,string>)[name.toLowerCase()]||"";
  });
  for(const token of html.match(/<[^>]*>|[^<]+/g)||[]){
    if(!token.startsWith("<")){result+=decode(token);continue;}
    const tag=token.match(/^<\/?([a-z0-9]+)/i)?.[1].toLowerCase();if(!tag)continue;
    const closing=token.startsWith("</");
    if(tag==="br"){result+="\n";continue;}
    if(["p","div","li","h1","h2","h3","h4","h5","h6","blockquote","pre"].includes(tag)&&result&&!result.endsWith("\n"))result+="\n";
    if(tag==="li"&&!closing)result+="• ";
    if(closing){const index=open.map(mark=>mark.tag).lastIndexOf(tag);if(index>=0){const mark=open.splice(index,1)[0];if(count()>mark.start)formatting.push({...mark,end:count()});}continue;}
    const type=({b:"bold",strong:"bold",i:"italic",em:"italic",s:"strikethrough",strike:"strikethrough",del:"strikethrough",u:"underline",small:"small",code:"code",a:"link"} as Record<string,string>)[tag];
    if(type){const url=tag==="a"?decode(token.match(/href\s*=\s*["']([^"']*)["']/i)?.[1]||""):undefined;open.push({tag,type,start:count(),...(url?{url}:{})});}
  }
  for(const mark of open)if(count()>mark.start)formatting.push({...mark,end:count()});
  return {text:result.replace(/\n+$/,""),formatting:formatting.map(({tag,...format})=>format)};
}
function builder() {
  const snapshot: HistoricalContentSnapshot = {
      blocks: [],
      attachments: [],
      layout: [],
      links: [],
      tags: [],
    },
    reasons: string[] = [],
    retrieval: HistoricalRemotePost["retrieval"] = [];
  const blocks =
      snapshot.blocks as HistoricalContentSnapshot["blocks"][number][],
    attachments =
      snapshot.attachments as HistoricalContentSnapshot["attachments"][number][],
    links = snapshot.links as string[];
  const addText = (value: unknown,options:Row={}) => {
    const original=text(value,100000),edits:{start:number;end:number;size:number}[]=[];
    const content=original.replace(/https?:\/\/[^\s<>"()]+/g,(match:string,index:number)=>{
      const suffix=match.match(/[.,;!?]+$/)?.[0]||"",link=match.slice(0,match.length-suffix.length),url=unsignedHistoricalUrl(link,true);
      const replacement=(url||"[invalid link]")+suffix;
      if(replacement!==match){edits.push({start:Array.from(original.slice(0,index)).length,end:Array.from(original.slice(0,index+match.length)).length,size:Array.from(replacement).length});reasons.push(url?"public_link_normalized":"unsupported_link");}
      return replacement;
    });
    const remap=(position:number)=>{let shift=0;for(const edit of edits){if(position>=edit.end)shift+=edit.size-(edit.end-edit.start);else if(position>edit.start)return edit.start+shift+Math.min(position-edit.start,edit.size);}return position+shift;};
    const formatting=[];
    for(const format of list(options.formatting).slice(0,1000)){
      if(!Number.isInteger(format.start)||!Number.isInteger(format.end)||format.start<0||format.end<=format.start||format.end>Array.from(original).length){reasons.push("source_formatting_retained");continue;}
      const start=remap(format.start),end=remap(format.end);if(end<=start)continue;
      const url=["link","mention"].includes(format.type)?unsignedHistoricalUrl(format.type==="mention"?row(format.blog).url:format.url,true):undefined;
      formatting.push({type:text(format.type,100)||"unknown",start,end,...(url?{url}:{}),...(format.type==="color" && /^#[0-9a-f]{6}$/i.test(format.hex)?{color:format.hex}:{})});
    }
    if((content || options.subtype) && blocks.length<100){
      blocks.push({kind:"text",text:content,...(options.subtype?{subtype:text(options.subtype,100)}:{}),...(Number.isInteger(options.indent_level)?{indent:Math.max(0,Math.min(20,options.indent_level))}:{}),...(formatting.length?{formatting}:{}),...(options.syntax==="discord_markdown"?{syntax:"discord_markdown" as const}:{})});
      for(const match of content.match(/https?:\/\/[^\s<>"()]+/g)||[]){const url=unsignedHistoricalUrl(match.replace(/[.,;!?]+$/,""),true);if(url&&links.length<100&&!links.includes(url))links.push(url);}
      for(const format of formatting)if(format.url && links.length<100 && !links.includes(format.url))links.push(format.url);
    }
  };
  const addLink = (
    value: unknown,
    label?: unknown,
    kind: "link" | "embed" = "link",
  ) => {
    const url = unsignedHistoricalUrl(value, true);
    if (typeof value === "string" && url && url !== value)
      reasons.push("public_link_normalized");
    if (url && links.length < 100 && blocks.length < 100) {
      if(!links.includes(url))links.push(url);
      blocks.push({ kind, url, text: text(label) });
    }
  };
  const unsupported = (reason: string) => {
    reasons.push(reason);
    if (blocks.length < 100) blocks.push({ kind: "unsupported", reason });
  };
  const media = (
    value: Row,
    kind: "source_attachment" | "embed_preview",
    mediaType: "image" | "audio" | "video" | "file" | "unknown",
  ) => {
    const url = unsignedHistoricalUrl(value.url);
    if (!url || attachments.length >= 50) {
      unsupported("attachment_unavailable_or_limit");
      return;
    }
    const id =
      remotePostId(value.id) ||
      createHash("sha256").update(url).digest("hex").slice(0, 32);
    if (attachments.some((a) => a.id === id)) return;
    const attachment = {
      id,
      position: attachments.length,
      kind,
      mediaType,
      sourceUrl: url,
      archive: "not_requested" as const,
      ...(value.alt_text ? { altText: text(value.alt_text, 5000) } : {}),
      ...(typeof value.content_type === "string" ||
      typeof value.type === "string"
        ? { mimeType: text(value.content_type || value.type, 100) }
        : {}),
      ...(typeof value.filename === "string"
        ? { filename: text(value.filename, 200) }
        : {}),
      ...(Number.isSafeInteger(value.size) && value.size >= 0
        ? { bytes: value.size }
        : {}),
    };
    attachments.push(attachment);
    if (blocks.length < 100)
      blocks.push({ kind: "attachment", attachmentId: id });
    // Query-bearing URLs are used only in memory for the current retrieval.
    if (typeof value.url === "string" && value.url.length < 4096)
      retrieval.push({ attachmentId: id, url: value.url });
  };
  return {
    snapshot,
    reasons,
    retrieval,
    addText,
    addLink,
    media,
    unsupported,
    blocks,
  };
}
export function normalizeTumblrHistoricalPost(
  input: unknown,
  blog: { id: string; name: string },
): HistoricalRemotePost {
  const post = row(input),
    b = builder(),
    remoteId = remotePostId(post.id_string) || remotePostId(post.id);
  if (!remoteId) throw Error("Tumblr post has no lossless remote identity.");
  b.snapshot.sourceData={format:"tumblr",...sanitizeHistoricalSourceData(post)};
  if(b.snapshot.sourceData.truncated)b.reasons.push("source_data_limit");
  const trail = list(post.trail),
    reblog = Boolean(
      post.reblogged_from_id || post.reblogged_root_id || trail.length,
    );
  const trailContent = trail.flatMap((part) => [
    { type: "text", text: `Attributed to ${text(row(part.blog).name, 200)}` },
    ...(Array.isArray(part.content)
      ? list(part.content)
      : [{ type: "text", text: plain(part.content_raw || part.content) }]),
  ]);
  const content = [...trailContent, ...list(post.content)];
  if (content.length) {
    const mappedIndexes: number[] = [];
    for (const block of content.slice(0, 100)) {
      mappedIndexes.push(b.blocks.length);
      if (block.type === "text") {
        b.addText(block.text,block);
      } else if (block.type === "image")
        b.media(
          { ...row(list(block.media).find(media=>unsignedHistoricalUrl(media.url)) || list(block.media)[0]), alt_text: block.alt_text },
          "source_attachment",
          "image",
        );
      else if (block.type === "audio" || block.type === "video") {
        const media = Array.isArray(block.media)
          ? row(block.media[0])
          : row(block.media);
        if (media.url) b.media(media, "source_attachment", block.type);
        else {
          const embedded=typeof block.embed_html==="string"?block.embed_html.match(/src=["'](https?:\/\/[^"']+)["']/i)?.[1]:undefined;
          b.addLink(block.url || row(block.embed_iframe).url || embedded, block.title, "embed");
          if(block.title)b.addText(block.title);
          if(!block.url && !embedded && !row(block.embed_iframe).url)b.unsupported("source_content_retained");
          b.reasons.push("external_media_reference_retained");
        }
      } else if (block.type === "link") {
        b.addLink(block.url, block.title, "embed");
        if (row(block.poster).url)
          b.media(row(block.poster), "embed_preview", "image");
      } else {
        if(block.title)b.addText(block.title);
        if(block.text)b.addText(block.text);
        if(block.url)b.addLink(block.url,block.title);
        b.unsupported("source_content_retained");
      }
    }
    for (const layout of list(post.layout).slice(0, 100)) {
      if (layout.type === "rows")
        for (const display of list(layout.display)) {
          const indexes = Array.isArray(display.blocks)
            ? display.blocks
                .filter(
                  (n: unknown) =>
                    Number.isSafeInteger(n) &&
                    Number(n) >= 0 &&
                    Number(n) + trailContent.length < mappedIndexes.length,
                )
                .map((n: number) => mappedIndexes[n + trailContent.length])
                .filter((n: number) => n < b.blocks.length)
            : [];
          (b.snapshot.layout as any[]).push({
            kind: display.mode === "carousel" ? "carousel" : "rows",
            blockIndexes: indexes,
          });
        }
      else b.reasons.push("source_layout_retained");
    }
    if (content.length > 100) b.unsupported("block_limit");
  } else {
    b.addText(plain(post.title));
    const legacy=legacyFormattedText(post.body || post.caption || post.description || post.text || post.answer);
    b.addText(legacy.text,legacy);
    for (const photo of list(post.photos).slice(0, 50))
      b.media(row(photo.original_size), "source_attachment", "image");
    if (post.audio_url)
      b.media({ url: post.audio_url }, "source_attachment", "audio");
    if (post.video_url)
      b.media({ url: post.video_url }, "source_attachment", "video");
    b.addLink(post.url, post.title);
    for(const match of text(post.body || post.caption || post.description,100000).matchAll(/<img\b[^>]*src=["'](https?:\/\/[^"']+)["'][^>]*>/gi)){
      b.addLink(match[1],"Embedded image","embed");b.reasons.push("external_media_reference_retained");
    }
    if (post.type === "chat")
      for (const line of list(post.dialogue).slice(0, 50))
        b.addText(`${text(line.name)}: ${text(line.phrase)}`);
    b.reasons.push("legacy_format_normalized");
  }
  if (reblog) {
    b.reasons.push("attributed_reblog");
    if (!trail.length) b.unsupported("reblog_trail_unavailable");
  }
  (b.snapshot.tags as string[]).push(
    ...(Array.isArray(post.tags)
      ? post.tags
          .filter((t: unknown) => typeof t === "string")
          .slice(0, 100)
          .map((t: string) => text(t, 200))
      : []),
  );
  const known = post.state === undefined || post.state === "published",
    postedAt = timestamp(post.timestamp) || date(post.date);
  if (!postedAt) b.reasons.push("posted_time_unknown");
  if (post.state && !known) b.reasons.push("not_published");
  const complete = !known
    ? "unavailable"
    : !b.blocks.length
      ? "metadata_only"
      : b.reasons.some(
            (r) =>
              ![
                "legacy_format_normalized",
                "attributed_reblog",
                "posted_time_unknown", "public_link_normalized", "source_formatting_retained", "source_content_retained", "source_layout_retained", "external_media_reference_retained",
              ].includes(r),
          )
        ? "partial"
        : "full";
  return {
    remoteId,
    sourceUrl: unsignedHistoricalUrl(post.post_url,true),
    attribution: {
      authorId:
        post.is_submission && !post.post_author
          ? "unknown_submission_author"
          : remotePostId(row(post.author_blog).uuid) ||
            text(post.post_author, 500) ||
            blog.id,
      displayName: text(post.post_author, 500) || blog.name,
      kind: reblog ? "reblog" : "original",
      ...(reblog
        ? {
            originalAuthorId:
              remotePostId(row(trail[0]?.blog).uuid) ||
              text(post.reblogged_root_name, 500),
            originalAuthorName: text(
              row(trail[0]?.blog).name || post.reblogged_root_name,
              500,
            ),
          }
        : {}),
    },
    postedAt,
    remoteEditedAt: timestamp(post.updated) || date(post.updated_at),
    snapshot: b.snapshot,
    visibility: "public",
    completeness: complete,
    reasons: b.reasons,
    retrieval: b.retrieval,
  };
}
export function normalizeDiscordHistoricalMessage(
  input: unknown,
  guildId: string,
  channelId: string,
): HistoricalRemotePost {
  const post = row(input),
    b = builder(),
    remoteId = remotePostId(post.id),
    author = row(post.author);
  if (
    !remoteId ||
    post.channel_id !== channelId ||
    (post.guild_id && post.guild_id !== guildId) ||
    !remotePostId(author.id)
  )
    throw Error("Discord message is outside its selected source.");
  const kind =
    post.type === 19
      ? "reply"
      : post.message_reference?.type === 1 ||
          Array.isArray(post.message_snapshots)
        ? "forwarded"
        : post.type !== 0 || ((Number(post.flags) || 0) & 2) !== 0
          ? "system"
          : "original";
  b.snapshot.sourceData={format:"discord",...sanitizeHistoricalSourceData(post)};
  if(b.snapshot.sourceData.truncated)b.reasons.push("source_data_limit");
  b.addText(post.content,{syntax:"discord_markdown"});
  const reference = row(post.message_reference);
  if (kind === "reply" && remotePostId(reference.message_id)
    && (!reference.guild_id || reference.guild_id === guildId)
    && (!reference.channel_id || reference.channel_id === channelId)) {
    b.addLink(`https://discord.com/channels/${guildId}/${channelId}/${remotePostId(reference.message_id)}`, "Reply to message", "link");
  }

  for (const attachment of list(post.attachments).slice(0, 50)) {
    const mime = text(attachment.content_type, 100),
      mediaType = mime.startsWith("image/")
        ? "image"
        : mime.startsWith("video/")
          ? "video"
          : mime.startsWith("audio/")
            ? "audio"
            : "file";
    b.media(attachment, "source_attachment", mediaType);
  }
  for (const embed of list(post.embeds).slice(0, 10)) {
    b.addText(row(embed.author).name);
    b.addText(embed.title);
    b.addText(embed.description,{syntax:"discord_markdown"});
    b.addText(row(embed.footer).text);
    b.addLink(row(embed.video).url, undefined, "embed");
    b.addLink(embed.url, embed.title, "embed");
    for (const field of list(embed.fields).slice(0, 25))
      b.addText(`${text(field.name)}\n${text(field.value)}`);
    if (row(embed.image).url)
      b.media(row(embed.image), "embed_preview", "image");
    if (row(embed.thumbnail).url)
      b.media(row(embed.thumbnail), "embed_preview", "image");
  }
  for(const sticker of list(post.sticker_items)){
    b.addText(sticker.name);
    if(remotePostId(sticker.id))b.addLink(`https://cdn.discordapp.com/stickers/${sticker.id}.${sticker.format_type===3?"json":sticker.format_type===4?"gif":"png"}`,sticker.name,"embed");
  }
  if(post.poll)b.unsupported("source_content_retained");
  const component=(item:Row,depth=0)=>{if(depth>10)return;if(item.label)b.addText(item.label);if(item.content)b.addText(item.content,{syntax:"discord_markdown"});if(item.url)b.addLink(item.url,item.label);for(const child of list(item.components))component(child,depth+1);};
  for(const item of list(post.components))component(item);
  if(list(post.components).length && !b.blocks.length)b.unsupported("source_content_retained");
  if (kind === "forwarded") b.unsupported("forwarded_content_not_archived");
  if (
    !Array.isArray(post.attachments) ||
    !Array.isArray(post.embeds) ||
    typeof post.content !== "string"
  )
    b.reasons.push("message_content_access_required");
  const postedAt = date(post.timestamp);
  if (!postedAt) b.reasons.push("posted_time_unknown");
  return {
    remoteId,
    sourceUrl: `https://discord.com/channels/${guildId}/${channelId}/${remoteId}`,
    attribution: {
      authorId: remotePostId(post.webhook_id) || remotePostId(author.id),
      displayName: text(author.global_name || author.username, 500),
      kind,
    },
    postedAt,
    remoteEditedAt: date(post.edited_timestamp),
    snapshot: b.snapshot,
    visibility: "restricted",
    completeness: b.reasons.includes("message_content_access_required")
      ? "unavailable"
      : !b.blocks.length
        ? "metadata_only"
        : b.reasons.some(reason=>!["public_link_normalized","source_content_retained","external_media_reference_retained"].includes(reason))
          ? "partial"
          : "full",
    reasons: b.reasons,
    retrieval: b.retrieval,
  };
}
/** Discord role/member overwrites apply after guild permissions. Channel administration alone never authorizes an author's messages. */
export function discordHistoryPermissions(input: {
  guildId: string;
  botId: string;
  memberRoles: string[];
  roles: { id: string; permissions: string }[];
  overwrites: { id: string; type: number; allow: string; deny: string }[];
}): boolean {
  const roleIds = new Set([input.guildId, ...input.memberRoles]);
  let bits = input.roles
    .filter((r) => roleIds.has(r.id))
    .reduce((n, r) => n | BigInt(r.permissions), 0n);
  if (bits & 8n) return true;
  const apply = (rows: typeof input.overwrites) => {
    bits =
      (bits & ~rows.reduce((n, r) => n | BigInt(r.deny), 0n)) |
      rows.reduce((n, r) => n | BigInt(r.allow), 0n);
  };
  apply(input.overwrites.filter((o) => o.type === 0 && o.id === input.guildId));
  apply(
    input.overwrites.filter(
      (o) => o.type === 0 && o.id !== input.guildId && roleIds.has(o.id),
    ),
  );
  apply(input.overwrites.filter((o) => o.type === 1 && o.id === input.botId));
  return (bits & 1024n) !== 0n && (bits & 65536n) !== 0n;
}
