import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTumblrHistoricalPost,
  normalizeDiscordHistoricalMessage,
  discordHistoryPermissions,
} from "../dist/index.js";
const tumblr = {
  id_string: "9999999999999999999",
  timestamp: 1792051200,
  post_url: "https://brand.tumblr.com/post/9999999999999999999",
  content: [
    {
      type: "text",
      text: "Release https://app.example/creators/brand/works/book",
      formatting: [],
    },
    {
      type: "image",
      alt_text: "First image",
      media: [{ url: "https://64.media.tumblr.com/first.jpg" }],
    },
    {
      type: "image",
      media: [{ url: "https://64.media.tumblr.com/second.jpg" }],
    },
  ],
  layout: [{ type: "rows", display: [{ blocks: [1, 2], mode: "carousel" }] }],
  tags: ["release"],
};
test("normalizes NPF order, layout, tags, attribution, dates and several attachments without inferring Works", () => {
  const result = normalizeTumblrHistoricalPost(tumblr, {
    id: "blog",
    name: "Brand",
  });
  assert.equal(result.remoteId, tumblr.id_string);
  assert.equal(result.attribution.authorId, "blog");
  assert.equal(result.snapshot.attachments.length, 2);
  assert.equal(result.snapshot.attachments[0].altText, "First image");
  assert.deepEqual(result.snapshot.layout, [
    { kind: "carousel", blockIndexes: [1, 2] },
  ]);
  assert.equal(
    result.snapshot.links[0],
    "https://app.example/creators/brand/works/book",
  );
  assert.equal(result.snapshot.tags[0], "release");
  assert.equal(result.visibility, "public");
});
test("legacy HTML is flattened into safe text and explicit links; scripts are never rendered", () => {
  const result = normalizeTumblrHistoricalPost(
    {
      id_string: "post",
      type: "text",
      body: '<script>alert(1)</script><p>Hello <a href="https://app.example/work">Work</a></p>',
    },
    { id: "blog", name: "Brand" },
  );
  assert.equal(result.postedAt, null);
  assert.equal(result.snapshot.blocks[0].text, "Hello Work");
  assert.deepEqual(result.snapshot.links, ["https://app.example/work"]);
  assert.ok(result.reasons.includes("legacy_format_normalized"));
});
test("reblog trails retain original attribution and content without implying ownership", () => {
  const result = normalizeTumblrHistoricalPost(
    {
      ...tumblr,
      trail: [
        {
          blog: { uuid: "original", name: "Original author" },
          content: [{ type: "text", text: "Original words" }],
        },
      ],
    },
    { id: "blog", name: "Brand" },
  );
  assert.equal(result.attribution.kind, "reblog");
  assert.equal(result.attribution.originalAuthorId, "original");
  assert.ok(result.snapshot.blocks.some((b) => b.text === "Original words"));
  assert.ok(
    result.snapshot.blocks.some((b) => b.text?.includes("Original author")),
  );
});
test("unsupported blocks become explicit partial warnings; unsafe numeric IDs are rejected", () => {
  assert.equal(
    normalizeTumblrHistoricalPost(
      { ...tumblr, content: [{ type: "paywall" }] },
      { id: "blog", name: "Brand" },
    ).completeness,
    "partial",
  );
  assert.throws(() =>
    normalizeTumblrHistoricalPost(
      { id: 9999999999999999999 },
      { id: "blog", name: "Brand" },
    ),
  );
  assert.equal(
    normalizeTumblrHistoricalPost(
      { ...tumblr, state: "private" },
      { id: "blog", name: "Brand" },
    ).completeness,
    "unavailable",
  );
});
const discord = {
  id: "1234567890123456789",
  channel_id: "channel",
  guild_id: "guild",
  type: 0,
  content: "Read https://app.example/creators/brand/works/book @everyone",
  author: { id: "author", username: "Author" },
  timestamp: "2026-10-15T00:00:00Z",
  edited_timestamp: null,
  attachments: [
    {
      id: "attachment",
      url: "https://cdn.discordapp.com/attachments/channel/attachment/photo.png?ex=secret&hm=signature",
      content_type: "image/png",
      size: 5,
    },
  ],
  embeds: [],
};
test("Discord preserves restricted source identity and ordered attachments while separating ephemeral signed retrieval URLs", () => {
  const result = normalizeDiscordHistoricalMessage(discord, "guild", "channel");
  assert.equal(result.visibility, "restricted");
  assert.equal(result.attribution.authorId, "author");
  assert.equal(
    result.snapshot.attachments[0].sourceUrl,
    "https://cdn.discordapp.com/attachments/channel/attachment/photo.png",
  );
  assert.ok(result.retrieval[0].url.includes("signature"));
  assert.ok(!JSON.stringify(result.snapshot).includes("secret"));
  assert.equal(
    result.sourceUrl,
    "https://discord.com/channels/guild/channel/1234567890123456789",
  );
  assert.equal(
    result.snapshot.links[0],
    "https://app.example/creators/brand/works/book",
  );
});
test("Discord replies, forwards, fan-out and system events have distinct non-original attribution", () => {
  assert.equal(
    normalizeDiscordHistoricalMessage(
      { ...discord, type: 19 },
      "guild",
      "channel",
    ).attribution.kind,
    "reply",
  );
  assert.equal(
    normalizeDiscordHistoricalMessage(
      { ...discord, message_reference: { type: 1 } },
      "guild",
      "channel",
    ).attribution.kind,
    "forwarded",
  );
  assert.equal(
    normalizeDiscordHistoricalMessage(
      { ...discord, flags: 2 },
      "guild",
      "channel",
    ).attribution.kind,
    "system",
  );
  assert.equal(
    normalizeDiscordHistoricalMessage(
      { ...discord, type: 6 },
      "guild",
      "channel",
    ).attribution.kind,
    "system",
  );
  assert.throws(() =>
    normalizeDiscordHistoricalMessage(discord, "other", "channel"),
  );
  assert.equal(
    normalizeDiscordHistoricalMessage(
      { ...discord, content: undefined },
      "guild",
      "channel",
    ).completeness,
    "unavailable",
  );
});
test("channel history permissions require View Channel and Read Message History after role/member overwrites", () => {
  const input = {
    guildId: "guild",
    botId: "bot",
    memberRoles: ["role"],
    roles: [
      { id: "guild", permissions: "1024" },
      { id: "role", permissions: "65536" },
    ],
    overwrites: [],
  };
  assert.equal(discordHistoryPermissions(input), true);
  assert.equal(
    discordHistoryPermissions({
      ...input,
      overwrites: [{ id: "guild", type: 0, allow: "0", deny: "65536" }],
    }),
    false,
  );
  assert.equal(
    discordHistoryPermissions({
      ...input,
      overwrites: [
        { id: "guild", type: 0, allow: "0", deny: "65536" },
        { id: "bot", type: 1, allow: "65536", deny: "0" },
      ],
    }),
    true,
  );
  assert.equal(
    discordHistoryPermissions({
      ...input,
      roles: [{ id: "guild", permissions: "16" }],
    }),
    false,
  );
});

test('signed URLs in text are sanitized while meaningful public video identifiers remain intact',()=>{
 const result=normalizeDiscordHistoricalMessage({...discord,content:'Media https://cdn.discordapp.com/attachments/channel/attachment/photo.png?hm=PRIVATE-SIGNATURE. Video https://www.youtube.com/watch?v=dQw4w9WgXcQ',attachments:[]},'guild','channel');
 assert.ok(!JSON.stringify(result.snapshot).includes('PRIVATE-SIGNATURE'));assert.ok(result.snapshot.links.includes('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));assert.equal(result.completeness,'partial');
});
