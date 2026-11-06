#!/usr/bin/env node
'use strict';

// Explicit operator recovery only. Native cloud ciphertext is never decrypted;
// its plaintext history must be reconstructed and reviewed from the source file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const args = process.argv.slice(2);
const values = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--state-dir', '--thread-id', '--summary-file', '--source-file', '--native-checkpoint-file'].includes(args[i]) || !args[i + 1]) {
    throw new Error('Usage: recover-legacy.js --state-dir DIR --thread-id ID --summary-file FILE --source-file ORIGINAL_TRANSCRIPT [--native-checkpoint-file JSON]');
  }
  values[args[i]] = args[i + 1];
}
for (const name of ['--state-dir', '--thread-id', '--summary-file', '--source-file']) {
  if (!values[name]) throw new Error('Missing ' + name);
}
const thread = values['--thread-id'];
if (!/^[A-Za-z0-9_-]{1,128}$/.test(thread)) throw new Error('Invalid thread ID');
const summary = fs.readFileSync(values['--summary-file'], 'utf8').trim();
if (!summary || Buffer.byteLength(summary) > 32 * 1024) throw new Error('Summary must contain 1..32768 bytes');
const sourceSha = crypto.createHash('sha256').update(fs.readFileSync(values['--source-file'])).digest('hex');
let nativeSha;
if (values['--native-checkpoint-file']) {
  const native = JSON.parse(fs.readFileSync(values['--native-checkpoint-file'], 'utf8'));
  if (native.type !== 'compaction' || typeof native.encrypted_content !== 'string' || !native.encrypted_content ||
      native.encrypted_content === 'router_local_compaction_v1' || native.encrypted_content.startsWith('codex_router_summary_v1.')) {
    throw new Error('Expected a native cloud compaction item');
  }
  nativeSha = crypto.createHash('sha256').update(native.encrypted_content).digest('hex');
}
const state = path.resolve(values['--state-dir']);
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
const keyFile = path.join(state, 'summary-key');
try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
catch (err) { if (err.code !== 'EEXIST') throw err; }
const key = fs.readFileSync(keyFile);
if (key.length !== 32) throw new Error('Invalid existing summary key');
const prefix = 'codex_router_summary_v1.';
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
cipher.setAAD(Buffer.from(prefix));
const encrypted = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(JSON.stringify({
  version: 1, summary, model: 'operator-recovered-transcript',
})))), cipher.final()]);
const checkpoint = prefix + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
const dir = path.join(state, nativeSha ? 'native-recoveries' : 'legacy-recoveries');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, thread + '.json');
fs.writeFileSync(file, JSON.stringify({ version: 1, thread_id: thread,
  source_sha256: sourceSha, ...(nativeSha ? { native_checkpoint_sha256: nativeSha } : {}),
  recovered_at: new Date().toISOString(), checkpoint,
}) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ thread_id: thread, recovery_file: file, source_sha256: sourceSha }));
