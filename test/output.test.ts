import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { formatOutput } from '../src/server/output.js';
import { executeSpec } from '../src/server/codex.js';
import { AgentOutput } from '../src/client/output.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-output-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject({ checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github', host: 'github.com', repository: 'owner/repo', target_branch: 'main' });
  const task = store.createTask(project.id, 'test', 1);
  const run = store.queueSpec(project.id, task.id, 1, directory);
  run.status = 'running'; store.updateRun(run, 'spec', 'running');
  return { directory, store, project, task, run, restart: () => { store.close(); store = new Store(directory); return store; } };
}

test('readable structured results retain fields and redact secrets before presentation', () => {
  const result = formatOutput(JSON.stringify({ outcome: 'NEEDS_INPUT', summary: 'token="very secret value"',
    findings: ['Issue'], checks: ['Test'], applicable: false,
    questions: [{ text: 'Which?', context: 'Here', impact: 'Important', required: true, options: ['A', 'B'] }] }));
  for (const text of ['Результат: NEEDS_INPUT', 'Итог:', '[REDACTED]', 'Замечания: • Issue', 'Проверки: • Test', 'Применимость: Нет', 'Вопрос: Which?', 'Обязательный: Да', '• A']) assert.ok(result.includes(text), text);
  assert.ok(!result.includes('very secret value'));
  assert.ok(!result.includes('"summary"'));
  assert.equal(formatOutput('Looking at the code'), 'Looking at the code');
});

test('latest output replaces messages, survives restart, stays bounded in snapshots and never leaks into retries', t => {
  const { store, run, task, project, restart } = fixture(t);
  assert.equal(store.runs()[0].output_preview, null);
  store.recordOutput(run, 'First');
  const cursor = store.snapshot().cursor;
  const text = 'token="hidden-value" <script>alert(1)</script>' + 'Ж'.repeat(100_000);
  store.recordOutput(run, formatOutput(text));
  const latest = store.runs()[0];
  assert.equal(latest.output_version, 2);
  assert.equal(latest.output_preview?.length, 600);
  assert.ok(latest.output_at);
  assert.ok(store.output(run.id)!.text.length > 100_000);
  assert.ok(!JSON.stringify(store.snapshot()).includes('hidden-value'));
  assert.ok(!store.output(run.id)!.text.includes('hidden-value'));
  assert.deepEqual(store.events(cursor).map(e => JSON.parse(e.payload)), [{ run_id: run.id }]);
  const html = renderToStaticMarkup(createElement(AgentOutput, { run: latest, stage: 'spec', load: async () => store.output(run.id)! }));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Роль: spec'));
  run.status = 'failed'; run.base_sha = 'base'; run.source_hash = 'hash'; run.diagnostic = { execution_finished: true };
  store.updateRun(run, 'needs-human', 'interrupted');
  const retry = store.retryRun(project.id, task.id, store.task(project.id, task.id).state_version);
  assert.equal(retry.output_preview, null);
  store.recordOutput(run, 'Late old message');
  assert.equal(store.runs()[0].output_version, 2);
  const next = restart();
  assert.equal(next.output(run.id)?.version, 2);
  assert.equal(next.runs().at(-1)?.output_preview, null);
});

test('the next role starts with empty output in its immediate response and snapshot', t => {
  const { store, run, task, project } = fixture(t);
  store.recordOutput(run, 'Spec message');
  run.status = 'completed'; run.outcome = 'READY';
  store.updateRun(run, 'build', 'idle');
  const build = store.queueBuild(project.id, task.id, store.task(project.id, task.id).state_version);
  assert.equal(build.output_preview, null);
  assert.equal(build.output_at, null);
  assert.equal(build.output_version, null);
  assert.equal(store.runs().at(-1)?.output_preview, null);
  assert.equal(store.output(run.id)?.text, 'Spec message');
});

test('waiting UI explains absent harness output without implying a hang', t => {
  const { run } = fixture(t);
  const html = renderToStaticMarkup(createElement(AgentOutput, { run, stage: 'spec', load: async () => ({ text: '' }) }));
  assert.match(html, /Ожидаем первое сообщение/);
  assert.match(html, /CLI может не отдавать текст/);
});

test('CLI delivers sequential messages before turn completion and ignores reasoning/tool events', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-output-cli-'));
  const directory = join(root, 'artifacts'); mkdirSync(directory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'codex'), ack = join(root, 'ack');
  const ready = { outcome: 'READY', title: 'Task', summary: 'Done', requirements: ['One'], acceptance_criteria: ['Test'], assumptions: [], out_of_scope: [], questions: [] };
  writeFileSync(cli, `#!${process.execPath}
if (process.argv[2] === '--version') { console.log('codex-cli 1.0'); process.exit(0); }
if (process.argv[2] === 'mcp') { console.log('[]'); process.exit(0); }
const fs = require('node:fs');
const emit = value => console.log(JSON.stringify(value));
process.stdin.resume();
emit({type:'thread.started'}); emit({type:'turn.started'});
emit({type:'item.completed',item:{type:'reasoning',text:'private'}});
emit({type:'item.completed',item:{type:'command_execution',text:'tool'}});
emit({type:'item.completed',item:{type:'agent_message',text:'First'}});
const timer = setInterval(() => {
 if (!fs.existsSync(${JSON.stringify(ack)})) return;
 clearInterval(timer);
 emit({type:'item.completed',item:{type:'agent_message',text:'Second'}});
 emit({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(ready))}}});
 emit({type:'turn.completed'});
}, 10);
setTimeout(() => process.exit(1), 3000).unref();
`, { mode: 0o700 });
  const messages: string[] = [];
  const result = await executeSpec({ cwd: root, directory, model: 'test', prompt: 'test', output: text => {
    messages.push(text);
    if (text === 'First') { assert.equal(existsSync(ack), false); writeFileSync(ack, 'received'); }
  } }, cli);
  assert.deepEqual(result, ready);
  assert.deepEqual(messages, ['First', 'Second', JSON.stringify(ready)]);
});
