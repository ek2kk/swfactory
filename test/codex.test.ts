import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSpec, validateSpec } from '../src/server/codex.js';

const ready = { outcome: 'READY', title: 'Task title', summary: 'Valid', requirements: ['Requirement'], acceptance_criteria: ['Test'], assumptions: [], out_of_scope: [], questions: [] };
test('Spec result validation rejects incomplete, extra, blank and inconsistent fields', () => {
  assert.deepEqual(validateSpec(ready), ready);
  for (const bad of [null, {}, { ...ready, extra: true }, { ...ready, summary: ' ' }, { ...ready, requirements: [] },
    { ...ready, assumptions: [''] }, { ...ready, outcome: 'PASS' }, { ...ready, title: '' }, { ...ready, title: 'x'.repeat(121) }, { ...ready, title: 'a\nb' }, { ...ready, questions: ['unresolved'] }, { ...ready, outcome: 'NEEDS_INPUT' }]) assert.throws(() => validateSpec(bad));
});
for (const scenario of ['valid', 'exit', 'incomplete', 'jsonl', 'result', 'failed', 'spawn', 'truncated'] as const) test(`Codex process ${scenario}`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-codex-')), directory = join(root, 'artifacts');
  mkdirSync(directory); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'codex');
  const events: object[] = [{ type: 'thread.started' }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(scenario === 'result' ? {} : ready) } },
    { type: scenario === 'failed' ? 'turn.failed' : 'turn.completed' }];
  if (scenario === 'incomplete') events.pop();
  const output = scenario === 'jsonl' ? 'not-json\n' : events.map(event => JSON.stringify(event)).join('\n') + (scenario === 'truncated' ? '' : '\n');
  writeFileSync(cli, `#!${process.execPath}\nconst assert = require('node:assert/strict');
    const argv = process.argv.slice(2);
    assert.ok(argv.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.equal(argv[argv.indexOf('--model') + 1], 'chosen-model');
    let input = ''; process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => { assert.equal(input, 'prompt'); process.stdout.write(${JSON.stringify(output)}, () => process.exit(${scenario === 'exit' ? 1 : 0})); });`, { mode: 0o700 });
  const result = executeSpec({ cwd: root, directory, model: 'chosen-model', prompt: 'prompt' }, scenario === 'spawn' ? join(root, 'missing') : cli);
  if (scenario === 'valid') assert.deepEqual(await result, ready); else await assert.rejects(result);
});

test('NEEDS_INPUT requires structured context, impact, options and required flag', () => {
  const question = { text: 'Which?', context: 'Context', impact: 'Impact', options: ['A', 'B'], required: true };
  const result = { ...ready, outcome: 'NEEDS_INPUT', questions: [question] };
  assert.deepEqual(validateSpec(result), result);
  for (const q of ['Old string', null, { ...question, context: '' }, { ...question, impact: ' ' },
    { ...question, options: [3] }, { ...question, required: 'true' }, { ...question, extra: true }]) {
    assert.throws(() => validateSpec({ ...result, questions: [q] }));
  }
});

