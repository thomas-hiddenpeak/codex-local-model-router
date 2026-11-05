'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { fixture, request, message } = require('./router-fixture');

const history = [
  message('user', 'FACT goal=Implement_delta_paginator\nFACT constraint=Do_not_modify_live_service'),
  message('assistant', 'FACT file=src/cache.py\nFACT change=PageSize_128'),
  { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"pytest"}' },
  { type: 'function_call_output', call_id: 'call_1', output: 'FACT tool=pytest_17_passed' },
  message('assistant', 'FACT pending=Handle_429_retry'),
];
const trigger = { type: 'compaction_trigger' };
const compact = (model, input = history) => ({ model, stream: true, store: false, input: [...input, trigger] });
const followup = (model, item) => ({ model, input: [message('user', 'continue'), item], stream: true });
const expected = ['Implement_delta_paginator', 'Do_not_modify_live_service', 'src/cache.py',
  'PageSize_128', 'pytest_17_passed', 'Handle_429_retry'];

function checkpoint(result) {
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.status, 'completed');
  assert.equal(result.json.output.length, 1);
  assert.equal(result.events.filter((event) => event.type === 'response.output_item.done').length, 1);
  const item = result.json.output[0];
  assert.ok(item.encrypted_content.startsWith('codex_router_summary_v1.'));
  assert.ok(!item.encrypted_content.includes('pytest_17_passed'));
  return item;
}

test('real backend summary restores assistant/tool facts after restart and both model switches', async (t) => {
  const f = await fixture(t);
  const item = checkpoint(await request(f.url, compact('LOCAL model')));
  const summaryCall = f.local.requests.find((entry) => entry.summary);
  assert.ok(summaryCall.body.input[0].content[0].text.includes('function_call_output'));
  assert.equal(summaryCall.headers.authorization, undefined);
  assert.deepEqual(summaryCall.body.tools, []);
  assert.equal(summaryCall.body.tool_choice, 'none');
  const key = path.join(f.dir, 'state', 'summary-key');
  assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(key)).mode & 0o777, 0o700);
  const keyBytes = fs.readFileSync(key);
  await f.restart();
  assert.deepEqual(fs.readFileSync(key), keyBytes);
  for (const model of ['LOCAL model', 'gpt-test', 'LOCAL model']) {
    const result = await request(f.url, followup(model, item));
    assert.equal(result.status, 200, result.text);
    const output = JSON.stringify(result.json.output);
    for (const fact of expected) assert.ok(output.includes(fact), model + ' lost ' + fact);
    const backend = model.startsWith('LOCAL') ? f.local : f.cloud;
    const forwarded = backend.requests.at(-1);
    assert.ok(forwarded.body.input.every((entry) => entry.type !== 'compaction'));
    if (model === 'gpt-test') assert.equal(forwarded.headers.authorization, 'Bearer test-only');
  }
});

test('cloud compaction and repeated compaction produce portable cumulative summaries', async (t) => {
  const f = await fixture(t);
  const localItem = checkpoint(await request(f.url, compact('LOCAL model')));
  const input = [localItem, message('assistant', 'FACT later=Cursor_checksum_9b7e')];
  const cloudItem = checkpoint(await request(f.url, compact('gpt-test', input)));
  assert.equal(f.cloud.requests.at(-1).summary, true);
  assert.equal(f.cloud.requests.at(-1).body.max_output_tokens, undefined);
  const result = await request(f.url, followup('LOCAL model', cloudItem));
  const output = JSON.stringify(result.json.output);
  for (const fact of [...expected, 'Cursor_checksum_9b7e']) assert.ok(output.includes(fact));
});

