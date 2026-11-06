'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, request, message } = require('./router-fixture');

const title = '**思考过程**\n\n';
const thoughts = ['反复核对 🧭\n'.repeat(1800) + 'FACT decision=Keep_full_context_R8',
  'FACT pending=Return_to_API_S2'];
const nativeSummary = [{ type: 'summary_text', text: 'Existing native summary' }];

for (const mode of ['ok', 'json']) {
  test('local ' + mode + ' reasoning uses titled summary blocks and restores every original character', async (t) => {
    const f = await fixture(t);
    f.local.mode = mode;
    f.local.normalReasoning = thoughts;
    f.local.nativeSummary = nativeSummary;
    f.local.normalExtras = 'FACT answer=Reviewable_proposal';
    const result = await request(f.url, { model: 'LOCAL model', input: [message('user', 'Proceed')], stream: mode !== 'json' });
    assert.equal(result.status, 200, result.text.slice(0, 1000));
    const thought = result.json.output.find((item) => item.type === 'reasoning');
    assert.deepEqual(thought.content, []);
    assert.deepEqual(thought.summary, [...nativeSummary, ...thoughts.map((text) => ({ type: 'summary_text', text: title + text }))]);
    const answer = result.json.output.find((item) => item.type === 'message');
    assert.equal(answer.content[0].text, 'FACT answer=Reviewable_proposal');
    if (mode === 'ok') {
      assert.ok(!result.events.some((event) => event.type === 'response.reasoning_text.delta'));
      for (const [i, text] of thoughts.entries()) {
        const deltas = result.events.filter((event) => event.type === 'response.reasoning_summary_text.delta' && event.summary_index === i + 1);
        assert.equal(deltas.map((event) => event.delta).join(''), title + text);
        assert.ok(deltas.every((event) => event.item_id === thought.id && event.output_index === 0 && !('content_index' in event)));
      }
      assert.deepEqual(result.events.find((event) => event.type === 'response.output_item.done').item, thought);
    }
    f.local.normalReasoning = '';
    f.local.nativeSummary = [];
    f.local.normalExtras = '';
    await f.restart();
    await request(f.url, { model: 'LOCAL model', input: [message('user', 'Continue'), ...result.json.output] });
    const forwarded = f.local.requests.at(-1).body.input.find((item) => item.type === 'reasoning');
    assert.deepEqual(forwarded.summary, nativeSummary);
    assert.deepEqual(forwarded.content, thoughts.map((text) => ({ type: 'reasoning_text', text })));
    const compact = await request(f.url, { model: 'LOCAL model', stream: true, input: [...result.json.output, { type: 'compaction_trigger' }] });
    assert.equal(compact.json.output[0].type, 'compaction');
    await f.restart();
    const recall = await request(f.url, { model: 'gpt-test', input: compact.json.output });
    const recalled = JSON.stringify(recall.json.output);
    for (const fact of ['Keep_full_context_R8', 'Return_to_API_S2', 'Reviewable_proposal']) assert.ok(recalled.includes(fact), fact);
  });
}

test('cloud raw reasoning and native local summaries retain their original presentation', async (t) => {
  const f = await fixture(t);
  f.cloud.normalReasoning = thoughts;
  f.cloud.nativeSummary = nativeSummary;
  const cloud = await request(f.url, { model: 'gpt-test', input: [message('user', 'Proceed')], stream: true });
  const cloudThought = cloud.json.output.find((item) => item.type === 'reasoning');
  assert.deepEqual(cloudThought.summary, nativeSummary);
  assert.deepEqual(cloudThought.content, thoughts.map((text) => ({ type: 'reasoning_text', text })));
  assert.ok(cloud.events.some((event) => event.type === 'response.reasoning_text.delta'));
  f.local.nativeSummary = nativeSummary;
  const local = await request(f.url, { model: 'LOCAL model', input: [message('user', 'Proceed')], stream: true });
  assert.deepEqual(local.json.output.find((item) => item.type === 'reasoning').summary, nativeSummary);
  assert.ok(!local.text.includes(title));
  const nativeCloud = { type: 'reasoning', id: 'rs_cloud', encrypted_content: 'cloud-owned-ciphertext',
    summary: [{ type: 'summary_text', text: title + 'A provider-owned summary with the same heading' }] };
  await request(f.url, { model: 'gpt-test', input: [nativeCloud] });
  assert.deepEqual(f.cloud.requests.at(-1).body.input, [nativeCloud]);
});
