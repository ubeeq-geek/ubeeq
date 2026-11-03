import test from 'node:test';
import assert from 'node:assert/strict';
import { BedrockTitlePolishProvider } from '../dist/title-polish.js';
const input = { title: 'the captors waiting', casing: 'preserve', language: 'en', preservedNames: ['Ubeeq'] };
test('Bedrock title provider uses an injected profile, bounded task prompt and no tools', async () => {
  let request;
  const provider = new BedrockTitlePolishProvider('eu.amazon.nova-micro-v1:0', async value => { request = value; return { stopReason: 'end_turn', output: { message: { content: [{ text: '{"status":"needs_context"}' }] } }, usage: { inputTokens: 80, outputTokens: 10 } }; }, 'eu-central-1');
  const result = await provider.polishTitle(input, new AbortController().signal);
  assert.equal(request.modelId, 'eu.amazon.nova-micro-v1:0'); assert.equal(request.inferenceConfig.maxTokens, 256); assert.ok(request.inferenceConfig.temperature <= 0.1);
  assert.deepEqual(JSON.parse(request.messages[0].content[0].text), input); assert.equal(request.toolConfig, undefined);
  assert.deepEqual(result.result, { status: 'needs_context' }); assert.equal(result.inputTokens, 80); assert.match(provider.identity, /title-polish-v1/);
});
test('refusals and truncated output fail without inventing a suggestion or retrying', async () => {
  for (const reason of ['guardrail_intervened', 'content_filtered', 'max_tokens']) {
    let calls = 0;
    const provider = new BedrockTitlePolishProvider('model', async () => { calls++; return { stopReason: reason }; });
    await assert.rejects(provider.polishTitle(input, new AbortController().signal)); assert.equal(calls, 1);
  }
});
