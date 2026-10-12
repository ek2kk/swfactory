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
  assert.equal(calls[3].description, 'new');
  calls[3].resolve('New title'); await setImmediate();
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

test('Spec releases active or pending title and working tasks consume shared slots', async t => {
  const { store, titles, calls, create } = fixture(t);
  const work = create(), title = create();
  store.db.prepare("UPDATE tasks SET stage = 'spec', run_state = 'running' WHERE id = ?").run(work.id);
  create(); create();
  titles.kick(); await setImmediate();
  assert.equal(calls.length, 2);
  await titles.releaseForSpec(title);
  assert.equal(store.task(title.project_id, title.id).title_state, 'interrupted');
  assert.equal(store.task(title.project_id, title.id).title, null);
  store.db.prepare("UPDATE tasks SET stage = 'spec', run_state = 'running' WHERE id = ?").run(title.id);
  titles.acceptSpecTitle(title, 'Заголовок из Spec');
  assert.equal(store.task(title.project_id, title.id).title, 'Заголовок из Spec');
  assert.throws(() => titles.acceptSpecTitle({ ...title, revision: 99 }, 'stale'), /не готова/);
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
    store.finishTitle(store.claimTitle()!, 'Saved title');
    store.claimTitle();
    const c = store.createTask(p.id, 'c', 1);
    store.close(); store = new Store(dir);
    assert.equal(store.task(p.id, a.id).title, 'Saved title');
    for (const task of [b, c]) assert.equal(store.task(p.id, task.id).title_state, 'interrupted');
    assert.equal(store.claimTitle(), undefined);
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
    assert.equal(store.db.pragma('user_version', { simple: true }), 2);
    assert.equal(store.claimTitle(), undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
