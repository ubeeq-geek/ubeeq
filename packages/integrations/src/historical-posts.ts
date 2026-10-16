import { historicalPublicQueryParameter } from "@ubeeq/core";
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
  const addText = (value: unknown) => {
    const content = text(value, 100000).replace(
      /https?:\/\/[^\s<>"()]+/g,
      (original) => {
        const normalized = unsignedHistoricalUrl(
          original.replace(/[.,;!?]+$/, ""),
          true,
        );
        if (!normalized) {
          reasons.push("unsupported_link");
          return "[unsupported link]";
        }
        if (normalized !== original.replace(/[.,;!?]+$/, ""))
          reasons.push("link_query_or_fragment_not_retained");
        return normalized;
      },
    );
    if (content && blocks.length < 100) {
      blocks.push({ kind: "text", text: content });
      for (const value of content.match(/https:\/\/[^\s<>"()]+/g) || []) {
        const url = unsignedHistoricalUrl(value.replace(/[.,;!?]+$/, ""), true);
        if (url && links.length < 100 && !links.includes(url)) links.push(url);
      }
    }
  };
  const addLink = (
    value: unknown,
    label?: unknown,
    kind: "link" | "embed" = "link",
  ) => {
    const url = unsignedHistoricalUrl(value, true);
    if (typeof value === "string" && url && url !== value)
      reasons.push("link_query_or_fragment_not_retained");
    if (url && links.length < 100 && blocks.length < 100) {
      links.push(url);
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
        b.addText(block.text);
        for (const format of list(block.formatting))
          if (format.type === "link") b.addLink(format.url);
          else if (format.type !== "mention")
            b.unsupported("unsupported_inline_formatting");
      } else if (block.type === "image")
        b.media(
          { ...row(list(block.media)[0]), alt_text: block.alt_text },
          "source_attachment",
          "image",
        );
      else if (block.type === "audio" || block.type === "video") {
        const media = Array.isArray(block.media)
          ? row(block.media[0])
          : row(block.media);
        if (media.url) b.media(media, "source_attachment", block.type);
        else {
          b.addLink(block.url, block.title, "embed");
          b.unsupported("external_media_not_archived");
        }
      } else if (block.type === "link") {
        b.addLink(block.url, block.title, "embed");
        if (row(block.poster).url)
          b.media(row(block.poster), "embed_preview", "image");
      } else
        b.unsupported(`unsupported_npf_${text(block.type, 50) || "block"}`);
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
      else b.unsupported(`unsupported_layout_${text(layout.type, 50)}`);
    }
    if (content.length > 100) b.unsupported("block_limit");
  } else {
    b.addText(plain(post.title));
    b.addText(
      plain(
        post.body ||
          post.caption ||
          post.description ||
          post.text ||
          post.answer,
      ),
    );
    for (const photo of list(post.photos).slice(0, 50))
      b.media(row(photo.original_size), "source_attachment", "image");
    if (post.audio_url)
      b.media({ url: post.audio_url }, "source_attachment", "audio");
    if (post.video_url)
      b.media({ url: post.video_url }, "source_attachment", "video");
    b.addLink(post.url, post.title);
    for (const match of text(
      post.body || post.caption || post.description,
      100000,
    ).matchAll(/href=["'](https:\/\/[^"']+)["']/gi))
      b.addLink(match[1]);
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
                "posted_time_unknown",
              ].includes(r),
          )
        ? "partial"
        : "full";
  return {
    remoteId,
    sourceUrl: unsignedHistoricalUrl(post.post_url),
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
  b.addText(post.content);
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
    b.addText(embed.description);
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
  if (
    list(post.sticker_items).length ||
    post.poll ||
    list(post.components).length
  )
    b.unsupported("unsupported_discord_components");
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
        : b.reasons.length
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
