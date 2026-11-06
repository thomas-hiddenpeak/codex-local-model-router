'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { fixture } = require('./router-fixture');

function client(binary, home) {
  const proc = spawn(binary, ['app-server', '--stdio'], {
    env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'test-only',
      OPENAI_BASE_URL: '', OTEL_SDK_DISABLED: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 0;
  let stderr = '';
  const pending = new Map();
  const notifications = [];
  const watchers = new Set();
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (value.id !== undefined && pending.has(value.id)) {
      const { resolve, reject, timer } = pending.get(value.id);
      pending.delete(value.id); clearTimeout(timer);
      if (value.error) reject(new Error(JSON.stringify(value.error))); else resolve(value.result);
    } else if (value.method) {
      notifications.push(value);
      for (const fn of watchers) fn();
    }
  });
  proc.on('exit', () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer); reject(new Error('Isolated app-server exited: ' + stderr));
    }
  });
  return {
    notifications,
    async call(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id); reject(new Error(method + ' timed out: ' + stderr.slice(-3000)));
        }, 20000);
        pending.set(id, { resolve, reject, timer });
        proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    notify(method) { proc.stdin.write(JSON.stringify({ method }) + '\n'); },
    wait(method, predicate, after = 0) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          watchers.delete(check);
          reject(new Error(method + ' not received. Notifications: ' +
            JSON.stringify(notifications.slice(after).map((entry) => ({ method: entry.method,
              ...(entry.method === 'error' ? { params: entry.params } : {}) }))) + '\n' + stderr.slice(-3000)));
        }, 20000);
        const check = () => {
          const found = notifications.slice(after).find((entry) => entry.method === method && predicate(entry.params));
          if (found) { clearTimeout(timer); watchers.delete(check); resolve(found.params); }
        };
        watchers.add(check); check();
      });
    },
    async close() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const ended = once(proc, 'exit');
      proc.stdin.end();
      const timer = setTimeout(() => proc.kill('SIGTERM'), 2000);
      await ended; clearTimeout(timer);
    },
  };
}

