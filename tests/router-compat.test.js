'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const zlib = require('node:zlib');

// Exercise the exact router shipped by the installer without running the
// installer, reading login credentials, opening sockets, or contacting a model.
const installer = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
const match = installer.match(/<<'ROUTER_JS_EOF'\n([\s\S]*?)\nROUTER_JS_EOF/);
assert.ok(match, 'installer must contain the router heredoc');
const source = match[1]
  .replaceAll('__MODEL_MATCH__', 'LOCAL')
  .replaceAll('__VLLM_URL__', 'http://local.invalid/v1')
  .replaceAll('__CHATGPT_TARGET__', 'https://cloud.invalid/backend-api/codex');

function send(body, headers = {}) {
  let handleRequest;
  let forwarded;
  const transport = {
    createServer(handler) {
      handleRequest = handler;
      return { on() {}, listen() {} };
    },
    request(url, options) {
      forwarded = { url: String(url), headers: options.headers, chunks: [] };
      return {
        on() {},
        write(chunk) { forwarded.chunks.push(chunk); },
        end() {},
      };
    },
  };
  vm.runInNewContext(source, {
    require(name) {
      return name === 'http' || name === 'https' ? transport : require(name);
    },
    process: { env: {} }, Buffer, console, __dirname,
  });
  const req = new EventEmitter();
  Object.assign(req, {
    method: 'POST', url: '/v1/responses',
    headers: { authorization: 'Bearer test-only', ...headers },
  });
  handleRequest(req, {});
  req.emit('data', body);
  req.emit('end');
  assert.ok(forwarded, 'request must reach a backend');
  forwarded.body = Buffer.concat(forwarded.chunks);
  return forwarded;
}

const currentRequest = {
  model: 'LOCAL model',
  input: '中文请求',
  stream: true,
  include: ['reasoning.encrypted_content', 'output.encrypted_content'],
};

test('Codex selectors pass through compressed requests to local vLLM', async (t) => {
  const raw = Buffer.from(JSON.stringify(currentRequest));
  for (const [encoding, encode] of [
    ['identity', (body) => body],
    ['zstd', zlib.zstdCompressSync],
    ['gzip', zlib.gzipSync],
    ['brotli', zlib.brotliCompressSync],
    ['deflate', zlib.deflateSync],
  ]) {
    await t.test(encoding, () => {
      // Codex may omit content-encoding even for compressed bodies.
      const actual = send(encode(raw));
      assert.equal(actual.url, 'http://local.invalid/v1/responses');
      assert.deepEqual(JSON.parse(actual.body), {
        ...currentRequest, include: ['reasoning.encrypted_content'],
      });
      assert.equal(actual.headers.authorization, undefined);
      assert.equal(Number(actual.headers['content-length']), actual.body.length);
    });
  }
});

test('cloud requests retain both selectors and client authentication', () => {
  const raw = Buffer.from(JSON.stringify({ ...currentRequest, model: 'gpt-test' }));
  const actual = send(raw);
  assert.equal(actual.url, 'https://cloud.invalid/backend-api/codex/responses');
  assert.deepEqual(actual.body, raw);
  assert.equal(actual.headers.authorization, 'Bearer test-only');
});

test('only the unsupported selector is removed, including duplicate occurrences', () => {
  const include = ['message.output_text.logprobs', 'output.encrypted_content',
    'reasoning.encrypted_content', 'output.encrypted_content', 'future.selector'];
  const actual = send(Buffer.from(JSON.stringify({ ...currentRequest, include })), {
    'content-encoding': 'gzip', 'content-length': '1',
  });
  assert.deepEqual(JSON.parse(actual.body).include, [
    'message.output_text.logprobs', 'reasoning.encrypted_content', 'future.selector',
  ]);
  assert.equal(actual.headers['content-encoding'], undefined);
  assert.equal(Number(actual.headers['content-length']), actual.body.length);
});

test('older requests and absent, empty, or null includes remain byte-identical', () => {
  for (const include of [undefined, [], null, ['reasoning.encrypted_content']]) {
    const raw = Buffer.from(JSON.stringify({ ...currentRequest, include }, null, 2));
    assert.deepEqual(send(raw).body, raw);
  }
});
