import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { SpecController } from '../src/server/spec.js';
import { preflight, run as command } from '../src/server/git.js';
import { readReport } from '../src/server/artifacts.js';
import type { ExecuteSpec } from '../src/server/codex.js';
import type { SpecResult } from '../src/shared.js';

export const ready: SpecResult = { outcome: 'READY', summary: 'Проверяемая спецификация', requirements: ['Добавить приветствие'],
  acceptance_criteria: ['Вывод равен hello'], assumptions: [], out_of_scope: ['Публикация'], questions: [] };
function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-spec-')));
  const checkout = join(root, 'repo'), remote = join(root, 'remote.git'), directory = join(root, 'data');
  mkdirSync(checkout);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(checkout, 'README.md'), 'initial'); writeFileSync(join(checkout, '.gitignore'), 'ignored\n');
  git('add', '.'); git('commit', '-m', 'initial'); git('init', '--bare', remote); git('remote', 'add', 'origin', remote); git('push', 'origin', 'main');
  const base = git('rev-parse', 'HEAD');
  const store = new Store(directory);
  const project = store.addProject({ checkout, common_dir: join(checkout, '.git'), remote: 'origin', remote_url: remote,
    hosting: 'github', host: 'github.com', repository: 'test/repo', target_branch: 'main' });
  t.after(() => { if (store.db.open) store.close(); rmSync(root, { recursive: true, force: true }); });
  const queue = () => {
    const task = store.createTask(project.id, 'Добавить hello', store.project(project.id).state_version);
    const run = store.mutate(randomUUID(), randomUUID(), () => store.queueSpec(project.id, task.id, task.state_version, directory));
    return run as ReturnType<Store['queueSpec']>;
  };
  const controller = (execute: ExecuteSpec) => new SpecController(store, directory, () => {}, command, execute);
  return { root, checkout, directory, git, base, store, project, queue, controller };
}

test('preflight rejects staged, unstaged, untracked, merge and rebase; ignored files allowed', async t => {
  const { checkout, project, git } = fixture(t);
  writeFileSync(join(checkout, 'ignored'), 'keep'); await preflight(project);
  writeFileSync(join(checkout, 'README.md'), 'dirty');
  await assert.rejects(preflight(project), /README.md/);
  git('add', 'README.md'); await assert.rejects(preflight(project), /README.md/);
  git('reset', '--hard', 'HEAD');
  writeFileSync(join(checkout, 'odd\nname.txt'), 'keep'); await assert.rejects(preflight(project), /untracked/);
  unlinkSync(join(checkout, 'odd\nname.txt'));
  for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
    const path = join(checkout, '.git', name);
    if (name === 'MERGE_HEAD') writeFileSync(path, git('rev-parse', 'HEAD')); else mkdirSync(path);
    await assert.rejects(preflight(project), /merge\/rebase/); rmSync(path, { recursive: true });
  }
});

test('READY uses fetched remote SHA, immutable config, separate worktree, durable report and restart', async t => {
  const { checkout, directory, git, base, store, project, queue, controller } = fixture(t);
  writeFileSync(join(checkout, 'local-only'), 'not pushed'); git('add', '.'); git('commit', '-m', 'local only');
  const local = git('rev-parse', 'HEAD');
  const config = { ...store.settings(project.id), instructions: 'Use existing patterns' };
  store.mutate('settings', 'settings', () => store.saveSettings(project.id, config, 1));
  const run = queue();
  store.mutate('settings2', 'settings2', () => store.saveSettings(project.id, { ...config, models: { ...config.models, spec: 'different' } }, 2));
  const runner = controller(async input => {
    assert.equal(input.model, config.models.spec); assert.match(input.prompt, /Use existing patterns/);
    assert.match(input.prompt, /AGENTS.md/); assert.match(input.prompt, /Добавить hello/);
    assert.equal(existsSync(join(input.cwd, 'local-only')), false);
    assert.equal(readFileSync(join(input.cwd, 'README.md'), 'utf8'), 'initial');
    return ready;
  });
  runner.enqueue(run); await runner.close();
  const saved = store.specRun(project.id, run.task_id, run.id);
  assert.equal(saved.status, 'completed', saved.error ?? ''); assert.equal(saved.base_sha, base);
  assert.equal(store.task(project.id, run.task_id).stage, 'build');
  assert.equal(git('rev-parse', 'HEAD'), local); assert.equal(git('branch', '--show-current'), 'main');
  assert.match(readReport(directory, run.id), /Вывод равен hello/);
  assert.equal(saved.config.models.spec, config.models.spec);
  store.close(); const restarted = new Store(directory);
  assert.equal(restarted.specRun(project.id, run.task_id, run.id).outcome, 'READY');
  restarted.close();
});

