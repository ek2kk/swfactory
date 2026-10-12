import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { SpecController } from '../src/server/spec.js';
import { preflight, run as command } from '../src/server/git.js';
import { readReport } from '../src/server/artifacts.js';
import type { ExecuteSpec } from '../src/server/codex.js';
import type { SpecResult } from '../src/shared.js';

export const ready: SpecResult = { outcome: 'READY', title: 'Task title', summary: 'Проверяемая спецификация', requirements: ['Добавить приветствие'],
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

for (const scenario of ['question', 'invalid', 'source-change', 'event-failure', 'title-event-failure', 'human-event-failure', 'artifact-failure'] as const) test(`Spec ${scenario} blocks Build and keeps evidence`, async t => {
  const { store, project, queue, controller } = fixture(t);
  const run = queue();
  const runner = controller(async input => {
    if (scenario === 'question') return { ...ready, outcome: 'NEEDS_INPUT', questions: [{ text: 'Какой язык?', context: 'Интерфейс', impact: 'Локализация', options: ['Русский', 'English'], required: true }] };
    if (scenario === 'invalid') return { ...ready, acceptance_criteria: [] };
    if (scenario === 'source-change') writeFileSync(join(input.cwd, 'changed'), 'preserve');
    if (scenario === 'event-failure') store.db.exec("CREATE TRIGGER fail_completion BEFORE INSERT ON events WHEN NEW.type = 'spec.completed' BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
    if (scenario === 'title-event-failure') store.db.exec("CREATE TRIGGER fail_title BEFORE INSERT ON events WHEN NEW.type = 'title.completed' BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
    if (scenario === 'human-event-failure') {
      store.db.exec("CREATE TRIGGER fail_human BEFORE INSERT ON events WHEN NEW.type = 'human.requested' BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
      return needsInput;
    }
    if (scenario === 'artifact-failure') writeFileSync(join(input.directory, 'report.md.tmp'), 'partial');
    return ready;
  });
  runner.enqueue(run); await runner.close();
  const task = store.task(project.id, run.task_id), saved = store.specRun(project.id, run.task_id, run.id);
  assert.equal(task.stage, 'needs-human');
  assert.equal(saved.status, scenario === 'question' ? 'completed' : 'failed');
  assert.equal(task.run_state, scenario === 'question' ? 'waiting' : 'interrupted');
  if (scenario === 'source-change') assert.ok(existsSync(join(run.worktree, 'changed')));
  if (scenario !== 'question') { assert.equal(store.humanRequests().length, 0); assert.equal(saved.outcome, null); assert.equal(task.title, null); }
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

test('Title and Spec share three FIFO slots, await abort and save fallback title atomically', { timeout: 10000 }, async t => {
  const { store, project, directory } = fixture(t);
  const active = new Set<string>();
  let maximum = 0;
  const enter = (description: string) => {
    assert.equal(active.has(description), false, 'Title and Spec must never overlap for the same task');
    active.add(description); maximum = Math.max(maximum, active.size);
  };
  const titleCalls = new Map<string, { signal: AbortSignal; finish: () => void }>();
  const specCalls: { description: string; finish: () => void }[] = [];
  const runner = new SpecController(store, directory, () => {}, command, async input => {
    const description = input.prompt.split('Task description:\n')[1];
    enter(description);
    await new Promise<void>(resolve => specCalls.push({ description, finish: resolve }));
    active.delete(description);
    return description === 'e' ? { ...ready, outcome: 'NEEDS_INPUT', questions: [{ text: 'Which format?', context: 'Export', impact: 'File type', options: ['CSV'], required: true }] } : ready;
  }, async (description, signal) => {
    enter(description);
    await new Promise<void>(resolve => titleCalls.set(description, { signal, finish: resolve }));
    active.delete(description);
    if (signal.aborted) throw new Error('confirmed stopped');
    return `${description} title`;
  }, async () => ({ outcome: 'BLOCKED', summary: 'Spec scheduler test stops here', changed_paths: [], actions: [], checks: [], questions: [] }));
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 1000 && !predicate(); i++) await delay(5);
    assert.ok(predicate(), 'Expected scheduler progress');
  }
  const create = (description: string) => store.createTask(project.id, description, 1);
  const start = (task: ReturnType<typeof create>) => {
    const run = store.mutate(randomUUID(), task.id, () => store.queueSpec(project.id, task.id, task.state_version, directory)) as ReturnType<Store['queueSpec']>;
    runner.enqueue(run); return run;
  };
  try {
    const a = create('a'); create('b'); create('c');
    runner.titles.kick();
    assert.equal(titleCalls.size, 3);
    const d = create('d'), e = create('e');
    store.db.prepare("UPDATE tasks SET title = 'Existing title', title_state = 'completed' WHERE id = ?").run(e.id);
    start(d); start(e); start(a);
    assert.equal(titleCalls.get('a')!.signal.aborted, true);
    await delay(20);
    assert.equal(specCalls.length, 0, 'An abort request alone must not free the slot');
    titleCalls.get('a')!.finish(); await until(() => specCalls.length === 1);
    assert.equal(specCalls[0].description, 'd');
    titleCalls.get('b')!.finish(); await until(() => specCalls.length === 2);
    titleCalls.get('c')!.finish(); await until(() => specCalls.length === 3);
    assert.deepEqual(specCalls.map(call => call.description), ['d', 'e', 'a']);
    const f = create('f'); runner.titles.kick();
    assert.equal(titleCalls.has('f'), false);
    specCalls[1].finish(); await until(() => titleCalls.has('f'));
    assert.equal(store.task(project.id, e.id).run_state, 'waiting');
    assert.equal(store.task(project.id, e.id).title, 'Existing title');
    titleCalls.get('f')!.finish(); specCalls[0].finish(); specCalls[2].finish();
    await until(() => store.runs().some(run => run.task_id === a.id && run.role === 'spec' && run.status === 'completed') && store.runs().some(run => run.task_id === d.id && run.role === 'spec' && run.status === 'completed') && store.task(project.id, f.id).title !== null);
    assert.equal(store.task(project.id, a.id).title, ready.title);
    assert.equal(store.task(project.id, d.id).title, ready.title);
    assert.equal(maximum, 3);
  } finally {
    const closing = runner.close();
    for (const call of titleCalls.values()) call.finish();
    for (const call of specCalls) call.finish();
    await closing;
  }
});

const needsInput: SpecResult = { ...ready, outcome: 'NEEDS_INPUT', questions: [
  { text: 'Язык?', context: 'Приветствие', impact: 'Текст вывода', options: ['Русский', 'English'], required: true },
  { text: 'Формат?', context: 'Вывод', impact: 'Совместимость', options: ['Text', 'JSON'], required: true },
  { text: 'Комментарий?', context: 'Дополнения', impact: 'Детали', options: [], required: false },
] };

test('answers continue Spec in the same worktree with all previous context, fixed config and no new revision', async t => {
  const { store, project, queue, controller } = fixture(t);
  const first = queue();
  let runner = controller(async () => needsInput); runner.enqueue(first); await runner.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const question = store.humanRequests().at(-1)!;
    const task = store.task(project.id, first.task_id);
    assert.equal(question.status, 'pending'); assert.equal(question.answers, null);
    assert.throws(() => store.answer(project.id, task.id, question.id, task.state_version, ['Русский', '', '']), /обязательные/);
    assert.equal(store.humanRequests().at(-1)!.status, 'pending');
    const response = store.answer(project.id, task.id, question.id, task.state_version, ['Русский', 'JSON', '']);
    assert.ok(response.run);
    assert.equal(response.run.worktree, first.worktree); assert.equal(response.run.base_sha, first.base_sha);
    assert.deepEqual(response.run.config, first.config);
    assert.equal(store.task(project.id, task.id).revision, 1);
    assert.throws(() => store.answer(project.id, task.id, question.id, store.task(project.id, task.id).state_version, ['Русский', 'JSON', '']), /устарел/);
    runner = controller(async input => {
      const saved = JSON.parse(readFileSync(join(input.directory, 'input.json'), 'utf8'));
      assert.equal(saved.run.parent_run_id, question.run_id);
      assert.match(input.prompt, /Русский/); assert.match(input.prompt, /JSON/);
      for (const request of store.humanRequests()) assert.ok(input.prompt.includes(request.id));
      return attempt ? ready : needsInput;
    });
    runner.enqueue(response.run); await runner.close();
  }
  assert.equal(store.task(project.id, first.task_id).stage, 'build');
  assert.equal(store.runs().length, 3); assert.equal(store.revisions(project.id, first.task_id).length, 1);
  assert.equal(store.specRun(project.id, first.task_id, first.id).report, 1);
});

for (const scenario of ['revision', 'restart', 'save-failure', 'dirty-worktree'] as const) test(`human answer ${scenario}`, async t => {
  const { store, project, directory, queue, controller } = fixture(t);
  const run = queue(); const runner = controller(async () => needsInput); runner.enqueue(run); await runner.close();
  const request = store.humanRequests()[0], task = store.task(project.id, run.task_id);
  const answers = ['English', 'Text', ''];
  if (scenario === 'revision') {
    store.mutate('edit', 'edit', () => store.editTask(project.id, task.id, 'Новые требования', task.state_version));
    assert.equal(store.humanRequests()[0].status, 'revoked');
    assert.equal(store.task(project.id, task.id).revision, 2);
    assert.equal(store.task(project.id, task.id).stage, 'backlog');
    assert.equal(store.specRun(project.id, task.id, run.id).description_revision, 1);
    assert.throws(() => store.answer(project.id, task.id, request.id, task.state_version + 1, answers), /устарел/);
  } else if (scenario === 'restart') {
    store.close(); const restarted = new Store(directory);
    try {
      assert.equal(restarted.humanRequests()[0].status, 'pending');
      const current = restarted.task(project.id, task.id);
      assert.equal(current.run_state, 'interrupted');
      assert.deepEqual(restarted.answer(project.id, task.id, request.id, current.state_version, answers), { run: null });
      assert.deepEqual(restarted.humanRequests()[0].answers, answers);
      assert.equal(restarted.runs().length, 1);
      assert.equal(restarted.task(project.id, task.id).run_state, 'interrupted');
    } finally { restarted.close(); }
  } else if (scenario === 'save-failure') {
    store.db.exec("CREATE TRIGGER fail_answer BEFORE INSERT ON events WHEN NEW.type = 'spec.queued' BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
    assert.throws(() => store.mutate('answer', 'answer', () => store.answer(project.id, task.id, request.id, task.state_version, answers)), /disk failed/);
    assert.equal(store.humanRequests()[0].status, 'pending'); assert.equal(store.humanRequests()[0].answers, null);
    assert.equal(store.task(project.id, task.id).state_version, task.state_version);
    assert.equal(store.events(0).filter(event => event.type === 'human.answered').length, 0);
    assert.equal(store.runs().length, 1); assert.equal(store.replay('answer', 'answer'), undefined);
  } else {
    writeFileSync(join(run.worktree, 'human-file'), 'preserve');
    const response = store.answer(project.id, task.id, request.id, task.state_version, answers);
    let called = false; const next = controller(async () => { called = true; return ready; });
    next.enqueue(response.run!); await next.close();
    assert.equal(called, false); assert.equal(store.task(project.id, task.id).run_state, 'interrupted');
    assert.equal(readFileSync(join(run.worktree, 'human-file'), 'utf8'), 'preserve');
  }
});

for (const scenario of ['dirty-checkout', 'changed-remote', 'foreign-worktree'] as const) test(`Spec continuation ${scenario}`, async t => {
  const { checkout, store, project, git, queue, controller } = fixture(t);
  const first = queue(), initial = controller(async () => needsInput);
  initial.enqueue(first); await initial.close();
  const request = store.humanRequests()[0], task = store.task(project.id, first.task_id);
  if (scenario === 'dirty-checkout') writeFileSync(join(checkout, 'README.md'), 'User changes while answering');
  else if (scenario === 'changed-remote') git('remote', 'set-url', 'origin', join(checkout, 'different.git'));
  else {
    renameSync(first.worktree, `${first.worktree}.original`);
    git('clone', '--no-checkout', project.remote_url, first.worktree);
    git('-C', first.worktree, 'checkout', '-b', first.branch, first.base_sha!);
  }
  const { run } = store.answer(project.id, task.id, request.id, task.state_version, ['English', 'Text', '']);
  let calls = 0;
  const next = controller(async input => {
    calls++;
    assert.equal(input.cwd, first.worktree);
    assert.equal(readFileSync(join(input.cwd, 'README.md'), 'utf8'), 'initial');
    assert.match(input.prompt, /English/);
    return ready;
  });
  next.enqueue(run!); await next.close();
  const saved = store.specRun(project.id, task.id, run!.id);
  if (scenario === 'dirty-checkout') {
    assert.equal(saved.status, 'completed', saved.error ?? '');
    assert.equal(calls, 1); assert.equal(store.task(project.id, task.id).stage, 'build');
    assert.equal(readFileSync(join(checkout, 'README.md'), 'utf8'), 'User changes while answering');
  } else {
    assert.equal(calls, 0); assert.equal(saved.status, 'failed');
    assert.match(saved.error!, /remote изменился/);
  }
});

for (const dirty of [false, true]) test(`global FIFO across projects: queued preflight dirty=${dirty}`, { timeout: 15000 }, async t => {
  const { store, project, directory, queue } = fixture(t);
  const other = fixture(t);
  const second = store.addProject(other.project);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const runner = new SpecController(store, directory, () => {}, command, async input => {
    calls.push(input.cwd);
    if (calls.length <= 3) await gate;
    return needsInput;
  });
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 1000 && !predicate(); i++) await delay(5);
    assert.ok(predicate(), 'Expected queue progress');
  };
  try {
    for (let i = 0; i < 3; i++) runner.enqueue(queue());
    await until(() => calls.length === 3);
    const task = store.createTask(second.id, 'Second project', second.state_version);
    const fourth = store.queueSpec(second.id, task.id, task.state_version, directory);
    runner.enqueue(fourth);
    await delay(20);
    assert.equal(calls.length, 3);
    assert.equal(store.task(second.id, task.id).run_state, 'queued');
    assert.equal(store.task(second.id, task.id).stage, 'backlog');
    if (dirty) writeFileSync(join(other.checkout, 'README.md'), 'user changes while queued');
    release();
    await until(() => !['queued', 'running'].includes(store.specRun(second.id, task.id, fourth.id).status));
    assert.equal(calls.length, dirty ? 3 : 4);
    assert.equal(store.specRun(second.id, task.id, fourth.id).status, dirty ? 'failed' : 'completed');
    if (dirty) {
      assert.match(store.specRun(second.id, task.id, fourth.id).error!, /checkout/);
      assert.equal(existsSync(fourth.worktree), false);
      assert.equal(readFileSync(join(other.checkout, 'README.md'), 'utf8'), 'user changes while queued');
    }
  } finally { release(); await runner.close(); }
});

test('human answer persists immediately but continuation joins FIFO behind occupied slots', { timeout: 15000 }, async t => {
  const { store, project, directory, queue } = fixture(t);
  const first = queue();
  const initial = new SpecController(store, directory, () => {}, command, async () => needsInput);
  initial.enqueue(first); await initial.close();
  const releases: (() => void)[] = [];
  const calls: string[] = [];
  let active = 0, maximum = 0;
  const runner = new SpecController(store, directory, () => {}, command, async input => {
    calls.push(input.cwd); maximum = Math.max(maximum, ++active);
    if (calls.length <= 3) await new Promise<void>(resolve => releases.push(resolve));
    if (input.cwd === first.worktree) assert.match(input.prompt, /English/);
    active--; return needsInput;
  });
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 1000 && !predicate(); i++) await delay(5);
    assert.ok(predicate(), 'Expected queue progress');
  };
  try {
    for (let i = 0; i < 3; i++) runner.enqueue(queue());
    await until(() => calls.length === 3);
    const ahead = queue(); runner.enqueue(ahead);
    const question = store.humanRequests()[0];
    const task = store.task(project.id, first.task_id);
    const response = store.mutate('answer-request', 'answer-fingerprint', () =>
      store.answer(project.id, task.id, question.id, task.state_version, ['English', 'Text', ''])) as { run: typeof first };
    runner.enqueue(response.run);
    assert.deepEqual(store.humanRequests()[0].answers, ['English', 'Text', '']);
    assert.equal(store.task(project.id, task.id).stage, 'spec');
    assert.equal(store.task(project.id, task.id).run_state, 'queued');
    assert.deepEqual(store.replay('answer-request', 'answer-fingerprint'), response);
    assert.throws(() => store.answer(project.id, task.id, question.id, task.state_version, ['English', 'Text', '']));
    await delay(20); assert.equal(calls.length, 3);
    releases[0]();
    await until(() => store.specRun(project.id, task.id, response.run.id).status === 'completed');
    assert.equal(maximum, 3);
    assert.deepEqual(calls.slice(3), [ahead.worktree, first.worktree]);
  } finally { const closing = runner.close(); releases.forEach(release => release()); await closing; }
});

