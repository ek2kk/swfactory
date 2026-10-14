import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/server/store.js';
import { SpecController } from '../src/server/spec.js';
import { run as command } from '../src/server/git.js';
import { classifySpec, validateDecision } from '../src/server/specDecision.js';
import type { AgentRun, BuildResult, SpecMode, SpecResult } from '../src/shared.js';

const ready: BuildResult = { outcome: 'READY', summary: 'Greeting changed', changed_paths: ['README.md'], actions: ['Edited README'], checks: ['Read README'], questions: [] };
const spec: SpecResult = { title: 'Greeting', outcome: 'READY', summary: 'Greeting', requirements: ['Say hello'], acceptance_criteria: ['README says hello'], assumptions: [], out_of_scope: [], questions: [] };
const description = 'Change README greeting to Hello. Only README is in scope; verify the exact text.';
function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-optional-spec-'))), checkout = join(root, 'repo'), directory = join(root, 'data');
  mkdirSync(checkout);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(checkout, 'README.md'), 'initial'); git('add', 'README.md'); git('commit', '-m', 'initial');
  const remote = join(root, 'remote.git'); git('clone', '--bare', checkout, remote); git('remote', 'add', 'origin', remote);
  const store = new Store(directory);
  t.after(() => { if (store.db.open) store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = store.addProject({ checkout, common_dir: join(checkout, '.git'), remote: 'origin', remote_url: remote, hosting: 'github', host: 'github.com', repository: 'test/repo', target_branch: 'main' });
  const task = store.createTask(project.id, description, 1);
  store.db.prepare("UPDATE tasks SET title = 'Greeting', title_state = 'completed' WHERE id = ?").run(task.id);
  const current = () => store.task(project.id, task.id);
  return { store, project, task, current, directory };
}

for (const mode of ['skip', 'auto', 'spec'] as SpecMode[]) test(`${mode}: versioned input, review/approve gates and restart`, async t => {
  const { store, project, task, current, directory } = fixture(t);
  store.db.prepare("UPDATE tasks SET title = NULL, title_state = 'pending' WHERE id = ?").run(task.id);
  let classifications = 0, specifications = 0, reviews = 0, titles = 0;
  const controller = () => new SpecController(store, directory, () => {}, command,
    async () => { specifications++; return spec; }, async () => { titles++; return 'Greeting'; },
    async input => {
      assert.match(input.prompt, /NEEDS_INPUT/);
      if (mode !== 'spec') { assert.match(input.prompt, /"source":"requirements"/); assert.match(input.prompt, /"description_revision":1/); }
      writeFileSync(join(input.cwd, 'README.md'), 'Hello'); return ready;
    }, async input => {
      assert.match(input.prompt, mode === 'spec' ? /README says hello/ : /"source":"requirements"/);
      const needsRepair = mode === 'skip' && ++reviews === 1;
      const section = { summary: 'Checked', findings: needsRepair ? ['Adjust greeting'] : [], evidence: ['Read README diff'] };
      return { outcome: needsRepair ? 'CHANGES' : 'PASS', ...section, applicable: true, applicability: '', questions: [],
        ...(input.reviewRole === 'review-ui-ux' ? { ui: section, ux: section } : {}) };
    }, async input => {
      assert.match(input.prompt, mode === 'spec' ? /README says hello/ : /"source":"requirements"/);
      return { outcome: 'APPROVE', summary: 'Publish', risks: [], affected_paths: ['README.md'], questions: [] };
    }, async () => { classifications++; return { required: false, reason: 'Результат, границы и проверка определены.', missing: [] }; });
  async function perform(run: AgentRun) { const runner = controller(); runner.enqueue(run); await runner.close(); assert.equal(store.specRun(project.id, task.id, run.id).status, 'completed'); }
  const initial = store.queueSpec(project.id, task.id, current().state_version, directory, mode);
  await perform(initial);
  if (mode === 'spec') await perform(store.queueBuild(project.id, task.id, current().state_version));
  assert.equal(specifications, mode === 'spec' ? 1 : 0);
  assert.equal(classifications, mode === 'auto' ? 1 : 0);
  assert.equal(current().stage, 'review');
  const build = store.runs().at(-1)!;
  assert.equal(build.spec_run_id, mode === 'spec' ? initial.id : null);
  assert.throws(() => store.queueApprove(project.id, task.id, current().state_version));
  await perform(store.queueReview(project.id, task.id, current().state_version));
  assert.equal(reviews, 0);
  const approved = store.publicationRun(project.id, task.id);
  assert.equal(current().title, 'Greeting');
  assert.equal(current().title_state, 'completed');
  assert.equal(titles, mode === 'spec' ? 0 : 1);
  const verifier = controller(); await verifier.verifyReviewSource(approved); await verifier.close();
  assert.equal(current().spec_decision?.required, mode === 'spec');
  const decision = current().spec_decision;
  store.close();
  const reopened = new Store(directory); t.after(() => reopened.close());
  assert.deepEqual(reopened.task(project.id, task.id).spec_decision, decision);
  assert.equal(reopened.task(project.id, task.id).title, 'Greeting');
  assert.equal(reopened.task(project.id, task.id).title_state, 'completed');
  assert.equal(reopened.publicationRun(project.id, task.id).id, approved.id);
  assert.equal(reopened.runs().filter(r => r.role === 'spec').length, mode === 'spec' ? 1 : 0);
  const recheck = new SpecController(reopened, directory, () => {}, command);
  await recheck.verifyReviewSource(approved);
  reopened.db.prepare('UPDATE tasks SET revision = revision + 1 WHERE id = ?').run(task.id);
  assert.throws(() => reopened.publicationRun(project.id, task.id));
  await assert.rejects(recheck.verifyReviewSource(approved), /требований/);
  await recheck.close();
});

test('Auto ambiguity requires Spec; changed requirements invalidate the saved decision', async t => {
  const { store, project, task, current, directory } = fixture(t);
  let calls = 0;
  const runner = new SpecController(store, directory, () => {}, command, async () => spec, undefined,
    async () => { assert.fail('must not build'); }, undefined, undefined,
    async () => { calls++; return { required: true, reason: 'Не выбран способ авторизации.', missing: ['Способ авторизации'] }; });
  const run = store.queueSpec(project.id, task.id, current().state_version, directory, 'auto');
  runner.enqueue(run); await runner.close();
  assert.equal(store.runs()[0].role, 'spec'); assert.equal(current().stage, 'build');
  assert.equal(calls, 1); assert.deepEqual(current().spec_decision?.missing, ['Способ авторизации']);
  store.editTask(project.id, task.id, 'New requirements', current().state_version);
  const next = store.queueSpec(project.id, task.id, current().state_version, directory, 'auto');
  assert.equal(next.description_revision, 2); assert.equal(current().spec_decision?.required, null);
});

test('Direct Build asks for missing decisions and continues without Spec or reclassification', async t => {
  const { store, project, task, current, directory } = fixture(t);
  const runner = new SpecController(store, directory, () => {}, command, async () => { assert.fail('no Spec'); }, undefined,
    async input => {
      assert.match(input.prompt, /Skipping Spec never authorizes inventing requirements/);
      return { ...ready, outcome: 'NEEDS_INPUT', changed_paths: [], questions: [{ text: 'Which greeting?', context: 'Two choices', impact: 'Output', options: ['Hello', 'Hi'], required: true }] };
    });
  runner.enqueue(store.queueSpec(project.id, task.id, current().state_version, directory, 'skip')); await runner.close();
  assert.equal(current().run_state, 'waiting');
  const request = store.humanRequests()[0];
  const { run: continuation } = store.answer(project.id, task.id, request.id, current().state_version, ['Hello']);
  assert.equal(continuation.role, 'build'); assert.equal(continuation.spec_run_id, null);
  const builder = new SpecController(store, directory, () => {}, command, undefined, undefined, async input => {
    assert.match(input.prompt, /Hello/); writeFileSync(join(input.cwd, 'README.md'), 'Hello'); return ready;
  });
  builder.enqueue(continuation); await builder.close();
  assert.equal(current().stage, 'review'); assert.equal(store.runs().filter(r => r.role === 'spec').length, 0);
});

test('Classifier validates structured reasons and bounds large input without a model call', async () => {
  for (const value of [null, {}, { required: false, reason: 'ok', missing: ['decision'] }, { required: true, reason: '', missing: [] },
    { required: true, reason: 'ok', missing: [], extra: 1 }]) assert.throws(() => validateDecision(value));
  assert.equal((await classifySpec('x'.repeat(24_001), 'unused', new AbortController().signal)).required, true);
});

test('Classifier uses one isolated tool-free call with the configured model', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-classifier-'));
  const capture = join(root, 'capture.json');
  writeFileSync(join(root, 'codex'), `#!${process.execPath}
const fs = require('fs'); let prompt = '';
process.stdin.on('data', x => prompt += x); process.stdin.on('end', () => {
 fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }));
 fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify({required:false,reason:'Определено',missing:[]}));
});`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = `${root}:${previous}`;
  t.after(() => { process.env.PATH = previous; rmSync(root, { recursive: true, force: true }); });
  assert.equal((await classifySpec(description, 'selected-spec-model', new AbortController().signal)).required, false);
  const captureResult = JSON.parse(readFileSync(capture, 'utf8'));
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'features.shell_tool=false', 'features.multi_agent=false', 'project_doc_max_bytes=0', 'selected-spec-model']) assert.ok(captureResult.args.includes(flag), flag);
  assert.match(captureResult.prompt, /Do not write a specification/);
  assert.notEqual(captureResult.cwd, process.cwd());
});

