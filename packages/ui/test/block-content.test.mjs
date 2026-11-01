import test from 'node:test';
import assert from 'node:assert/strict';
import { createDescriptionBlock, parseDescriptionBlocks, normalizeDescriptionBlocks, clonePostBlocks, textToInlineHtml, sanitizeInlineHtml, serializeDescriptionBlocks } from '../dist/index.js';

test('description import preserves text paragraphs and emits stable block identities', () => {
  const blocks = parseDescriptionBlocks('First < literal\nline\n\nSecond');
  assert.equal(blocks.length, 2);
  assert.notEqual(blocks[0].blockId, blocks[1].blockId);
  assert.equal(blocks[0].text, 'First < literal\nline');
  assert.equal(blocks[0].html, 'First &lt; literal<br>line');
  assert.equal(createDescriptionBlock('heading').level, 2);
  assert.equal(createDescriptionBlock('divider').text, undefined);
});

test('portable inline rendering drops active content, and destination heading limits are explicit', () => {
  assert.equal(textToInlineHtml('<img onerror="bad">\nnext'), '&lt;img onerror=&quot;bad&quot;&gt;<br>next');
  assert.equal(sanitizeInlineHtml('<script>bad</script>'), '');
  const heading = [{ blockId: 'heading', type: 'heading', level: 6, text: 'Heading' }];
  assert.equal(serializeDescriptionBlocks(heading), '<h6>Heading</h6>');
  assert.equal(serializeDescriptionBlocks(heading, { maxHeadingLevel: 3 }), '<h3>Heading</h3>');
  assert.deepEqual(normalizeDescriptionBlocks([{ blockId: 'media', type: 'image', mediaId: 'asset' }]), []);
});

test('block cloning preserves nested identity, media and unknown metadata without aliasing', () => {
  const source = [{ blockId: 'section', type: 'section', payload: { custom: { items: ['original'] } },
    blocks: [{ blockId: 'file', type: 'file', fileId: 'source-file', mediaId: 'asset', payload: { nested: { value: 1 } } }] }];
  const copy = clonePostBlocks(source);
  assert.deepEqual(copy, source);
  copy[0].payload.custom.items.push('changed'); copy[0].blocks[0].payload.nested.value = 2;
  assert.deepEqual(source[0].payload.custom.items, ['original']);
  assert.equal(source[0].blocks[0].payload.nested.value, 1);
});

test('HTML description import preserves headings, quotes, dividers and inline runs without browser globals', () => {
  const blocks = parseDescriptionBlocks('Before <b>bold</b><h3>Heading</h3><blockquote>Quoted <i>words</i></blockquote><hr><p>After &amp; next</p>');
  assert.deepEqual(blocks.map(block => block.type), ['paragraph', 'heading', 'quote', 'divider', 'paragraph']);
  assert.equal(blocks[0].html, 'Before <strong>bold</strong>');
  assert.equal(blocks[1].level, 3); assert.equal(blocks[1].text, 'Heading');
  assert.equal(blocks[2].quote, 'Quoted words'); assert.equal(blocks[2].html, 'Quoted <em>words</em>');
  assert.equal(blocks[4].text, 'After & next');
  assert.equal(new Set(blocks.map(block => block.blockId)).size, 5);
  assert.match(serializeDescriptionBlocks(blocks), /<h3>Heading<\/h3>/);
});

test('HTML description import drops active content and unsafe links while retaining safe metadata', () => {
  const blocks = parseDescriptionBlocks('<script>private-script</script><svg><text>foreign</text></svg><p onclick="bad()">Safe <a href="javascript:bad()">label</a> <a href="https://example.test/">link</a><img src="private-source" onerror="bad()"></p>');
  const html = serializeDescriptionBlocks(blocks);
  assert.doesNotMatch(html, /private-script|foreign|onclick|javascript:|private-source|onerror|<img/);
  assert.match(html, /Safe label/); assert.match(html, /href="https:\/\/example.test\/"/);
});

test('description input has one total budget rather than per-paragraph bypasses', () => {
  assert.throws(() => parseDescriptionBlocks('x'.repeat(1_048_577)), /input budget/);
  assert.throws(() => parseDescriptionBlocks('<p>x</p>'.repeat(150000)), /input budget/);
  assert.throws(() => parseDescriptionBlocks('<br>'.repeat(50001)), /structure budget/);
  assert.throws(() => parseDescriptionBlocks('<span>'.repeat(257) + 'text' + '</span>'.repeat(257)), /structure budget/);
});