test('reasoning/tool-only progress survives three Codex V2 retention cycles and model switches', async (t) => {
  const f = await fixture(t);
  const user = message('user', 'FACT goal=Plan_before_implementing');
  const facts = ['Plan_before_implementing', 'Visible_prior_decision_S4'];
  let input = [user, { type: 'reasoning', id: 'provider-only-id',
    encrypted_content: 'opaque-provider-secret',
    summary: [{ type: 'summary_text', text: 'FACT prior=Visible_prior_decision_S4' }],
  }];
  for (let round = 0; round < 3; round++) {
    input.push({ type: 'reasoning', summary: [], content: [
      { type: 'reasoning_text', text: 'FACT decision=Candidate_' + round },
    ] }, { type: 'function_call', name: 'exec_command', call_id: 'call_' + round,
      arguments: JSON.stringify({ cmd: 'read fixture ' + round }) },
    { type: 'function_call_output', call_id: 'call_' + round, output: 'FACT verified=Budget_' + round });
    facts.push('Candidate_' + round, 'Budget_' + round);
    const model = round === 1 ? 'gpt-test' : 'LOCAL model';
    const item = checkpoint(await request(f.url, compact(model, input)));
    // Match Codex V2: original assistant/reasoning/tool items are discarded.
    input = [user, item];
    const nextModel = round === 1 ? 'LOCAL model' : 'gpt-test';
    const result = await request(f.url, { model: nextModel, input });
    const restored = JSON.stringify(result.json.output);
    for (const fact of facts) assert.ok(restored.includes(fact), 'round ' + round + ' lost ' + fact);
    const forwarded = (nextModel.startsWith('LOCAL') ? f.local : f.cloud).requests.at(-1).body.input;
    assert.ok(forwarded.every((entry) => entry.type === 'message'));
    if (round === 1) await f.restart();
  }
  const summaryInputs = JSON.stringify([...f.local.requests, ...f.cloud.requests]
    .filter((entry) => entry.summary).map((entry) => entry.body.input));
  assert.ok(summaryInputs.includes('historical_reasoning'));
  assert.ok(!summaryInputs.includes('provider-only-id'));
  assert.ok(!summaryInputs.includes('opaque-provider-secret'));
});

test('long history is consumed in bounded overlapping chunks with truthful summed usage', async (t) => {
  const f = await fixture(t);
  const input = [...history, message('assistant', 'padding '.repeat(6000) + ' FACT end=Final_constraint_Z8')];
  const result = await request(f.url, compact('LOCAL model', input));
  const item = checkpoint(result);
  const calls = f.local.requests.filter((entry) => entry.summary);
  assert.ok(calls.length >= 3);
  assert.equal(result.json.usage.total_tokens, calls.length * 30);
  for (const call of calls) assert.ok(call.body.input[0].content[0].text.length < 18000);
  const restored = await request(f.url, followup('gpt-test', item));
  for (const fact of [...expected, 'Final_constraint_Z8']) assert.ok(JSON.stringify(restored.json.output).includes(fact));
});

test('standalone compaction returns a complete reduced window and accepts JSON backend responses', async (t) => {
  const f = await fixture(t);
  f.local.mode = 'json';
  const result = await request(f.url, { model: 'LOCAL model', input: history }, '/v1/responses/compact');
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.object, 'response.compaction');
  assert.equal(result.json.output.length, 1);
  const restored = await request(f.url, followup('gpt-test', result.json.output[0]));
  for (const fact of expected) assert.ok(JSON.stringify(restored.json.output).includes(fact));
});

test('native cloud checkpoints can be converted by their cloud, never silently dropped locally', async (t) => {
  const f = await fixture(t);
  const native = { type: 'compaction', encrypted_content: 'cloud-owned-opaque-checkpoint' };
  const rejected = await request(f.url, followup('LOCAL model', native));
  assert.equal(rejected.status, 409);
  assert.equal(f.local.requests.length, 0);
  const portable = checkpoint(await request(f.url, compact('gpt-test', [native, ...history])));
  assert.ok(f.cloud.requests.at(-1).body.input.some((entry) => entry.type === 'compaction'));
  const restored = await request(f.url, followup('LOCAL model', portable));
  assert.ok(JSON.stringify(restored.json.output).includes('Cloud_plan_Q9'));
});

for (const mode of ['http-error', 'empty', 'incomplete', 'malformed']) {
  test('failed summary never returns a successful checkpoint: ' + mode, async (t) => {
    const f = await fixture(t);
    f.local.mode = mode;
    const result = await request(f.url, compact('LOCAL model'));
    assert.equal(result.status, 502, result.text);
    assert.ok(!result.text.includes('response.completed'));
    assert.ok(!result.text.includes('codex_router_summary_v1.'));
  });
}

