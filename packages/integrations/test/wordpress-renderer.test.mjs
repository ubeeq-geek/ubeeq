import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { renderWordPressContent } from '../dist/index.js';

test('WordPress renderer declarations accept canonical metadata without weakening rendered fields', () => {
  const filename = fileURLToPath(new URL('./wordpress-types.fixture.mts', import.meta.url));
  const source = `
    import { renderWordPressContent } from '../dist/index.js';
    renderWordPressContent([{ blockId: 'p', type: 'paragraph', text: 'Text', payload: { custom: true } }]);
    renderWordPressContent([{ blockId: 's', type: 'section', blocks: [{ blockId: 'c', type: 'paragraph' }] }]);
    interface Stored { blockId: string; type: string; text?: string; blocks?: Stored[]; }
    const stored: Stored[] = [{ blockId: 'p', type: 'paragraph' }];
    renderWordPressContent(stored);
    renderWordPressContent([{ type: 'embed', url: 'https://example.com' }] as const, { approvedEmbedHosts: ['example.com'] as const });
    // @ts-expect-error rendered fields retain their types
    renderWordPressContent([{ type: 'link', url: 42 }]);
  `;
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ['node'] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...args) => name === filename
    ? ts.createSourceFile(name, source, version, true)
    : original(name, version, ...args);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host));
  assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
});

test('WordPress rendering preserves canonical semantic output without mutating input', () => {
  const blocks = [
    { type: 'heading', level: 3, text: 'Safe & sound' },
    { type: 'paragraph', text: '<script>"x"</script>\'&' },
    { type: 'section', blocks: [{ type: 'quote', quote: 'Quoted > text' }, { type: 'divider' }] },
    { type: 'link', url: 'https://example.com/?a=1&b=2', label: 'Read "this"' },
    { type: 'link', url: 'mailto:hello@example.com' }
  ];
  const before = structuredClone(blocks);
  assert.equal(renderWordPressContent(blocks), [
    '<h3>Safe &amp; sound</h3>',
    '<p>&lt;script&gt;&quot;x&quot;&lt;/script&gt;&#39;&amp;</p>',
    '<blockquote><p>Quoted &gt; text</p></blockquote>\n<hr />',
    '<p><a href="https://example.com/?a=1&amp;b=2" rel="noopener noreferrer">Read &quot;this&quot;</a></p>',
    '<p><a href="mailto:hello@example.com" rel="noopener noreferrer">mailto:hello@example.com</a></p>'
  ].join('\n'));
  assert.deepEqual(blocks, before);
  assert.equal(renderWordPressContent(), '');
  assert.equal(renderWordPressContent([{ type: 'heading', level: 1 }, { type: 'heading', level: 9 }]), '<h2></h2>\n<h6></h6>');
});

test('WordPress embeds require exact approved HTTPS hosts, including inside sections', () => {
  const policy = { approvedEmbedHosts: ['VIDEO.EXAMPLE'] };
  const block = { type: 'embed', url: 'https://video.example/watch?a=1&b=2', title: '<Watch>' };
  assert.equal(renderWordPressContent([block], policy), '<!-- wp:embed -->\n<figure class="wp-block-embed"><div class="wp-block-embed__wrapper">https://video.example/watch?a=1&amp;b=2</div></figure>\n<!-- /wp:embed -->');
  assert.equal(renderWordPressContent([block], { ...policy, format: 'classic' }), '<p><a href="https://video.example/watch?a=1&amp;b=2" rel="noopener noreferrer">&lt;Watch&gt;</a></p>');
  assert.throws(() => renderWordPressContent([block]), /Untrusted WordPress embed provider/);
  for (const url of ['invalid', 'http://video.example/watch', 'https://sub.video.example/watch', 'https://video.example.evil.test/watch', 'https://user:password@video.example/watch']) {
    assert.throws(() => renderWordPressContent([{ type: 'section', blocks: [{ ...block, url }] }], policy), /Untrusted WordPress embed provider/);
  }
});

test('WordPress rejects unsupported blocks and unsafe link schemes instead of emitting raw HTML', () => {
  for (const type of ['html_fragment', 'video', 'audio', 'file', 'pdf_preview', 'unknown']) {
    assert.throws(() => renderWordPressContent([{ type, html: '<script>bad()</script>' }]), new RegExp(`Unsupported WordPress block: ${type}`));
  }
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', 'http://example.com', 'ftp://example.com']) {
    assert.throws(() => renderWordPressContent([{ type: 'link', url }]), /Only HTTPS and email links are supported/);
  }
});
