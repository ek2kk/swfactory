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
