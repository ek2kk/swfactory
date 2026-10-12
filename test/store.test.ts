import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../src/server/store.js';

test('exclusive ownership across processes, persistence and interrupted restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const project = store.mutate('connect', 'connect', () => store.addProject({ checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github', host: 'github.com', repository: 'owner/repo', target_branch: 'main' })) as { id: string };
  const task = store.mutate('create', 'create', () => store.createTask(project.id, '  original\ntext  ', 1)) as { id: string };
  store.db.prepare("UPDATE tasks SET stage = 'build', run_state = 'running' WHERE id = ?").run(task.id);
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { Store } from './src/server/store.ts'; try { new Store(process.argv[1]).close(); process.exit(2); } catch(e) { if (!e.message.includes('другому backend')) process.exit(3); }`, dir], { cwd: process.cwd(), stdio: 'pipe' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  store.close();
  const restarted = new Store(dir);
  t.after(() => restarted.close());
  const saved = restarted.task(project.id, task.id);
  assert.equal(saved.description, '  original\ntext  ');
  assert.equal(saved.run_state, 'interrupted');
  assert.equal(saved.state_version, 2);
  assert.equal(restarted.snapshot().projects[0].remote, 'origin');
  assert.equal(restarted.events(0).at(-1)?.type, 'task.interrupted');
  assert.equal(restarted.revisions(project.id, task.id).length, 1);
});

test('failed event persistence rolls back the task, revision and request', t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-rollback-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.addProject({ checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github', host: 'github.com', repository: 'owner/repo', target_branch: 'main' });
  store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'write failed'); END");
  assert.throws(() => store.mutate('create', 'create', () => store.createTask(project.id, 'test', 1)), /write failed/);
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM task_revisions').get() as { n: number }).n, 0);
  assert.equal(store.replay('create', 'create'), undefined);
});

test('v1 migration preserves tasks and failed start transaction leaves no run or request', t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-migration-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.addProject({ checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github', host: 'github.com', repository: 'owner/repo', target_branch: 'main' });
  const task = store.createTask(project.id, 'preserve', 1);
  store.db.exec('DROP TABLE runs; DROP TABLE project_settings; PRAGMA user_version = 1;');
  store.close(); store = new Store(dir);
  assert.equal(store.task(project.id, task.id).description, 'preserve');
  assert.equal(store.settings(project.id).models.spec, 'gpt-6.1-sol');
  store.db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'write failed'); END");
  assert.throws(() => store.mutate('start', 'start', () => store.queueSpec(project.id, task.id, 1, dir)), /write failed/);
  assert.equal(store.runs().length, 0); assert.equal(store.task(project.id, task.id).run_state, 'idle');
  assert.equal(store.replay('start', 'start'), undefined);
});