test('tampered checkpoints, missing keys and old placeholders fail without forwarding', async (t) => {
  const f = await fixture(t);
  const item = checkpoint(await request(f.url, compact('LOCAL model')));
  const before = f.local.requests.length + f.cloud.requests.length;
  const bad = { ...item, encrypted_content: item.encrypted_content.slice(0, -8) + 'abcdefgh' };
  for (const model of ['LOCAL model', 'gpt-test']) {
    assert.equal((await request(f.url, followup(model, bad))).status, 409);
    assert.equal((await request(f.url, followup(model, {
      type: 'compaction', encrypted_content: 'router_local_compaction_v1',
    }))).status, 409);
  }
  fs.unlinkSync(path.join(f.dir, 'state', 'summary-key'));
  await f.restart();
  assert.equal((await request(f.url, followup('LOCAL model', item))).status, 409);
  assert.equal(f.local.requests.length + f.cloud.requests.length, before);
});

test('explicit legacy recovery is isolated to one thread and becomes a portable checkpoint', async (t) => {
  const f = await fixture(t);
  const summary = path.join(f.dir, 'recovered.txt');
  const source = path.join(f.dir, 'original.jsonl');
  fs.writeFileSync(summary, 'FACT recovered=Original_decision_R7');
  fs.writeFileSync(source, '{"original":"fixture"}\n');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'recover-legacy.js'),
    '--state-dir', path.join(f.dir, 'state'), '--thread-id', 'thread-recovered',
    '--summary-file', summary, '--source-file', source]);
  const input = [{ type: 'compaction', encrypted_content: 'router_local_compaction_v1' }, ...history];
  const metadata = { thread_id: 'thread-recovered', session_id: 'thread-recovered' };
  for (const model of ['LOCAL model', 'gpt-test']) {
    const r = await request(f.url, { model, input, client_metadata: metadata });
    assert.equal(r.status, 200, r.text);
    assert.ok(JSON.stringify(r.json.output).includes('Original_decision_R7'));
  }
  for (const client_metadata of [{}, { thread_id: 'another-thread' },
    { thread_id: '../thread-recovered' }, { ...metadata, session_id: 'another-thread' }]) {
    assert.equal((await request(f.url, { model: 'LOCAL model', input, client_metadata })).status, 409);
  }
  await f.restart();
  const item = checkpoint(await request(f.url, { ...compact('LOCAL model', input), client_metadata: metadata }));
  const file = path.join(f.dir, 'state', 'legacy-recoveries', 'thread-recovered.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(JSON.parse(fs.readFileSync(file)).source_sha256, /^[a-f0-9]{64}$/);
  fs.unlinkSync(file);
  const restored = await request(f.url, followup('gpt-test', item));
  assert.ok(JSON.stringify(restored.json.output).includes('Original_decision_R7'));
  assert.equal((await request(f.url, { model: 'LOCAL model', input, client_metadata: metadata })).status, 409);
});

test('cloud encrypted reasoning is omitted on a local switch while visible context survives', async (t) => {
  const f = await fixture(t);
  const result = await request(f.url, { model: 'LOCAL model', input: [
    { type: 'reasoning', encrypted_content: 'cloud-only', summary: [] },
    ...history,
  ] });
  assert.equal(result.status, 200);
  assert.ok(f.local.requests.at(-1).body.input.every((item) => item.type !== 'reasoning'));
  assert.ok(JSON.stringify(result.json.output).includes('pytest_17_passed'));
});

test('client disconnect cancels the isolated summary request', async (t) => {
  const f = await fixture(t);
  f.local.mode = 'slow';
  const controller = new AbortController();
  const pending = fetch(f.url + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-only' },
    body: JSON.stringify(compact('LOCAL model')), signal: controller.signal,
  }).catch(() => {});
  for (let i = 0; i < 100 && !f.local.requests.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.local.requests.length, 1);
  controller.abort(); await pending;
  for (let i = 0; i < 100 && !f.local.canceled; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.local.canceled, 1);
});

for (const mode of ['delayed-success', 'delayed-error']) {
  test('long compaction progress remains valid on ' + mode, async (t) => {
    const f = await fixture(t);
    f.local.mode = mode;
    const result = await request(f.url, compact('LOCAL model'));
    assert.ok(result.events.some((event) => event.type === 'response.in_progress'));
    if (mode === 'delayed-success') checkpoint(result);
    else {
      assert.equal(result.status, 200); // Headers were already sent for progress.
      assert.ok(result.events.some((event) => event.type === 'error'));
      assert.ok(!result.events.some((event) => event.type === 'response.completed'));
    }
  });
}
