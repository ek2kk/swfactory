import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSpec } from '../src/server/codex.js';
import { CodexFailure } from '../src/server/diagnostics.js';
import { DeliveryError, type Steer } from '../src/server/interactive.js';
import type { RunDiagnostic } from '../src/shared.js';
const ready = { outcome: 'READY', title: 'Smoke', summary: 'Confirmed', requirements: ['One'], acceptance_criteria: ['Test'], assumptions: [], out_of_scope: [], questions: [] };
for (const scenario of ['success', 'reject', 'lost', 'invalid-result', 'auth', 'rate-limit', 'server-request'] as const) test(`app-server ${scenario}: handshake, policy, steer binding, lifecycle and redaction`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-interactive-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = join(directory, 'codex');
  writeFileSync(cli, `#!${process.execPath}
const assert = require('node:assert/strict');
if (process.argv[2] === '--version') { console.log('codex-cli 0.160.1'); process.exit(0); }
assert.equal(process.argv[2], 'app-server');
assert.deepEqual(process.argv.slice(2), ['app-server', '--listen', 'stdio://']);
const send = data => console.log(JSON.stringify(data));
const reply = (id, result) => send({ id, result });
const event = (method, params) => send({ method, params: { threadId: 'thread-1', ...params } });
let initialized = false;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line);
 if (r.method === 'initialize') { initialized = true; reply(r.id, {}); }
 if (r.method === 'thread/start') {
   assert.ok(initialized); assert.equal(r.params.model, 'test-model'); assert.equal(r.params.approvalPolicy, 'never'); assert.equal(r.params.sandbox, 'danger-full-access');
   assert.equal(r.params.developerInstructions, undefined);
   if (${JSON.stringify(scenario)} === 'auth') { send({id:r.id,error:{code:'invalid_api_key'}}); return; }
   reply(r.id, {thread:{id:'thread-1'}});
 }
 if (r.method === 'turn/start') {
   assert.ok(r.params.outputSchema); assert.equal(r.params.input[0].text, 'prompt');
   reply(r.id, {turn:{id:'turn-1'}}); event('turn/started', {turn:{id:'turn-1'}});
 }
 if (r.method === 'turn/steer') {
   assert.equal(r.params.expectedTurnId, 'turn-1'); assert.equal(r.params.threadId, 'thread-1'); assert.equal(r.params.clientUserMessageId, 'message-1');
   if (${JSON.stringify(scenario)} === 'lost') { process.exit(1); }
   if (${JSON.stringify(scenario)} === 'reject') send({id:r.id,error:{code:-32600,message:'No active turn'}});
   else reply(r.id, {turnId:'turn-1'});
   setTimeout(() => {
     if (${JSON.stringify(scenario)} === 'server-request') { send({id:99,method:'item/commandExecution/requestApproval',params:{}}); return; }
     if (${JSON.stringify(scenario)} === 'rate-limit') { event('turn/completed',{turn:{id:'turn-1',status:'failed',error:{code:'rate_limit_exceeded',reset_at:'2099-01-01T00:00:00Z'}}}); return; }
     event('item/agentMessage/delta',{delta:'partial secret'});
     event('item/completed',{item:{type:'commandExecution',command:'echo ok',aggregatedOutput:'token="hidden-value"'}});
     event('item/completed',{item:{type:'agentMessage',text:JSON.stringify(${scenario === 'invalid-result' ? '{}' : JSON.stringify(ready)})}});
     event('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:10,outputTokens:20,cachedInputTokens:3}}});
     event('turn/completed',{turn:{id:'turn-1',status:'completed'}});
   }, 10);
 }
});
`, { mode: 0o700 });
  let active: Steer | null = null, delivery: Promise<unknown> | undefined;
  let metadata: RunDiagnostic = {};
  const execution = executeSpec({ directory, cwd: directory, model: 'test-model', prompt: 'prompt',
    metadata: value => { metadata = { ...metadata, ...value }; },
    control: steer => { active = steer; if (steer) delivery = steer('message-1', 'Guidance').then(() => 'delivered', error => error); },
  }, cli);
  if (['success', 'reject'].includes(scenario)) assert.deepEqual(await execution, ready);
  else await assert.rejects(execution, error => {
    assert.ok(error instanceof CodexFailure); assert.equal(error.finished, true);
    assert.equal(error.kind, scenario === 'auth' ? 'authentication' : scenario === 'rate-limit' ? 'rate_limit' : 'protocol_error'); return true;
  });
  assert.equal(active, null);
  if (scenario === 'reject' || scenario === 'lost') {
    const error = await delivery; assert.ok(error instanceof DeliveryError); assert.equal(error.status, scenario === 'reject' ? 'failed' : 'unknown');
  } else if (scenario !== 'auth') assert.equal(await delivery, 'delivered');
  const log = readFileSync(join(directory, 'events.jsonl'), 'utf8');
  assert.ok(!log.includes('hidden-value')); assert.ok(!log.includes('partial secret'));
  if (scenario === 'success') assert.deepEqual(metadata.usage, { input_tokens: 10, output_tokens: 20, cached_input_tokens: 3 });
});