test('browser Enter paragraphs retain separation while inline Shift-Enter stays a single break', () => {
  const html = sanitizeInlineHtml('First paragraph.<div><strong>Second</strong> paragraph.</div><div>Third paragraph.</div>');
  assert.equal(html, 'First paragraph.<br><br><strong>Second</strong> paragraph.<br><br>Third paragraph.');
  assert.equal(sanitizeInlineHtml(html), html);
  assert.equal(sanitizeInlineHtml('First<br>second'), 'First<br>second');
  assert.equal(sanitizeInlineHtml('<p>First</p><p>Second</p>'), 'First<br><br>Second');
  const blocks = normalizeDescriptionBlocks([{ blockId: 'one', type: 'paragraph', html }]);
  assert.equal(blocks[0].text, 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
  assert.equal(serializeDescriptionBlocks(blocks), `<p>${html}</p>`);
});

test('literal pasted newlines become explicit breaks and stay stable across sanitizing',()=>{
 const html=sanitizeInlineHtml('First line\r\n<strong>Second\nline</strong>\n\nLast line');
 assert.equal(html,'First line<br><strong>Second<br>line</strong><br><br>Last line');assert.equal(sanitizeInlineHtml(html),html);
 assert.equal(textToInlineHtml('One\rTwo\r\nThree'),'One<br>Two<br>Three');
});
test('split paragraphs balance inline markup and preserve links, order and the original first identity',async()=>{
 const {splitParagraphBlock}=await import('../dist/block-content.js');
 const source={blockId:'original',type:'paragraph',html:'<strong>First<br><em>Second<br>Third</em></strong><br><br><a href="https://example.com/a?x=1&amp;y=2">Fourth\nFifth</a><script>bad</script>'},before=structuredClone(source);
 const parts=splitParagraphBlock(source);assert.deepEqual(parts.map(block=>block.text),['First','Second','Third','Fourth','Fifth']);assert.equal(parts[0].blockId,'original');assert.equal(new Set(parts.map(block=>block.blockId)).size,5);assert.deepEqual(source,before);
 assert.equal(parts[0].html,'<strong>First</strong>');assert.equal(parts[1].html,'<strong><em>Second</em></strong>');assert.equal(parts[2].html,'<strong><em>Third</em></strong>');assert.match(parts[3].html,/href="https:\/\/example.com\/a\?x=1&amp;y=2"/);assert.ok(parts.every(block=>sanitizeInlineHtml(block.html)===block.html));assert.ok(parts.every(block=>!block.html.includes('bad')));
 assert.equal(splitParagraphBlock({blockId:'one',type:'paragraph',text:'One line'}).length,1);
 assert.equal(splitParagraphBlock({blockId:'two',type:'paragraph',text:'One\n\nTwo'}).length,2);
 assert.throws(()=>splitParagraphBlock({blockId:'huge',type:'paragraph',text:'Line\n'.repeat(1001)}),/1,000/);
});

test('ordered and unordered lists preserve items, inline formatting and links across description round trips',async()=>{
 const {createListBlock,sanitizeListHtml,inlineHtmlToText}=await import('../dist/index.js');
 for(const [style,tag,marker]of[['ordered','ol','1.'],['unordered','ul','•']]){
  const block={...createListBlock(style),html:`<${tag}><li><strong>First</strong></li><li><a href="https://example.com">Second</a></li></${tag}>`};
  const saved=serializeDescriptionBlocks([block]),restored=parseDescriptionBlocks(saved);
  assert.match(saved,new RegExp(`^<${tag}><li><strong>First</strong></li><li><a`));
  assert.equal(restored[0].payload.listStyle,style);assert.equal(serializeDescriptionBlocks(restored),saved);
  assert.match(inlineHtmlToText(saved),new RegExp(marker==='1.'?'1\\. First\\n2\\. Second':'• First\\n• Second'));
  const clean=sanitizeListHtml('<ol onclick="bad()"><li><img src=x onerror="bad()"><script>bad()</script>Safe <a href="javascript:bad()">link</a></li></ol>',style);
  assert.doesNotMatch(clean,/onclick|onerror|javascript|<script|<img/);assert.match(clean,/Safe link/);
  assert.throws(()=>sanitizeListHtml('<ul><li>'.repeat(130)+'text'+'</li></ul>'.repeat(130),style),/nesting/);
 }
});

test('list marker changes retain items and formatting through HTML and plain-text round trips',async()=>{
 const {sanitizeListHtml,textBlockHtml,inlineHtmlToText}=await import('../dist/block-content.js');
 const initial='<ol><li><strong>First</strong></li><li>Second</li></ol>';
 for(const [marker,style,tag,prefix] of [['numbers','ordered','ol','1.'],['letters','ordered','ol','a.'],['dashes','unordered','ul','–'],['dots','unordered','ul','•']]){
  const html=sanitizeListHtml(initial,style,marker),block={blockId:'list',type:'paragraph',payload:{listStyle:style,listMarker:marker},html};
  assert.match(html,new RegExp(`^<${tag}[ >]`));assert.match(html,/<strong>First<\/strong>/);
  const saved=serializeDescriptionBlocks([block]),restored=parseDescriptionBlocks(saved);
  assert.equal(textBlockHtml(restored[0]),saved);assert.equal(serializeDescriptionBlocks(restored),saved);
  assert.ok(inlineHtmlToText(saved).startsWith(prefix+' First'));
 }
 const clean=sanitizeListHtml('<ol type="a" onclick="bad()" style="color:red"><li>Safe</li></ol>','ordered','letters');
 assert.equal(clean,'<ol type="a"><li>Safe</li></ol>');
 assert.match(inlineHtmlToText('<ol type="a">'+'<li>Item</li>'.repeat(27)+'</ol>'),/z\. Item\naa\. Item/);
});

test('untitled sections get sequential fragment links while existing and custom anchors are retained',async()=>{
 const {websiteSectionAnchors}=await import('../dist/block-content.js');
 const blocks=[{blockId:'one',type:'section',blocks:[]},{blockId:'two',type:'section',blocks:[]},{blockId:'custom',type:'section',payload:{anchor:'My Gallery'},blocks:[]},{blockId:'legacy',type:'section',title:'Existing section',blocks:[]}];
 const before=structuredClone(blocks),anchors=websiteSectionAnchors(blocks);
 assert.equal(anchors.get('one'),'section1');assert.equal(anchors.get('two'),'section2');assert.equal(anchors.get('custom'),'my-gallery');assert.equal(anchors.get('legacy'),'existing-section');assert.deepEqual(blocks,before);
});

test('resetting block presentation clears formatting overrides and preserves content, links and semantic types',async()=>{
 const {resetBlockPresentation}=await import('../dist/block-content.js');
 const quote={blockId:'q',type:'quote',author:'Author',html:'<strong>Bold</strong> <em>italic</em> <u>underline</u> <a href="https://example.com">link</a>',payload:{textAlign:'right',custom:'keep'}};
 const original=structuredClone(quote),reset=resetBlockPresentation(quote);
 assert.equal(reset.type,'quote');assert.equal(reset.author,'Author');assert.deepEqual(reset.payload,{custom:'keep'});assert.doesNotMatch(reset.html,/<strong|<em|<u>/);assert.match(reset.html,/<a href="https:\/\/example.com"/);assert.match(reset.quote,/Bold italic underline link/);assert.deepEqual(quote,original);
 const list=resetBlockPresentation({blockId:'list',type:'paragraph',html:'<ol type="a"><li><strong>First</strong></li></ol>',payload:{listStyle:'ordered',listMarker:'letters',textAlign:'center'}});
 assert.deepEqual(list.payload,{listStyle:'ordered'});assert.equal(list.html,'<ol><li>First</li></ol>');
 const image=resetBlockPresentation({blockId:'image',type:'image',mediaId:'asset',caption:'Keep caption',payload:{alignment:'right',textFlow:'wrap',desktopWidth:45,mobileWidth:80,alt:'Keep description'}});
 assert.equal(image.mediaId,'asset');assert.equal(image.caption,'Keep caption');assert.deepEqual(image.payload,{alt:'Keep description'});
 const link=resetBlockPresentation({blockId:'link',type:'link',label:'Keep link',url:'https://example.com',payload:{appearance:'primary',action:'custom'}});
 assert.equal(link.url,'https://example.com');assert.deepEqual(link.payload,{action:'custom'});
});
