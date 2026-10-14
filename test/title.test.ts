import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { Titles, parseTitle } from '../src/server/title.js';
import type { Task } from '../src/shared.js';

function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-title-test-'));
  const store = new Store(directory);
  const project = store.addProject({ checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github', host: 'github.com', repository: 'owner/repo', target_branch: 'main' });
  const calls: { description: string; resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  const errors: unknown[] = [];
  const titles = new Titles(store, () => {}, (description, signal) => new Promise((resolve, reject) => {
    calls.push({ description, resolve, reject });
    signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
  }), error => errors.push(error));
  t.after(async () => { await titles.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = (description = 'original') => store.mutate(crypto.randomUUID(), description, () => store.createTask(project.id, description, 1)) as Task;
  return { store, project, titles, calls, errors, create };
}

test('title validation rejects malformed, empty, multiline and oversized results', () => {
  assert.equal(parseTitle({ title: ' Заголовок ' }), 'Заголовок');
  for (const value of [null, [], {}, { title: 1 }, { title: '' }, { title: 'x', extra: 1 }, { title: 'a\nb' }, { title: 'a'.repeat(121) }]) assert.throws(() => parseTitle(value));
});

test('three shared slots, no duplicate title, stale revision discarded and current revision follows', async t => {
  const { store, titles, calls, create } = fixture(t);
  const first = create('old');
  create(); create(); create();
  titles.kick(); titles.kick(); await setImmediate();
  assert.equal(calls.length, 3);
  store.mutate('edit', 'edit', () => store.editTask(first.project_id, first.id, 'new', 1));
  titles.kick(); await setImmediate();
  assert.equal(calls.length, 3);
  calls[0].resolve('Old title'); await setImmediate();
  assert.equal(store.task(first.project_id, first.id).title, null);
  assert.equal(calls[3].description, 'original');
  calls[1].resolve('Other title'); await setImmediate();
  assert.equal(calls[4].description, 'new');
  calls[4].resolve('New title'); await setImmediate();
  const saved = store.task(first.project_id, first.id);
  assert.equal(saved.title, 'New title');
  assert.equal(saved.description, 'new');
  assert.equal(saved.run_state, 'idle');
  assert.equal(saved.stage, 'backlog');
});

test('CLI failures and invalid output preserve the card and revision', async t => {
  const { store, titles, calls, create } = fixture(t);
  const a = create(), b = create();
  titles.kick(); await setImmediate();
  calls[0].reject(new Error('private provider credentials'));
  calls[1].resolve(''); await setImmediate();
  for (const task of [a, b]) {
    assert.equal(store.task(task.project_id, task.id).title_state, 'failed');
    assert.equal(store.task(task.project_id, task.id).description, 'original');
    assert.equal(store.revisions(task.project_id, task.id).length, 1);
  }
  assert.ok(!JSON.stringify(store.snapshot()).includes('credentials'));
});

test('Spec releases active or pending title only after the generator settles', async t => {
  const { store, titles, calls, create } = fixture(t);
  const title = create();
  titles.kick(); await setImmediate();
  await titles.releaseForSpec(title);
  assert.equal(calls.length, 1);
  assert.equal(store.task(title.project_id, title.id).title_state, 'interrupted');
  assert.equal(store.task(title.project_id, title.id).title, null);
  assert.throws(() => titles.releaseForSpec({ ...title, revision: 99 }), /изменилась/);
});

test('failed persistence rolls back start, launches no CLI and stops scheduling', async t => {
  const { store, titles, calls, errors, create } = fixture(t);
  const task = create();
  store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'write failed'); END");
  titles.kick(); await setImmediate();
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(store.task(task.project_id, task.id).title_state, 'pending');
});

test('restart marks queued and active titles interrupted, keeps completed title, and never requeues', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-title-restart-'));
  let store = new Store(dir);
  try {
    const p = store.addProject({ checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github', host: 'github.com', repository: 'owner/repo', target_branch: 'main' });
    const a = store.createTask(p.id, 'a', 1), b = store.createTask(p.id, 'b', 1);
    store.finishTitle(store.claimTitle(a)!, 'Saved title');
    store.claimTitle(b);
    const c = store.createTask(p.id, 'c', 1);
    store.close(); store = new Store(dir);
    assert.equal(store.task(p.id, a.id).title, 'Saved title');
    for (const task of [b, c]) assert.equal(store.task(p.id, task.id).title_state, 'interrupted');
    assert.equal(store.claimTitle(store.task(p.id, a.id)), undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('v1 database migration preserves descriptions and does not automatically run old cards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-title-migration-'));
  let store = new Store(dir);
  try {
    const p = store.addProject({ checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github', host: 'github.com', repository: 'owner/repo', target_branch: 'main' });
    const task = store.createTask(p.id, 'old description', 1);
    store.db.exec('ALTER TABLE tasks DROP COLUMN title_state; PRAGMA user_version = 1;');
    store.close(); store = new Store(dir);
    assert.equal(store.task(p.id, task.id).description, 'old description');
    assert.equal(store.task(p.id, task.id).title_state, 'interrupted');
    assert.equal(store.db.pragma('user_version', { simple: true }), 18);
    assert.equal(store.claimTitle(store.task(p.id, task.id)), undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const graceful of [true, false]) test(`title abort waits for CLI close (${graceful ? 'graceful' : 'forced'})`, { timeout: 5000 }, async () => {
  const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { generateTitle } = await import('../src/server/title.js');
  const root = mkdtempSync(join(tmpdir(), 'factory-title-process-'));
  const pidFile = join(root, 'pid'), aborted = join(root, 'aborted'), release = join(root, 'release');
  writeFileSync(join(root, 'codex'), `#!${process.execPath}\nconst fs = require('node:fs');
    const assert = require('node:assert/strict'), argv = process.argv.slice(2);
    assert.ok(argv.includes('--ignore-user-config'));
    for (const feature of ['computer_use', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'apps', 'plugins', 'remote_plugin', 'hooks']) {
      assert.ok(argv.some((value, i) => value === '--disable' && argv[i + 1] === feature));
    }
    process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(aborted)}, 'yes'));
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 5);`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = `${root}:${previous}`;
  const signal = new AbortController();
  let settled = false, pid: number | undefined;
  const done = generateTitle('test', signal.signal).then(() => { settled = true; }, () => { settled = true; });
  async function waitFor(path: string) {
    for (let i = 0; i < 200 && !existsSync(path); i++) await delay(5);
    assert.ok(existsSync(path), `Missing process marker: ${path}`);
  }
  try {
    await waitFor(pidFile); pid = Number(readFileSync(pidFile, 'utf8'));
    signal.abort(); await waitFor(aborted); await delay(20);
    assert.equal(settled, false, 'abort must not release a still-running CLI');
    if (graceful) writeFileSync(release, 'yes');
    await done;
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await done;
    process.env.PATH = previous; rmSync(root, { recursive: true, force: true });
  }
});

for (const variant of ['spec-v2', 'title-v2'] as const) test(`migration from ${variant} preserves data and opens both features`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-v2-migration-'));
  let store = new Store(dir);
  try {
    const p = store.addProject({ checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github', host: 'github.com', repository: 'owner/repo', target_branch: 'main' });
    const task = store.createTask(p.id, 'keep description', 1);
    store.db.prepare("UPDATE tasks SET title = 'Saved title', title_state = 'completed' WHERE id = ?").run(task.id);
    let runId: string | undefined;
    if (variant === 'spec-v2') {
      const config = { ...store.settings(p.id), instructions: 'Keep instructions' };
      store.saveSettings(p.id, config, 1);
      const run = store.queueSpec(p.id, task.id, 1, dir);
      run.status = 'completed'; run.outcome = 'READY';
      store.updateRun(run, 'build', 'idle'); runId = run.id;
      store.db.exec('ALTER TABLE tasks DROP COLUMN title_state');
    }
    else store.db.exec('DROP TABLE runs; DROP TABLE project_settings');
    store.db.pragma('user_version = 2');
    store.close(); store = new Store(dir);
    const saved = store.task(p.id, task.id);
    assert.equal(saved.description, 'keep description'); assert.equal(saved.title, 'Saved title');
    assert.equal(saved.title_state, 'completed');
    assert.equal(store.revisions(p.id, task.id).length, 1);
    assert.equal(store.db.pragma('user_version', { simple: true }), 18);
    assert.equal(Object.keys(store.settings(p.id).models).length, 6);
    if (runId) {
      assert.equal(store.specRun(p.id, task.id, runId).outcome, 'READY');
      assert.equal(store.settings(p.id).instructions, 'Keep instructions');
    } else assert.deepEqual(store.runs(), []);
  } finally { if (store.db.open) store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('confirmed Title rate limit reaches the shared pause handler', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-title-limit-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject({ checkout: '/repo', common_dir: '/repo/.git', remote: 'origin', remote_url: 'git@github.com:test/repo.git', hosting: 'github', host: 'github.com', repository: 'test/repo', target_branch: 'main' });
  const task = store.createTask(project.id, 'test', 1);
  const { CodexFailure } = await import('../src/server/diagnostics.js');
  const titles = new Titles(store, () => {}, async () => { throw new CodexFailure('rate_limit'); }, undefined, undefined,
    error => { if (error instanceof CodexFailure) store.db.transaction(() => store.pauseExecution(error.resetAt))(); });
  titles.kick();
  for (let i = 0; i < 100 && !store.executionPause().paused; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await titles.close();
  assert.equal(store.executionPause().paused, 1); assert.equal(store.task(project.id, task.id).title_state, 'failed');
});

test('Title stderr prompt mentioning rate limit cannot override the actual authentication error', async () => {
  const { writeFileSync } = await import('node:fs');
  const { generateTitle } = await import('../src/server/title.js');
  const { CodexFailure } = await import('../src/server/diagnostics.js');
  const root = mkdtempSync(join(tmpdir(), 'factory-title-classification-'));
  writeFileSync(join(root, 'codex'), `#!${process.execPath}\nlet prompt = ''; process.stdin.on('data', c => prompt += c); process.stdin.on('end', () => {
    process.stderr.write('user\\n' + prompt + '\\nERROR: unexpected status 401 Unauthorized\\n', () => process.exit(1));
  });`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = `${root}:${previous}`;
  try {
    await assert.rejects(generateTitle('Investigate rate limit exceeded and model 429', new AbortController().signal), error => {
      assert.ok(error instanceof CodexFailure); assert.equal(error.kind, 'authentication'); return true;
    });
  } finally { process.env.PATH = previous; rmSync(root, { recursive: true, force: true }); }
});