test('Spec answer repeats worktree preflight on dequeue even when an unfinished merge has empty status', { timeout: 15000 }, async t => {
  const { store, project, directory, git, queue, controller } = fixture(t);
  const first = queue(), initial = controller(async () => needsInput);
  initial.enqueue(first); await initial.close();
  const releases: (() => void)[] = [];
  let calls = 0;
  const runner = new SpecController(store, directory, () => {}, command, async () => { calls++; return ready; },
    async () => { await new Promise<void>(resolve => releases.push(resolve)); return 'Title'; });
  try {
    for (let i = 0; i < 3; i++) store.createTask(project.id, `Blocker ${i}`, project.state_version);
    runner.titles.kick(); assert.equal(releases.length, 3);
    const question = store.humanRequests()[0], task = store.task(project.id, first.task_id);
    const { run } = store.answer(project.id, task.id, question.id, task.state_version, ['English', 'Text', '']);
    runner.enqueue(run!);
    assert.equal(store.task(project.id, task.id).run_state, 'queued');
    git('-C', first.worktree, 'checkout', '-b', 'merge-other');
    git('-C', first.worktree, 'commit', '--allow-empty', '-m', 'other');
    git('-C', first.worktree, 'checkout', first.branch);
    git('-C', first.worktree, 'merge', '--no-commit', '--no-ff', 'merge-other');
    assert.equal(git('-C', first.worktree, 'status', '--porcelain'), '');
    assert.equal(git('-C', first.worktree, 'rev-parse', 'HEAD'), first.base_sha);
    releases[0]();
    for (let i = 0; i < 1000 && store.specRun(project.id, task.id, run!.id).status === 'queued'; i++) await delay(5);
    const saved = store.specRun(project.id, task.id, run!.id);
    assert.equal(saved.status, 'failed'); assert.match(saved.error!, /merge\/rebase/);
    assert.equal(calls, 0);
    assert.ok(git('-C', first.worktree, 'rev-parse', '--verify', 'MERGE_HEAD'));
  } finally { const closing = runner.close(); releases.forEach(release => release()); await closing; }
});

