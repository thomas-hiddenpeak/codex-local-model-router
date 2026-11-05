'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');

const root = path.join(__dirname, '..');
const workRoot = path.join(root, '.q3x-work');

function message(role, text) {
  return { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] };
}

function facts(text) {
  return [...new Set(text.match(/FACT\s+[\w]+=[\w./:-]+/g) || [])];
}

function output(text, status = 'completed') {
  return {
    id: 'resp_' + randomUUID(), object: 'response', status,
    output: [{ ...message('assistant', text), id: 'msg_' + randomUUID(), status: 'completed' }],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  };
}

function sse(res, response, contentType = 'text/event-stream') {
  const item = response.output[0];
  if (item.type === 'function_call') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    res.end(); return;
  }
  const events = [
    { type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0,
      delta: item.content[0].text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0,
      text: item.content[0].text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: response.status === 'completed' ? 'response.completed' : 'response.incomplete', response },
  ];
  const wire = Buffer.from(events.map((event) => 'event: ' + event.type + '\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n').join(''));
  res.writeHead(200, contentType ? { 'content-type': contentType } : {});
  // Exercise UTF-8 decoding and SSE framing across arbitrary network boundaries.
  for (let i = 0; i < wire.length; i += 37) res.write(wire.subarray(i, i + 37));
  res.end();
}

async function backend(name) {
  const state = { name, requests: [], mode: 'ok', canceled: 0, normalExtras: '', callTool: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks));
      const summary = body.instructions?.startsWith('Create a factual continuation summary');
      state.requests.push({ body, headers: req.headers, summary });
      if (!summary && state.callTool) {
        state.callTool = false;
        sse(res, { ...output(''), output: [{
          type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'exec_command',
          arguments: JSON.stringify({ cmd: "printf 'FACT tool=Fixture_tool_output_T4\\n'", max_output_tokens: 100 }),
        }] });
        return;
      }
      if (summary && state.mode === 'slow') {
        res.on('close', () => state.canceled++);
        return;
      }
      if (summary && state.mode.startsWith('delayed-')) {
        const timer = setTimeout(() => {
          if (state.mode === 'delayed-success') sse(res, output('FACT delayed=Persisted_fact_D8'));
          else { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); }
        }, 11000);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      if (summary && state.mode === 'http-error') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"test overload"}}'); return;
      }
      if (summary && state.mode === 'malformed') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: not-json\n\n'); return;
      }
      const nativeFact = body.input?.some((item) => item.type === 'compaction') ? ' FACT native=Cloud_plan_Q9' : '';
      const text = summary && state.mode === 'empty' ? '' :
        facts(JSON.stringify(body.input) + nativeFact + (summary ? '' : state.normalExtras)).join('\n') || 'Ready';
      const result = output(text, summary && state.mode === 'incomplete' ? 'incomplete' : 'completed');
      if (summary && (state.mode === 'budget-always' ||
          (['budget-once', 'json-budget-once'].includes(state.mode) && body.max_output_tokens < 16384))) {
        result.status = 'incomplete';
        result.incomplete_details = { reason: 'max_output_tokens' };
      }
      if (summary && ['json', 'json-budget-once'].includes(state.mode)) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
      } else sse(res, result, summary && state.mode === 'missing-content-type' ? null :
        summary && state.mode === 'wrong-content-type' ? 'application/json' : 'text/event-stream');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  state.close = async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
  return state;
}

async function runRouter(dir, local, cloud) {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const source = installer.match(/<<'ROUTER_JS_EOF'\n([\s\S]*?)\nROUTER_JS_EOF/)[1]
    .replaceAll('__MODEL_MATCH__', 'LOCAL')
    .replaceAll('__VLLM_URL__', local.url)
    .replaceAll('__CHATGPT_TARGET__', cloud.url);
  const file = path.join(dir, 'router.js');
  fs.writeFileSync(file, source);
  const proc = spawn(process.execPath, [file], {
    env: { ...process.env, CODEX_ROUTER_PORT: '0', CODEX_ROUTER_STATE_DIR: path.join(dir, 'state'),
      CODEX_ROUTER_DUMP: '', CODEX_ROUTER_LOG: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stderr.on('data', (chunk) => { log += chunk; });
  proc.on('exit', (code) => { if (code) process.stderr.write(log); });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Router startup timed out: ' + log)); }, 10000);
    proc.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error('Router exited ' + code + ': ' + log)); });
  });
  return { proc, url, async stop() {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = once(proc, 'exit'); proc.kill('SIGTERM'); await exited;
  } };
}

async function fixture(t) {
  fs.mkdirSync(workRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(workRoot, 'router-test-'));
  const local = await backend('local');
  const cloud = await backend('cloud');
  let router = await runRouter(dir, local, cloud);
  const value = { dir, local, cloud, get url() { return router.url; },
    async restart() { await router.stop(); router = await runRouter(dir, local, cloud); },
  };
  t.after(async () => {
    await router.stop(); await local.close(); await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return value;
}

async function request(url, body, route = '/v1/responses') {
  const res = await fetch(url + route, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-only' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text.split(/\r?\n/).filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()));
  const json = events.length ? events.find((event) => event.type === 'response.completed')?.response : JSON.parse(text);
  return { status: res.status, text, events, json };
}

module.exports = { fixture, request, message, facts, output, sse, workRoot };