for (const mode of ['skip', 'auto'] as const) for (const titleState of ['pending', 'running'] as const) test(`fast start ${mode} with ${titleState} title completes the title before Build`, async t => {
  const { store, project, task, current, directory } = fixture(t);
  store.db.prepare("UPDATE tasks SET title = NULL, title_state = 'pending' WHERE id = ?").run(task.id);
  let calls = 0, interrupted = false;
  let started!: () => void;
  const titleStarted = new Promise<void>(resolve => { started = resolve; });
  const runner = new SpecController(store, directory, () => {}, command, async () => { assert.fail('no Spec'); },
    async (_description, signal) => {
      calls++;
      if (titleState === 'running' && calls === 1) {
        started();
        return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => { interrupted = true; reject(new Error('aborted')); }, { once: true }));
      }
      return 'Update README greeting';
    }, async input => {
      assert.equal(current().title, 'Update README greeting');
      assert.equal(current().title_state, 'completed');
      writeFileSync(join(input.cwd, 'README.md'), 'Hello'); return ready;
    }, undefined, undefined, async () => ({ required: false, reason: 'Concrete requirements', missing: [] }));
  if (titleState === 'running') { runner.titles.kick(); await titleStarted; }
  const enqueue = runner.enqueue.bind(runner);
  t.mock.method(runner, 'enqueue', (run: AgentRun) => { if (!run.parent_run_id) enqueue(run); });
  const run = store.queueSpec(project.id, task.id, current().state_version, directory, mode);
  runner.enqueue(run);
  for (let i = 0; i < 1000 && ['queued', 'running'].includes(store.specRun(project.id, task.id, run.id).status); i++) await new Promise(resolve => setTimeout(resolve, 10));
  await runner.close();
  assert.equal(current().title, 'Update README greeting');
  assert.equal(current().title_state, 'completed');
  assert.equal(current().stage, 'approve');
  if (titleState === 'running') assert.equal(interrupted, true);
  assert.equal(store.runs().filter(r => r.role === 'spec').length, 0);
});

for (const failure of ['error', 'invalid'] as const) test(`direct Build title ${failure} blocks implementation without changing source`, async t => {
  const { store, project, task, current, directory } = fixture(t);
  store.db.prepare("UPDATE tasks SET title = NULL, title_state = 'pending' WHERE id = ?").run(task.id);
  const runner = new SpecController(store, directory, () => {}, command, undefined,
    async () => { if (failure === 'error') throw new Error('title unavailable'); return ''; },
    async () => { assert.fail('must not implement without a valid title'); });
  const run = store.queueSpec(project.id, task.id, current().state_version, directory, 'skip');
  runner.enqueue(run); await runner.close();
  assert.equal(store.specRun(project.id, task.id, run.id).status, 'failed');
  assert.equal(current().title, null); assert.equal(current().title_state, 'failed');
  assert.equal(current().stage, 'needs-human');
  assert.equal(readFileSync(join(run.worktree, 'README.md'), 'utf8'), 'initial');
});