import { CodexFailure } from '../src/server/diagnostics.js';
for (const timed of [false, true]) test(`confirmed rate limit pauses all projects and retry preserves history; timed=${timed}`, { timeout: 10000 }, async t => {
  const { store, directory, project, queue } = fixture(t);
  let calls = 0;
  const runner = new SpecController(store, directory, () => {}, command, async input => {
    input.metadata?.({ cli_version: 'codex-cli 1.0', session_id: 'test-session' });
    calls++;
    const failure = new CodexFailure(calls === 1 ? 'rate_limit' : 'authentication', timed ? new Date(Date.now() + 700).toISOString() : null);
    failure.finished = true; throw failure;
  });
  const run = queue(); runner.enqueue(run);
  for (let i = 0; i < 200 && !store.executionPause().paused; i++) await delay(10);
  assert.equal(store.executionPause().paused, 1); assert.equal(calls, 1);
  const failed = store.specRun(project.id, run.task_id, run.id);
  assert.equal(failed.diagnostic?.execution_finished, true); assert.ok(failed.source_hash);
  assert.equal(failed.diagnostic?.session_id, 'test-session'); assert.ok(failed.started_at); assert.ok(failed.finished_at);
  const waiting = queue(); runner.enqueue(waiting);
  await delay(50); assert.equal(calls, 1);
  const retry = store.mutate('retry-rate', 'retry-rate', () => store.retryRun(project.id, run.task_id, store.task(project.id, run.task_id).state_version)) as typeof run;
  runner.enqueue(retry);
  if (!timed) { store.db.transaction(() => store.resumeExecution(store.executionPause().state_version))(); runner.resume(); }
  for (let i = 0; i < 300 && calls < 3; i++) await delay(10);
  assert.equal(calls, 3); await runner.close();
  assert.equal(store.executionPause().paused, 0); assert.equal(store.runs().filter(r => r.task_id === run.task_id).length, 2);
  assert.equal(store.specRun(project.id, run.task_id, retry.id).repair_attempt, 0);
  assert.equal(store.specRun(project.id, run.task_id, run.id).diagnostic?.error_kind, 'rate_limit');
});

test('quoted config example in Spec stays valid and Build consumes the redacted artifact', { timeout: 10000 }, async t => {
  const { store, directory, project, queue } = fixture(t);
  let built = false;
  const runner = new SpecController(store, directory, () => {}, command,
    async () => ({ ...ready, summary: 'Use token="example" in the config' }), undefined,
    async input => {
      assert.ok(input.prompt.includes('[REDACTED]')); assert.ok(!input.prompt.includes('example'));
      built = true; return { outcome: 'BLOCKED', summary: 'Regression stops after reading Spec', changed_paths: [], actions: [], checks: [], questions: [] };
    });
  const run = queue(); runner.enqueue(run);
  for (let i = 0; i < 300 && !built; i++) await delay(10);
  await runner.close(); assert.ok(built);
  assert.equal(store.specRun(project.id, run.task_id, run.id).status, 'completed');
  assert.equal(store.runs().at(-1)?.role, 'build'); assert.equal(store.runs().at(-1)?.status, 'completed');
});