test('installed Codex compacts, switches both models, and resumes portable context', {
  skip: !process.env.CODEX_TEST_BINARY,
  timeout: 90000,
}, async (t) => {
  let cli;
  t.after(async () => { if (cli) await cli.close(); });
  const f = await fixture(t);
  const home = path.join(f.dir, 'codex-home');
  fs.mkdirSync(home);
  const models = ['LOCAL model', 'gpt-test'].map((slug) => ({
    slug, display_name: slug, description: 'Isolated test fixture',
    default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'test' }],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1,
    support_verbosity: false, supports_reasoning_summary_parameter: false, default_reasoning_summary: 'none',
    supports_reasoning_effort_updates: false, use_responses_lite: false,
    context_window: 262144, auto_compact_token_limit: 212992,
    input_modalities: ['text'], tool_mode: 'direct', experimental_supported_tools: [],
    truncation_policy: { mode: 'tokens', limit: 10000 },
    model_messages: { instructions_template: 'Follow the test prompt. Use only declared tools.' },
  }));
  fs.writeFileSync(path.join(home, 'catalog.json'), JSON.stringify({ models }));
  const writeConfig = () => fs.writeFileSync(path.join(home, 'config.toml'), [
    'model = "LOCAL model"', 'model_provider = "openai"',
    'openai_base_url = ' + JSON.stringify(f.url + '/v1'),
    'model_catalog_json = ' + JSON.stringify(path.join(home, 'catalog.json')),
    // The backend is a fixed localhost fixture; its only tool command is printf.
    'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
    '[analytics]', 'enabled = false',
  ].join('\n'));
  writeConfig();
  cli = client(process.env.CODEX_TEST_BINARY, home);
  async function initialize() {
    await cli.call('initialize', { clientInfo: { name: 'router_isolated_test', version: '1.0' },
      capabilities: { experimentalApi: true } });
    cli.notify('initialized');
  }
  await initialize();
  const started = await cli.call('thread/start', {
    model: 'LOCAL model', modelProvider: 'openai', cwd: f.dir, approvalPolicy: 'never', sandbox: 'danger-full-access',
    baseInstructions: 'Follow the user test. Only run the harmless printf fixture when requested.',
  });
  const threadId = started.thread.id;
  async function turn(model, text) {
    const cursor = cli.notifications.length;
    const result = await cli.call('turn/start', { threadId, model,
      input: [{ type: 'text', text }], effort: 'low' });
    const done = await cli.wait('turn/completed', (p) => p.turn.id === result.turn.id, cursor);
    assert.equal(done.turn.status, 'completed', JSON.stringify(done));
  }
  async function compactThread() {
    const cursor = cli.notifications.length;
    await cli.call('thread/compact/start', { threadId });
    await cli.wait('item/completed', (p) => p.threadId === threadId && p.item.type === 'contextCompaction', cursor);
    const done = await cli.wait('turn/completed', (p) => p.threadId === threadId, cursor);
    assert.equal(done.turn.status, 'completed', JSON.stringify(done));
  }
  f.local.normalExtras = 'FACT assistant=Patch_committed_A1';
  f.local.normalReasoning = 'FACT reasoning=Preserve_local_decision_Q2';
  f.local.callTool = true;
  await turn('LOCAL model', 'FACT goal=Implement_delta_paginator FACT constraint=Do_not_modify_live_service');
  const command = cli.notifications.find((entry) => entry.method === 'item/completed' && entry.params.item.type === 'commandExecution');
  assert.equal(command?.params.item.exitCode, 0, JSON.stringify(command));
  const reasoning = cli.notifications.find((entry) => entry.method === 'item/completed' && entry.params.item.type === 'reasoning');
  assert.ok(reasoning?.params.item.summary[0].startsWith('**思考过程**\n\n'));
  assert.ok(reasoning.params.item.summary[0].includes('Preserve_local_decision_Q2'));
  assert.deepEqual(reasoning.params.item.content, []);
  assert.ok(cli.notifications.some((entry) => entry.method === 'item/reasoning/summaryTextDelta'));
  assert.ok(!cli.notifications.some((entry) => entry.method === 'item/reasoning/textDelta'));
  const toolResult = f.local.requests.at(-1).body.input.find((item) => item.type === 'function_call_output' && item.call_id === 'call_fixture');
  assert.ok(JSON.stringify(toolResult?.output).includes('Fixture_tool_output_T4'));
  f.local.normalExtras = '';
  f.local.normalReasoning = '';
  await compactThread();
  const firstSummary = JSON.stringify(f.local.requests.find((entry) => entry.summary).body.input);
  assert.ok(firstSummary.includes('Patch_committed_A1'));
  assert.ok(firstSummary.includes('Fixture_tool_output_T4'));
  assert.ok(firstSummary.includes('Preserve_local_decision_Q2'));
  await turn('gpt-test', 'Recall previous facts and continue.');
  const cloudInput = JSON.stringify(f.cloud.requests.at(-1).body.input);
  assert.ok(cloudInput.includes('Patch_committed_A1'));
  assert.ok(cloudInput.includes('Fixture_tool_output_T4'));
  assert.ok(!f.cloud.requests.at(-1).body.input.some((item) => ['function_call', 'function_call_output'].includes(item.type)));
  await compactThread();
  await cli.close();
  await f.restart();
  writeConfig();
  cli = client(process.env.CODEX_TEST_BINARY, home);
  await initialize();
  await cli.call('thread/resume', { threadId, cwd: f.dir });
  await turn('LOCAL model', 'Recall all previous facts after resume.');
  const restored = JSON.stringify(f.local.requests.at(-1).body.input);
  for (const fact of ['Implement_delta_paginator', 'Do_not_modify_live_service',
    'Patch_committed_A1', 'Fixture_tool_output_T4', 'Preserve_local_decision_Q2']) assert.ok(restored.includes(fact), fact);
  assert.ok(!f.local.requests.at(-1).body.input.some((item) => item.type === 'compaction'));

  // Verify the real CLI reports the cause after progress headers were sent.
  f.local.mode = 'delayed-error';
  const cursor = cli.notifications.length;
  await cli.call('thread/compact/start', { threadId });
  const failure = await cli.wait('error', (p) => p.threadId === threadId &&
    /Summary backend returned HTTP 503/.test((p.error?.message || '') + (p.error?.additionalDetails || '')), cursor);
  assert.ok(!JSON.stringify(failure.error).includes('stream closed before response.completed'));
});