test('failed preflight permits an explicit new attempt without launching Codex', async t => {
  const { checkout, store, project, queue, controller } = fixture(t);
  writeFileSync(join(checkout, 'dirty'), 'keep');
  let calls = 0; const runner = controller(async () => { calls++; return ready; });
  const run = queue(); runner.enqueue(run); await runner.close();
  assert.equal(calls, 0); assert.equal(store.task(project.id, run.task_id).stage, 'backlog');
  assert.equal(store.task(project.id, run.task_id).run_state, 'idle');
  assert.match(store.specRun(project.id, run.task_id, run.id).error!, /dirty/);
});

for (const scenario of ['question', 'invalid', 'source-change', 'event-failure', 'artifact-failure'] as const) test(`Spec ${scenario} blocks Build and keeps evidence`, async t => {
  const { store, project, queue, controller } = fixture(t);
  const run = queue();
  const runner = controller(async input => {
    if (scenario === 'question') return { ...ready, outcome: 'NEEDS_INPUT', questions: ['Какой язык? От ответа зависит интерфейс.'] };
    if (scenario === 'invalid') return { ...ready, acceptance_criteria: [] };
    if (scenario === 'source-change') writeFileSync(join(input.cwd, 'changed'), 'preserve');
    if (scenario === 'event-failure') store.db.exec("CREATE TRIGGER fail_completion BEFORE INSERT ON events WHEN NEW.type = 'spec.completed' BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
    if (scenario === 'artifact-failure') writeFileSync(join(input.directory, 'report.md.tmp'), 'partial');
    return ready;
  });
  runner.enqueue(run); await runner.close();
  const task = store.task(project.id, run.task_id), saved = store.specRun(project.id, run.task_id, run.id);
  assert.equal(task.stage, 'needs-human');
  assert.equal(saved.status, scenario === 'question' ? 'completed' : 'failed');
  assert.equal(task.run_state, scenario === 'question' ? 'waiting' : 'interrupted');
  if (scenario === 'source-change') assert.ok(existsSync(join(run.worktree, 'changed')));
  if (scenario !== 'question') assert.equal(saved.outcome, null);
});

test('three slots, queue retained on shutdown, restart interrupts without launching', async t => {
  const { store, directory, queue, controller } = fixture(t);
  let executing = 0, maximum = 0;
  const releases: (() => void)[] = [];
  let signal!: () => void;
  const entered = new Promise<void>(resolve => { signal = resolve; });
  const runner = controller(async () => {
    executing++; maximum = Math.max(maximum, executing);
    if (executing === 3) signal();
    await new Promise<void>(resolve => releases.push(resolve)); executing--; return ready;
  });
  const runs = Array.from({ length: 4 }, queue); runs.forEach(run => runner.enqueue(run));
  await entered;
  assert.equal(store.runs().filter(run => run.status === 'queued').length, 1);
  const closing = runner.close(); releases.forEach(release => release()); await closing;
  assert.equal(maximum, 3); store.close();
  const restarted = new Store(directory);
  assert.equal(restarted.runs().at(-1)?.status, 'interrupted');
  assert.equal(restarted.snapshot().tasks.at(-1)?.run_state, 'interrupted'); restarted.close();
});

test('artifact reader rejects symlink escape', async t => {
  const { directory, queue, controller } = fixture(t);
  const run = queue(), runner = controller(async () => ready); runner.enqueue(run); await runner.close();
  const report = join(directory, 'artifacts', run.id, 'report.md');
  unlinkSync(report); symlinkSync(join(directory, 'state.sqlite'), report);
  assert.throws(() => readReport(directory, run.id), /небезопасен/);
  assert.throws(() => readReport(directory, '../state.sqlite'), /недоступен/);
});
