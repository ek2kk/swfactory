import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/server/store.js';
import { SpecController } from '../src/server/spec.js';
import { sourceHash, commitBuild } from '../src/server/build.js';
import { run as command } from '../src/server/git.js';
import { validateBuild, type ExecuteBuild } from '../src/server/codex.js';
import type { BuildResult, SpecResult } from '../src/shared.js';

const spec: SpecResult = { title: 'Hello', outcome: 'READY', summary: 'Implement hello', requirements: ['Say hello'], acceptance_criteria: ['README says hello'], assumptions: [], out_of_scope: [], questions: [] };
const ready: BuildResult = { outcome: 'READY', summary: 'Implemented', changed_paths: ['README.md'], actions: ['Edited README'], checks: ['Read README: hello'], questions: [] };
async function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-build-'))), checkout = join(root, 'repo'), directory = join(root, 'data');
  mkdirSync(checkout);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(checkout, 'init', '-b', 'main'); git(checkout, 'config', 'user.name', 'Test'); git(checkout, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(checkout, 'README.md'), 'initial'); git(checkout, 'add', '--', 'README.md'); git(checkout, 'commit', '-m', 'initial');
  const remote = join(root, 'remote.git'); git(checkout, 'clone', '--bare', checkout, remote); git(checkout, 'remote', 'add', 'origin', remote);
  const store = new Store(directory);
  t.after(() => { if (store.db.open) store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = store.addProject({ checkout, common_dir: join(checkout, '.git'), remote: 'origin', remote_url: remote, hosting: 'github', host: 'github.com', repository: 'test/repo', target_branch: 'main' });
  const config = store.settings(project.id); config.models.build = 'selected-build'; config.reasoning_efforts = { build: 'high' }; config.instructions = 'Keep it simple';
  store.saveSettings(project.id, config, 1);
  const task = store.createTask(project.id, 'Say hello', 2);
  const initial = store.queueSpec(project.id, task.id, 1, directory);
  const specRunner = new SpecController(store, directory, () => {}, command, async () => spec);
  specRunner.enqueue(initial); await specRunner.close();
  const queue = () => store.queueBuild(project.id, task.id, store.task(project.id, task.id).state_version);
  const controller = (execute: ExecuteBuild) => new SpecController(store, directory, () => {}, command, undefined, undefined, execute);
  return { root, checkout, directory, store, project, task, initial, git, queue, controller };
}

for (const failure of ['artifact', 'event', 'secret', 'changed', 'missing', 'restart'] as const) test(`Build backend recovery ${failure} reuses result without calling the agent`, async t => {
  const { store, directory, project, task, git, queue, controller } = await fixture(t);
  const run = queue();
  const runner = controller(async input => {
    writeFileSync(join(input.cwd, 'README.md'), failure === 'secret' ? 'ghp_' + 'a'.repeat(36) : 'hello');
    if (failure === 'event') store.db.exec("CREATE TRIGGER fail_completion BEFORE INSERT ON events WHEN NEW.type = 'build.completed' BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
    else if (failure !== 'secret') writeFileSync(join(input.directory, 'report.md.tmp'), 'partial');
    return ready;
  });
  runner.enqueue(run); await runner.close();
  let active = store;
  const failed = store.specRun(project.id, task.id, run.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.diagnostic?.result_saved, true);
  assert.equal(failed.diagnostic?.execution_finished, true);
  assert.ok(failed.source_hash);
  if (failure === 'event') store.db.exec('DROP TRIGGER fail_completion');
  if (failure === 'changed') writeFileSync(join(run.worktree, 'README.md'), 'changed after failure');
  if (failure === 'missing') rmSync(join(directory, 'artifacts', run.id, 'agent-result.json'));
  if (failure === 'restart') { store.close(); active = new Store(directory); t.after(() => active.close()); }
  const retry = active.retryRun(project.id, task.id, active.task(project.id, task.id).state_version);
  assert.equal(retry.diagnostic?.result_run_id, run.id);
  const continuation = new SpecController(active, directory, () => {}, command, undefined, undefined, async () => { assert.fail('agent must not run again'); });
  continuation.enqueue(retry); await continuation.close();
  const blocked = ['secret', 'changed', 'missing'].includes(failure);
  const saved = active.specRun(project.id, task.id, retry.id);
  assert.equal(saved.status, blocked ? 'failed' : 'completed', saved.error ?? '');
  assert.equal(active.task(project.id, task.id).stage, blocked ? 'needs-human' : 'review');
  assert.equal(active.specRun(project.id, task.id, run.id).status, 'failed');
  if (!blocked) assert.equal(git(run.worktree, 'rev-list', '--count', `${run.base_sha}..HEAD`), '1');
});

test('Build schema rejects incomplete, extra, inconsistent and duplicate fields', () => {
  assert.deepEqual(validateBuild(ready), ready);
  for (const bad of [null, {}, { ...ready, extra: true }, { ...ready, changed_paths: [] }, { ...ready, changed_paths: ['a', 'a'] },
    { ...ready, checks: [] }, { ...ready, summary: ' ' }, { ...ready, outcome: 'NEEDS_INPUT' }, { ...ready, outcome: 'PASS' }]) assert.throws(() => validateBuild(bad));
});

for (const scenario of ['edit', 'committed', 'committed-plus-edit', 'token-expressions', 'committed-token-expressions', 'literal-path', 'delete'] as const) test(`Build READY ${scenario}: exact commit, clean tree, immutable context and durable SHA`, async t => {
  const { store, project, task, initial, checkout, directory, git, queue, controller } = await fixture(t);
  const run = queue();
  assert.throws(queue, /Spec/);
  writeFileSync(join(checkout, 'user-work'), 'untouched');
  const runner = controller(async input => {
    assert.equal(input.model, 'selected-build'); assert.equal(input.reasoningEffort, 'high'); assert.match(input.prompt, /Keep it simple/); assert.match(input.prompt, /README says hello/); assert.match(input.prompt, /AGENTS.md/);
    assert.match(input.prompt, /Mode: initial/); assert.doesNotMatch(input.prompt, /Repair the existing implementation/);
    writeFileSync(join(input.cwd, 'README.md'), 'hello');
    if (scenario.endsWith('token-expressions')) writeFileSync(join(input.cwd, 'README.md'), [
      "const token = randomBytes(32).toString('hex');",
      'payload: { token: result.token }',
      'const password = options.password;',
      'const secret = process.env.SECRET;',
      'const api_key = settings.api_key;',
    ].join('\n'));
    if (scenario.startsWith('committed')) { git(input.cwd, 'add', '--', 'README.md'); git(input.cwd, 'commit', '-m', 'builder'); }
    if (scenario === 'committed-plus-edit') writeFileSync(join(input.cwd, 'README.md'), 'hello again');
    if (scenario === 'delete') rmSync(join(input.cwd, 'README.md'));
    if (scenario === 'literal-path') { writeFileSync(join(input.cwd, ':literal name'), 'hello'); return { ...ready, changed_paths: ['README.md', ':literal name'] }; }
    return ready;
  });
  runner.enqueue(run); await runner.close();
  const saved = store.specRun(project.id, task.id, run.id);
  assert.equal(saved.status, 'completed', saved.error ?? ''); assert.equal(saved.outcome, 'READY');
  assert.equal(store.task(project.id, task.id).stage, 'review');
  assert.equal(saved.base_sha, initial.base_sha); assert.equal(saved.head_sha, git(run.worktree, 'rev-parse', 'HEAD'));
  assert.equal(git(run.worktree, 'status', '--porcelain'), '');
  assert.equal(git(run.worktree, 'rev-list', '--count', `${run.base_sha}..HEAD`), scenario === 'committed-plus-edit' ? '2' : '1');
  assert.equal(readFileSync(join(checkout, 'README.md'), 'utf8'), 'initial'); assert.equal(readFileSync(join(checkout, 'user-work'), 'utf8'), 'untouched');
  assert.match(readFileSync(join(directory, 'artifacts', run.id, 'report.md'), 'utf8'), /Read README/);
  store.close(); const restarted = new Store(directory);
  assert.equal(restarted.specRun(project.id, task.id, run.id).head_sha, saved.head_sha); restarted.close();
});

for (const scenario of ['unexpected', 'secret', 'secret-content', 'symlink', 'staged-secret', 'hidden-committed-secret', 'branch', 'hidden-index', 'reverted-commits', 'merge', 'no-change', 'blocked', 'invalid', 'event-failure', 'artifact-failure'] as const) test(`Build ${scenario} never reaches Review and preserves evidence`, async t => {
  const { store, project, task, queue, controller, git } = await fixture(t);
  const run = queue();
  const runner = controller(async input => {
    if (scenario !== 'no-change') writeFileSync(join(input.cwd, 'README.md'), 'hello');
    if (scenario === 'unexpected') writeFileSync(join(input.cwd, 'surprise'), 'keep');
    if (scenario === 'secret' || scenario === 'staged-secret') {
      writeFileSync(join(input.cwd, '.env'), 'TOKEN=private-value');
      if (scenario === 'staged-secret') git(input.cwd, 'add', '--', '.env');
      return { ...ready, changed_paths: ['README.md', '.env'] };
    }
    if (scenario === 'secret-content') writeFileSync(join(input.cwd, 'README.md'), 'ghp_' + 'a'.repeat(36));
    if (scenario === 'symlink') { symlinkSync('/etc/passwd', join(input.cwd, 'link')); return { ...ready, changed_paths: ['README.md', 'link'] }; }
    if (scenario === 'hidden-committed-secret') {
      writeFileSync(join(input.cwd, '.env'), 'TOKEN=private-value'); git(input.cwd, 'add', '--', '.env'); git(input.cwd, 'commit', '-m', 'secret');
      git(input.cwd, 'rm', '--', '.env'); git(input.cwd, 'commit', '-m', 'remove');
      return { ...ready, changed_paths: ['README.md', '.env'] };
    }
    if (scenario === 'hidden-index') git(input.cwd, 'update-index', '--assume-unchanged', 'README.md');
    if (scenario === 'reverted-commits') {
      git(input.cwd, 'add', '--', 'README.md'); git(input.cwd, 'commit', '-m', 'edit');
      git(input.cwd, 'revert', '--no-edit', 'HEAD');
    }
    if (scenario === 'merge') {
      git(input.cwd, 'add', '--', 'README.md'); git(input.cwd, 'commit', '-m', 'edit');
      git(input.cwd, 'checkout', '-b', 'side', run.base_sha!);
      writeFileSync(join(input.cwd, 'side.txt'), 'side'); git(input.cwd, 'add', '--', 'side.txt'); git(input.cwd, 'commit', '-m', 'side');
      git(input.cwd, 'checkout', run.branch); git(input.cwd, 'merge', '--no-edit', 'side');
      return { ...ready, changed_paths: ['README.md', 'side.txt'] };
    }
    if (scenario === 'branch') git(input.cwd, 'checkout', '-b', 'unexpected');
    if (scenario === 'blocked') return { ...ready, outcome: 'BLOCKED' };
    if (scenario === 'invalid') return { ...ready, checks: [] };
    if (scenario === 'event-failure') store.db.exec("CREATE TRIGGER fail BEFORE INSERT ON events WHEN NEW.type = 'build.completed' BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
    if (scenario === 'artifact-failure') writeFileSync(join(input.directory, 'report.md.tmp'), 'partial');
    return ready;
  });
  runner.enqueue(run); await runner.close();
  const saved = store.specRun(project.id, task.id, run.id);
  assert.equal(store.task(project.id, task.id).stage, 'needs-human'); assert.equal(store.task(project.id, task.id).run_state, 'interrupted');
  assert.equal(saved.outcome, scenario === 'blocked' ? 'BLOCKED' : null);
  if (scenario !== 'no-change') assert.ok(readFileSync(join(run.worktree, 'README.md'), 'utf8'));
  if (scenario === 'secret') assert.equal(git(run.worktree, 'diff', '--cached', '--name-only'), '');
});

for (const scenario of ['answer', 'changed', 'leading-changed', 'restart', 'merge', 'rebase'] as const) test(`Build question ${scenario}: preserves partial edits, answers and role`, async t => {
  const { store, directory, project, task, git, queue, controller } = await fixture(t);
  const run = queue();
  const runner = controller(async input => {
    writeFileSync(join(input.cwd, 'README.md'), 'partial');
    if (scenario === 'leading-changed') writeFileSync(join(input.cwd, ' leading.txt'), 'before');
    return { ...ready, outcome: 'NEEDS_INPUT', questions: [{ text: 'Greeting?', context: 'Text', impact: 'Output', options: ['hello'], required: true }] };
  });
  runner.enqueue(run); await runner.close();
  const request = store.humanRequests().at(-1)!;
  assert.equal(request.role, 'build');
  if (scenario === 'restart') {
    store.close(); const restarted = new Store(directory);
    assert.equal(restarted.task(project.id, task.id).run_state, 'waiting');
    const next = restarted.answer(project.id, task.id, request.id, restarted.task(project.id, task.id).state_version, ['hello']).run;
    assert.equal(next.role, 'build'); assert.equal(next.worktree, run.worktree);
    assert.equal(readFileSync(join(next.worktree, 'README.md'), 'utf8'), 'partial');
    assert.equal(restarted.task(project.id, task.id).run_state, 'queued'); restarted.close(); return;
  }
  const next = store.answer(project.id, task.id, request.id, store.task(project.id, task.id).state_version, ['hello']).run!;
  assert.equal(next.role, 'build'); assert.equal(next.worktree, run.worktree);
  if (scenario === 'leading-changed') writeFileSync(join(run.worktree, ' leading.txt'), 'after!');
  if (scenario === 'changed') writeFileSync(join(run.worktree, 'README.md'), 'human changed');
  if (scenario === 'merge') writeFileSync(git(run.worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'), `${run.base_sha}\n`);
  if (scenario === 'rebase') mkdirSync(git(run.worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge'));
  let calls = 0;
  const continuation = controller(async input => { calls++; assert.match(input.prompt, /Greeting/); assert.match(input.prompt, /hello/); assert.equal(readFileSync(join(input.cwd, 'README.md'), 'utf8'), 'partial'); writeFileSync(join(input.cwd, 'README.md'), 'hello'); return ready; });
  continuation.enqueue(next); await continuation.close();
  const blocked = scenario !== 'answer';
  assert.equal(calls, blocked ? 0 : 1);
  assert.equal(store.task(project.id, task.id).stage, blocked ? 'needs-human' : 'review');
  if (scenario === 'merge' || scenario === 'rebase') {
    assert.match(store.specRun(project.id, task.id, next.id).error!, /merge\/rebase/);
    assert.equal(readFileSync(join(run.worktree, 'README.md'), 'utf8'), 'partial');
  }
});

test('new Spec automatically queues Build and skips reviewers for text-only changes', async t => {
  const { store, project, directory, controller } = await fixture(t);
  const task = store.createTask(project.id, 'Automatic pipeline', 2);
  const run = store.queueSpec(project.id, task.id, 1, directory);
  const runner = new SpecController(store, directory, () => {}, command, async () => spec, undefined, async input => {
    writeFileSync(join(input.cwd, 'README.md'), 'hello'); return ready;
  }, async () => { throw new Error('No review for text'); }, async () => ({ outcome: 'APPROVE', summary: 'Text approved', risks: [], affected_paths: ['README.md'], questions: [] }));
  runner.enqueue(run);
  try {
    for (let i = 0; i < 1000 && store.task(project.id, task.id).run_state !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.task(project.id, task.id).stage, 'approve');
    assert.equal(store.runs().filter(r => r.task_id === task.id && r.role === 'build').length, 1);
  } finally { await runner.close(); }
});

test('failed automatic Build queue rolls back Spec completion and never launches Build', async t => {
  const { store, project, directory } = await fixture(t);
  const task = store.createTask(project.id, 'Automatic pipeline', 2);
  const run = store.queueSpec(project.id, task.id, 1, directory);
  store.db.exec("CREATE TRIGGER fail_auto BEFORE INSERT ON events WHEN NEW.type = 'build.queued' BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
  let calls = 0;
  const runner = new SpecController(store, directory, () => {}, command, async () => spec, undefined, async () => { calls++; return ready; });
  runner.enqueue(run);
  try {
    for (let i = 0; i < 1000 && store.task(project.id, task.id).stage !== 'needs-human'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.task(project.id, task.id).stage, 'needs-human');
    assert.equal(store.specRun(project.id, task.id, run.id).status, 'failed');
    assert.equal(store.runs().filter(r => r.task_id === task.id && r.role === 'build').length, 0);
    assert.equal(calls, 0);
  } finally { await runner.close(); }
  store.db.exec('DROP TRIGGER fail_auto');
  const retry = store.retryRun(project.id, task.id, store.task(project.id, task.id).state_version);
  const continuation = new SpecController(store, directory, () => {}, command, async () => { assert.fail('Spec must not run again'); });
  continuation.enqueue(retry); await continuation.close();
  assert.equal(store.specRun(project.id, task.id, retry.id).status, 'completed');
  assert.equal(store.task(project.id, task.id).stage, 'build');
});

test('sourceHash includes the content of the first NUL-separated path with leading space', async t => {
  const { queue } = await fixture(t);
  const run = queue(), path = join(run.worktree, ' leading.txt');
  writeFileSync(path, 'before');
  const before = await sourceHash(run);
  writeFileSync(path, 'after!');
  assert.notEqual(await sourceHash(run), before);
});

for (const [label, path, content] of [
  ['leading-space', ' leading.txt', 'hello'],
  ['600-KiB', 'large.txt', 'a'.repeat(600 * 1024)],
  ['2-MiB', 'large.txt', 'a'.repeat(2 * 1024 * 1024)],
  ['binary-1-MiB', 'binary.bin', Buffer.alloc(1024 * 1024, 255)],
  ['binary-2-MiB', 'binary.bin', Buffer.alloc(2 * 1024 * 1024, 255)],
] as const) for (const committed of [false, true]) test(`Build READY ${label}, builder commit=${committed}`, async t => {
  const { store, project, task, queue, controller, git } = await fixture(t);
  const run = queue();
  const runner = controller(async input => {
    writeFileSync(join(input.cwd, path), content);
    if (committed) { git(input.cwd, 'add', '--', path); git(input.cwd, 'commit', '-m', 'builder'); }
    return { ...ready, changed_paths: [path] };
  });
  runner.enqueue(run); await runner.close();
  const saved = store.specRun(project.id, task.id, run.id);
  assert.equal(saved.outcome, 'READY', saved.error ?? '');
  assert.equal(store.task(project.id, task.id).stage, 'review');
  assert.equal(git(run.worktree, 'status', '--porcelain'), '');
  assert.equal(git(run.worktree, 'rev-list', '--count', `${run.base_sha}..HEAD`), '1');
  assert.equal(git(run.worktree, 'rev-parse', `HEAD:${path}`), git(run.worktree, 'hash-object', '--', path));
});

test('Git blob output exceeding 2 MiB of raw bytes is rejected', async t => {
  const { queue, git } = await fixture(t);
  const run = queue();
  writeFileSync(join(run.worktree, 'oversized.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 255));
  const blob = git(run.worktree, 'hash-object', '-w', '--', 'oversized.bin');
  await assert.rejects(command('git', ['show', blob], run.worktree), /Команда git show не выполнена/);
});

test('initial Build rejects unfinished merge with unchanged HEAD and clean status', async t => {
  const { store, project, task, initial, git, queue, controller } = await fixture(t);
  const run = queue();
  git(initial.worktree, 'checkout', '-b', 'merge-other');
  git(initial.worktree, 'commit', '--allow-empty', '-m', 'other');
  git(initial.worktree, 'checkout', initial.branch);
  git(initial.worktree, 'merge', '--no-commit', '--no-ff', 'merge-other');
  assert.equal(git(initial.worktree, 'status', '--porcelain'), '');
  assert.equal(git(initial.worktree, 'rev-parse', 'HEAD'), initial.base_sha);
  let calls = 0;
  const runner = controller(async () => { calls++; return ready; });
  runner.enqueue(run); await runner.close();
  const saved = store.specRun(project.id, task.id, run.id);
  assert.equal(saved.status, 'failed'); assert.match(saved.error!, /merge\/rebase/);
  assert.equal(calls, 0);
  assert.ok(git(initial.worktree, 'rev-parse', '--verify', 'MERGE_HEAD'));
});

for (const target of ['README.md', '../outside', '/etc/passwd', 'missing', '.git/config']) test(`source symlink ${target}: internal files only`, async t => {
  const { initial, git, root } = await fixture(t);
  writeFileSync(join(root, 'outside'), 'external');
  symlinkSync(target, join(initial.worktree, 'CLAUDE.md'));
  if (target !== 'README.md') {
    await assert.rejects(sourceHash(initial), /symlink|Symlink|путь/);
    return;
  }
  git(initial.worktree, 'add', 'CLAUDE.md'); git(initial.worktree, 'commit', '-m', 'existing instructions link');
  initial.base_sha = git(initial.worktree, 'rev-parse', 'HEAD');
  const before = await sourceHash(initial);
  writeFileSync(join(initial.worktree, 'README.md'), 'updated');
  assert.notEqual(await sourceHash(initial), before);
  const head = await commitBuild(initial, ready);
  assert.equal(head, git(initial.worktree, 'rev-parse', 'HEAD'));
  assert.equal(git(initial.worktree, 'status', '--porcelain'), '');
  assert.equal(git(initial.worktree, 'ls-tree', 'HEAD', 'CLAUDE.md').slice(0, 6), '120000');
  rmSync(join(initial.worktree, 'CLAUDE.md')); symlinkSync('./README.md', join(initial.worktree, 'CLAUDE.md'));
  await assert.rejects(commitBuild(initial, { ...ready, changed_paths: ['README.md', 'CLAUDE.md'] }), /symlink/);
});
