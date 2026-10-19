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
test("unfamiliar source blocks are retained without stopping import; unsafe numeric IDs are rejected", () => {
  assert.equal(
    normalizeTumblrHistoricalPost(
      { ...tumblr, content: [{ type: "paywall" }] },
      { id: "blog", name: "Brand" },
    ).completeness,
    "full",
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
 assert.ok(!JSON.stringify(result.snapshot).includes('PRIVATE-SIGNATURE'));assert.ok(result.snapshot.links.includes('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));assert.equal(result.completeness,'full');
});

test('Tumblr retains styles, Unicode ranges, links, subtypes, and original platform structure',()=>{
 const input={...tumblr,content:[{type:'text',text:'🌳 Styled link',subtype:'heading2',formatting:[{type:'bold',start:2,end:8},{type:'italic',start:4,end:8},{type:'color',start:2,end:8,hex:'#ff492f'},{type:'link',start:9,end:13,url:'https://example.com/read?id=42#chapter'},{type:'mention',start:2,end:8,blog:{name:'artist',url:'https://artist.tumblr.com/'}}]}]};
 const result=normalizeTumblrHistoricalPost(input,{id:'blog',name:'Artist'});assert.equal(result.completeness,'full');assert.equal(result.snapshot.blocks[0].subtype,'heading2');assert.equal(result.snapshot.blocks[0].formatting.length,5);assert.equal(result.snapshot.blocks[0].formatting[0].start,2);assert.equal(result.snapshot.blocks[0].formatting[3].url,'https://example.com/read?id=42#chapter');assert.deepEqual(JSON.parse(result.snapshot.sourceData.json).content,input.content);
});
test('legacy Tumblr inline styles and full public links survive normalization',()=>{
 const result=normalizeTumblrHistoricalPost({id_string:'legacy',timestamp:1792051200,body:'<p>Hello <strong>bold</strong> and <em>italic</em> <a href="https://example.com/read?id=3#part">read</a>.</p>'},{id:'blog',name:'Artist'});
 assert.equal(result.completeness,'full');assert.ok(result.snapshot.blocks[0].formatting.some(format=>format.type==='bold'));assert.ok(result.snapshot.blocks[0].formatting.some(format=>format.type==='italic'));assert.ok(result.snapshot.links.includes('https://example.com/read?id=3#part'));
});
test('unknown Tumblr blocks, layouts, and external media are retained without blocking imports',()=>{
 const result=normalizeTumblrHistoricalPost({...tumblr,content:[{type:'future-poll',question:'Pick one',answers:['A','B']},{type:'video',url:'https://video.example/watch?id=42#start'}],layout:[{type:'ask',blocks:[0],attribution:{blog:{name:'reader'}}}]},{id:'blog',name:'Artist'});
 assert.equal(result.completeness,'full');const source=JSON.parse(result.snapshot.sourceData.json);assert.equal(source.content[0].answers[1],'B');assert.equal(source.layout[0].type,'ask');assert.ok(result.snapshot.links.includes('https://video.example/watch?id=42#start'));
});
test('Discord retains Markdown, polls, components and sticker metadata without storing signed retrieval URLs',()=>{
 const input={...discord,content:'**Bold** and _italic_ [read](https://example.com/read?id=42#part)',poll:{question:{text:'Choose'},answers:[{answer_id:1,poll_media:{text:'A'}}],results:{answer_counts:[{id:1,count:3}]}},components:[{type:1,components:[{type:2,label:'Read',url:'https://example.com/read?id=42#part'}]}],sticker_items:[{id:'123',name:'Party',format_type:1}]};
 const result=normalizeDiscordHistoricalMessage(input,'guild','channel');assert.equal(result.completeness,'full');assert.equal(result.snapshot.blocks[0].syntax,'discord_markdown');const source=JSON.parse(result.snapshot.sourceData.json);assert.equal(source.poll.results.answer_counts[0].count,3);assert.equal(source.components[0].components[0].label,'Read');assert.ok(!result.snapshot.sourceData.json.includes('signature'));
});

test('DeviantArt retains journal formatting and media with inert sanitized provider evidence', async () => {
  const { normalizeDeviantArtHistoricalPost } = await import('../dist/index.js');
  const { validateHistoricalSnapshot, historicalSourceContentHash } = await import('../../core/dist/index.js');
  const raw={deviationid:'journal-id',title:'An update',author:{userid:'artist',username:'Artist'},published_time:'2026-10-15T12:00:00Z',html:'<p>Hello <b>friends</b></p><img src="https://images.example.wixmp.com/image.png?token=SECRET">',stats:{comments:3,favourites:4}};
  const post=normalizeDeviantArtHistoricalPost(raw,'journal');
  validateHistoricalSnapshot(post.snapshot);
  assert.equal(post.completeness,'full');assert.equal(post.postedAt,'2026-10-15T12:00:00.000Z');
  assert.ok(post.snapshot.blocks.some(block=>block.text==='Hello friends' && block.formatting.some(format=>format.type==='bold')));
  assert.equal(post.snapshot.attachments[0].sourceUrl,'https://images.example.wixmp.com/image.png');
  assert.equal(JSON.stringify(post.snapshot).includes('SECRET'),false);
  const source={...post,identity:{tenantId:'tenant',ownerId:'creator',provider:'deviantart',providerOrigin:'https://www.deviantart.com',containers:[{kind:'account',id:'artist'}],remoteId:'journal-id'}};
  const changed=normalizeDeviantArtHistoricalPost({...raw,stats:{comments:30,favourites:40}},'journal');
  assert.equal(await historicalSourceContentHash(source),await historicalSourceContentHash({...source,snapshot:changed.snapshot}));
});