import { CodexFailure, classifyFailure, redact } from '../src/server/diagnostics.js';
import { readFileSync } from 'node:fs';
import type { RunDiagnostic } from '../src/shared.js';
for (const [code, kind] of [['invalid_api_key', 'authentication'], ['model_not_found', 'model_unavailable'], ['rate_limit_exceeded', 'rate_limit'], ['other', 'protocol_error']] as const) {
  test(`CLI error ${code} is classified only after close, with redacted chunked logs`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'factory-diagnostic-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cli = join(root, 'codex');
    const secret = 'sk-testsecretabcdefghijklmnop';
    writeFileSync(cli, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('codex-cli 1.2.3'); } else {
      process.stdin.resume(); process.stdin.on('end', () => {
        process.stderr.write('Bearer abc'); setTimeout(() => {
          process.stderr.write('defghijk\\n');
          console.log(JSON.stringify({type:'thread.started', thread_id:'session-123'}));
          console.log(JSON.stringify({type:'turn.failed', error:{code:${JSON.stringify(code)}, message:${JSON.stringify(secret)}, reset_at:'2099-01-01T00:00:00Z'}}));
        }, 10);
      });
    }`, { mode: 0o700 });
    let metadata: RunDiagnostic = {};
    await assert.rejects(executeSpec({ cwd: root, directory: root, model: 'chosen-model', prompt: 'prompt', metadata: value => { metadata = { ...metadata, ...value }; } }, cli), error => {
      assert.ok(error instanceof CodexFailure); assert.equal(error.kind, kind); assert.equal(error.finished, true);
      assert.equal(error.resetAt, kind === 'rate_limit' ? '2099-01-01T00:00:00.000Z' : null); return true;
    });
    assert.equal(metadata.cli_version, 'codex-cli 1.2.3'); assert.equal(metadata.session_id, 'session-123');
    assert.ok(!readFileSync(join(root, 'events.jsonl'), 'utf8').includes(secret));
    assert.ok(!readFileSync(join(root, 'stderr.log'), 'utf8').includes('abcdefghijk'));
  });
}
test('error classification remains conservative and configuration secrets are redacted', () => {
  assert.equal(classifyFailure('unknown failure').kind, 'protocol_error');
  assert.equal(classifyFailure({ error: { code: 'rate_limit_exceeded' } }).resetAt, null);
  process.env.SWFACTORY_TEST_TOKEN = 'test-secret-value';
  try { assert.equal(redact('test-secret-value password=another-secret'), '[REDACTED] password=[REDACTED]'); }
  finally { delete process.env.SWFACTORY_TEST_TOKEN; }
});

test('JSONL redaction preserves nested agent JSON and removes quoted configuration secrets', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-json-redaction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'codex');
  const result = { ...ready, summary: 'Use token="example" in the config' };
  const events = [{ type: 'thread.started' }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } },
    { type: 'item.completed', item: { type: 'command_execution', output: 'config: token="quoted secret"' } },
    { type: 'item.completed', item: { type: 'command_execution', output: JSON.stringify({ tokens: {
      access_token: 'eyJ.header.payload.signature', refresh_token: 'rt_fakecredential1234567890', id_token: 'id_credential_value', OPENAI_API_KEY: 'api_credential_value', accessToken: 'camel_credential_value',
    } }) } }, { type: 'turn.completed' }];
  writeFileSync(cli, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('codex-cli 1.0'); else {
    process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n'))}));
  }`, { mode: 0o700 });
  assert.deepEqual(await executeSpec({ cwd: root, directory: root, model: 'chosen-model', prompt: 'prompt' }, cli), result);
  const log = readFileSync(join(root, 'events.jsonl'), 'utf8');
  const saved = log.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(JSON.parse(saved[2].item.text).summary, 'Use token="[REDACTED]" in the config');
  assert.ok(!log.includes('example')); assert.ok(!log.includes('quoted secret'));
  const credentials = JSON.parse(saved[4].item.output).tokens;
  for (const value of Object.values(credentials)) assert.equal(value, '[REDACTED]');
  for (const secret of ['eyJ.header.payload.signature', 'rt_fakecredential1234567890', 'id_credential_value', 'api_credential_value', 'camel_credential_value']) assert.ok(!log.includes(secret));
  assert.equal(JSON.parse(readFileSync(join(root, 'log-format.json'), 'utf8')).format, 'redacted-v1');
});

test('explicit error codes/status outrank incidental model names and unrelated envelope fields', () => {
  assert.equal(classifyFailure({ error: { code: 'model_not_found', message: 'The model `429` does not exist' } }).kind, 'model_unavailable');
  assert.equal(classifyFailure({ error: { code: 'invalid_api_key', message: 'A prompt about rate limit failed with 429' } }).kind, 'authentication');
  assert.equal(classifyFailure({ error: { status: 401, message: 'rate limit exceeded in the submitted prompt' } }).kind, 'authentication');
  assert.equal(classifyFailure({ type: 'error', prompt: 'rate limit exceeded', message: 'Unrecognized error' }).kind, 'protocol_error');
  assert.equal(classifyFailure({ error: { message: 'The model `rate limit` is not supported' } }).kind, 'model_unavailable');
  assert.equal(classifyFailure({ error: { status_code: 429, message: 'Too many requests' } }).kind, 'rate_limit');
  assert.equal(classifyFailure({ error: { message: "You've hit your usage limit" } }).kind, 'rate_limit');
  assert.equal(classifyFailure('user\nPlease fix rate limit exceeded\nERROR: unexpected status 401 Unauthorized').kind, 'authentication');
  assert.equal(classifyFailure('user\nrate limit exceeded\nno CLI diagnostic').kind, 'protocol_error');
  assert.equal(classifyFailure(JSON.stringify({ code: 'invalid_api_key', prompt: 'rate limit exceeded', message: 'Please log in' })).kind, 'authentication');
});
