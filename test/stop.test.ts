import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';
import { spawn as nativeSpawn, execFileSync } from 'node:child_process';
import { Store } from '../src/server/store.js';
import { SpecController } from '../src/server/spec.js';
import { ProcessScope, checkExecution, processCensus, spawn } from '../src/server/processes.js';
import { createApp } from '../src/server/app.js';
import { publishGithub } from '../src/server/publication.js';
import { artifactDirectory, saveArtifact } from '../src/server/artifacts.js';
import type { AgentRun } from '../src/shared.js';

const projectInput = { checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github' as const, host: 'github.com', repository: 'owner/repo', target_branch: 'main' };
function fixture(t: { after: (work: () => void | Promise<void>) => void }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-stop-')));
  const store = new Store(directory), project = store.addProject(projectInput);
  const controller = new SpecController(store, directory, () => {}, undefined, undefined, async () => 'Title');
  t.after(async () => { await controller.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, project, controller };
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await delay(10);
  assert.ok(predicate(), 'condition must become true');
}

for (const reused of [false, true]) test(`census failure revokes signals but retains capacity until ${reused ? 'PID reuse is detected' : 'identity is verified again'}`, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-stop-census-'))), ps = join(directory, 'ps');
  const listing = (started = 'Thu Oct 15 00:00:00 2026') => `#!/bin/sh\nprintf '987654 1 987654 S ${started}\\n'\n`;
  const empty = listing().replace(' S ', ' Z ');
  writeFileSync(ps, listing(), { mode: 0o700 });
  const previousPath = process.env.PATH; process.env.PATH = `${directory}:${previousPath}`;
  const states: string[] = [], sent: unknown[] = [];
  const scope = new ProcessScope((_pid, row) => states.push(row.state));
  t.after(async () => {
    try { writeFileSync(ps, empty); await scope.stop(100); }
    finally { process.env.PATH = previousPath; rmSync(directory, { recursive: true, force: true }); }
  });
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    sent.push([pid, signal]); writeFileSync(ps, empty); return true;
  });
  scope.restore([{ pid: 987654, pgid: 987654, started_at: 'Thu Oct 15 00:00:00 2026', state: 'running' }]);
  assert.equal(scope.hasLiveProcesses(), true);
  writeFileSync(ps, '#!/bin/sh\nexit 1\n');
  const failure = await scope.stop(60).catch(error => error);
  assert.deepEqual(sent, [], 'failed census must revoke permission to signal a formerly verified PGID');
  assert.match(failure.message, /диагностика/);
  assert.equal(states.at(-1), 'unknown');
  assert.equal(scope.hasLiveProcesses(), true, 'diagnostics outage must not release known capacity');
  writeFileSync(ps, listing(reused ? 'Thu Oct 15 00:00:01 2026' : undefined));
  if (reused) {
    await assert.rejects(scope.stop(100), /не подтверждено/);
    assert.deepEqual(sent, []); assert.equal(scope.hasLiveProcesses(), false);
  } else {
    await scope.stop(200);
    assert.deepEqual(sent, [[-987654, 'SIGTERM']]); assert.equal(scope.hasLiveProcesses(), false);
    assert.equal(states.at(-1), 'exited');
  }
});

for (const currentProcess of [false, true]) test(`restart stops a revoked survivor independently of a fresh run${currentProcess ? ' and preserves its current process' : ''}`, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-stop-fresh-restart-')));
  const oldChild = nativeSpawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const currentChild = currentProcess ? nativeSpawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }) : undefined;
  await Promise.all([oldChild, ...(currentChild ? [currentChild] : [])].map(child => once(child.stdout!, 'data')));
  let store = new Store(directory), controller: SpecController | undefined;
  const kill = process.kill.bind(process), sent: number[] = [];
  t.after(async () => {
    for (const child of [oldChild, ...(currentChild ? [currentChild] : [])]) { try { kill(-child.pid!, 'SIGKILL'); } catch {} }
    await controller?.close(); await delay(300); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const project = store.addProject(projectInput), task = store.createTask(project.id, 'Survivor and fresh run', 1);
  const old = store.queueSpec(project.id, task.id, 1, directory), identity = processCensus().find(row => row.pid === oldChild.pid)!;
  store.recordProcess(task.id, { ...identity, state: 'running', run_id: old.id });
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
  store.finishDeletion(task.id, 'Известный процесс ещё работает. Остановка продолжится; можно повторить её.', true);
  store.releaseStoppedTask(project.id, task.id);
  const fresh = store.queueSpec(project.id, task.id, store.task(project.id, task.id).state_version, directory);
  if (currentChild) store.recordProcess(task.id, { ...processCensus().find(row => row.pid === currentChild.pid)!, state: 'running', run_id: fresh.id });
  store.close(); store = new Store(directory);
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (signal && signal !== 0) sent.push(pid);
    return kill(pid, signal);
  });
  controller = new SpecController(store, directory, () => {});
  let started = false;
  t.mock.method(controller as any, 'perform', async () => { started = true; });
  controller.enqueue(fresh);
  await waitFor(() => store.executionProcesses(task.id).find(row => row.pid === oldChild.pid)?.state === 'exited');
  assert.ok(sent.includes(-oldChild.pid!)); assert.equal(store.hasRun(fresh), true);
  if (currentChild) {
    assert.ok(!sent.includes(-currentChild.pid!)); kill(currentChild.pid!, 0);
    assert.equal(started, false); assert.equal((controller as any).scheduler.isActive(task.id), true);
    kill(-currentChild.pid!, 'SIGKILL');
  }
  await waitFor(() => started);
  await waitFor(() => !(controller as any).scheduler.isActive(task.id));
  assert.equal(controller.error, null);
});

for (const variant of ['recorded', 'legacy', 'current-title'] as const) test(`restart stops a title survivor before a fresh queued run (${variant})`, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-stop-title-restart-')));
  const child = nativeSpawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const current = variant === 'current-title' ? nativeSpawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }) : undefined;
  await Promise.all([child, ...(current ? [current] : [])].map(child => once(child.stdout!, 'data')));
  let store = new Store(directory), controller: SpecController | undefined;
  t.after(async () => {
    for (const processChild of [child, ...(current ? [current] : [])]) { try { process.kill(-processChild.pid!, 'SIGKILL'); } catch {} }
    await controller?.close(); await delay(300); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const project = store.addProject(projectInput), task = store.createTask(project.id, 'Title survivor', 1);
  const identity = processCensus().find(row => row.pid === child.pid)!;
  store.recordProcess(task.id, { ...identity, state: 'running', run_id: null, execution_generation: 0 });
  store.beginDeletion(project.id, task.id, task.state_version);
  store.finishDeletion(task.id, 'Известный процесс ещё работает.', true); store.releaseStoppedTask(project.id, task.id);
  const fresh = store.queueSpec(project.id, task.id, store.task(project.id, task.id).state_version, directory);
  if (current) store.recordProcess(task.id, { ...processCensus().find(row => row.pid === current.pid)!, state: 'running', run_id: null, execution_generation: 1 });
  if (variant === 'legacy') {
    store.db.exec('ALTER TABLE execution_processes DROP COLUMN execution_generation; PRAGMA user_version = 20');
  }
  store.close(); store = new Store(directory);
  controller = new SpecController(store, directory, () => {});
  let started = false;
  t.mock.method(controller as any, 'perform', async () => { started = true; });
  controller.enqueue(fresh);
  await waitFor(() => store.executionProcesses(task.id).find(row => row.pid === child.pid)?.state === 'exited');
  if (current) {
    assert.equal(store.executionProcesses(task.id).find(row => row.pid === current.pid)?.state, 'running');
    assert.equal(started, false, 'the current generation keeps its own slot');
    process.kill(current.pid!, 0); process.kill(-current.pid!, 'SIGKILL');
  }
  await waitFor(() => started && !(controller as any).scheduler.isActive(task.id));
  assert.equal(store.hasRun(fresh), true);
  assert.equal(store.executionProcesses(task.id).find(row => row.pid === child.pid)?.execution_generation, variant === 'legacy' ? null : 0);
});

for (const reused of [false, true]) test(`restart retries an unavailable census and ${reused ? 'rejects PID reuse' : 'recovers survivor capacity and Stop'}`, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-stop-restart-outage-'))), ps = join(directory, 'ps');
  let store = new Store(directory), controller: SpecController | undefined;
  const previousPath = process.env.PATH;
  const empty = "#!/bin/sh\nprintf '987654 1 987654 Z Thu Oct 15 00:00:00 2026\\n'\n";
  t.after(async () => {
    try {
      writeFileSync(ps, empty); await delay(400);
      await controller?.close(); await delay(300);
    } finally { process.env.PATH = previousPath; store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  const project = store.addProject(projectInput), task = store.createTask(project.id, 'Census outage', 1);
  const old = store.queueSpec(project.id, task.id, 1, directory);
  store.recordProcess(task.id, { pid: 987654, pgid: 987654, started_at: 'Thu Oct 15 00:00:00 2026', state: 'running', run_id: old.id });
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
  store.finishDeletion(task.id, 'Известный процесс ещё работает.', true); store.releaseStoppedTask(project.id, task.id);
  store.close(); store = new Store(directory);
  writeFileSync(ps, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  process.env.PATH = `${directory}:${previousPath}`;
  const sent: [number, NodeJS.Signals | number | undefined][] = [];
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => { sent.push([pid, signal]); return true; });
  controller = new SpecController(store, directory, () => {});
  await delay(100);
  assert.equal(store.executionProcesses(task.id)[0].state, 'unknown');
  assert.equal((controller as any).scheduler.isActive(task.id), false);
  assert.equal(sent.length, 0, 'an outage cannot authorize signals or a live slot');
  writeFileSync(ps, `#!/bin/sh\nprintf '987654 1 987654 S Thu Oct 15 00:00:0${reused ? 1 : 0} 2026\\n'\n`);
  if (reused) {
    await delay(700);
    assert.equal(store.executionProcesses(task.id)[0].state, 'unknown');
    assert.equal(sent.length, 0); assert.equal((controller as any).scheduler.isActive(task.id), false);
  } else {
    await waitFor(() => store.executionProcesses(task.id)[0].state === 'running' && (controller as any).scheduler.isActive(task.id));
    await waitFor(() => sent.some(([pid, signal]) => pid === -987654 && signal === 'SIGKILL'));
    assert.equal(store.task(project.id, task.id).stage, 'backlog');
  }
  writeFileSync(ps, empty);
  await waitFor(() => store.executionProcesses(task.id)[0].state === 'exited');
  await waitFor(() => !(controller as any).scheduler.isActive(task.id));
});

test('recovered survivor retains capacity independently of an active fresh run of the same task', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-stop-recovery-race-'))), ps = join(directory, 'ps');
  let store = new Store(directory), controller: SpecController | undefined;
  const previousPath = process.env.PATH;
  const empty = "#!/bin/sh\nprintf '987654 1 987654 Z Thu Oct 15 00:00:00 2026\\n'\n";
  let releaseFresh!: () => void, releaseOthers!: () => void;
  const freshGate = new Promise<void>(resolve => { releaseFresh = resolve; });
  const othersGate = new Promise<void>(resolve => { releaseOthers = resolve; });
  t.after(async () => {
    try {
      writeFileSync(ps, empty); releaseFresh(); releaseOthers(); await delay(400);
      await controller?.close(); await delay(300);
    } finally { process.env.PATH = previousPath; store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  const project = store.addProject(projectInput), task = store.createTask(project.id, 'Recovery during fresh run', 1);
  const old = store.queueSpec(project.id, task.id, 1, directory);
  store.recordProcess(task.id, { pid: 987654, pgid: 987654, started_at: 'Thu Oct 15 00:00:00 2026', state: 'running', run_id: old.id });
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
  store.finishDeletion(task.id, 'Известный процесс ещё работает.', true); store.releaseStoppedTask(project.id, task.id);
  store.close(); store = new Store(directory);
  writeFileSync(ps, '#!/bin/sh\nexit 1\n', { mode: 0o700 }); process.env.PATH = `${directory}:${previousPath}`;
  const sent: [number, NodeJS.Signals | number | undefined][] = [];
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => { sent.push([pid, signal]); return true; });
  controller = new SpecController(store, directory, () => {});
  const scheduler = (controller as any).scheduler;
  const retain = t.mock.method(scheduler, 'retain');
  const fresh = store.queueSpec(project.id, task.id, store.task(project.id, task.id).state_version, directory);
  const perform = t.mock.method(controller as any, 'perform', () => freshGate);
  controller.enqueue(fresh);
  const freshDone = Promise.all([...(controller as any).active]);
  await waitFor(() => perform.mock.callCount() === 1);
  assert.equal(sent.length, 0);
  const others = ['other-1', 'other-2'].map(id => scheduler.enqueue(id, () => othersGate));
  writeFileSync(ps, "#!/bin/sh\nprintf '987654 1 987654 S Thu Oct 15 00:00:00 2026\\n'\n");
  await waitFor(() => retain.mock.callCount() > 0);
  await waitFor(() => sent.some(([pid, signal]) => pid === -987654 && signal === 'SIGKILL'));
  assert.equal(store.executionProcesses(task.id)[0].state, 'running');
  const started: string[] = [];
  const next = scheduler.enqueue('next-task', async () => { started.push('next'); });
  const sameTask = scheduler.enqueue(task.id, async () => { started.push('same-task'); });
  releaseFresh(); await freshDone;
  assert.deepEqual(started, [], 'survivor plus two other jobs still fill capacity after fresh completion');
  releaseOthers(); await Promise.all(others); await next;
  assert.deepEqual(started, ['next'], 'same-task work remains blocked by the survivor even with free capacity');
  writeFileSync(ps, empty);
  await waitFor(() => store.executionProcesses(task.id)[0].state === 'exited');
  await sameTask;
  assert.deepEqual(started, ['next', 'same-task']);
});

test('legacy Stop releases lifecycle without manual proof, preserves publication and rejects stale run callbacks at the same revision', async t => {
  const { store, project, directory, controller } = fixture(t);
  const task = store.createTask(project.id, 'Keep requirements', 1);
  const old = store.queueSpec(project.id, task.id, 1, directory);
  old.status = 'running'; store.updateRun(old, 'spec', 'running');
  store.db.prepare("UPDATE tasks SET stop_unverified = 1, execution_unverified = 1, publication_status = 'unknown', pr_url = 'https://github.com/owner/repo/pull/7' WHERE id = ?").run(task.id);
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
  assert.equal(store.hasRun(old), false, 'authority revoked before async stop');
  await controller.deleteTask(task.id, true);
  const stopped = store.task(project.id, task.id);
  assert.equal(stopped.stage, 'backlog'); assert.equal(stopped.run_state, 'idle'); assert.equal(stopped.archived, 0);
  assert.match(stopped.execution_warning!, /недостаточно/);
  assert.equal((controller as any).scheduler.active.size, 0, 'legacy flag cannot reserve capacity');
  const fresh = store.queueSpec(project.id, task.id, stopped.state_version, directory);
  fresh.status = 'running'; store.updateRun(fresh, 'spec', 'running');
  const before = store.task(project.id, task.id);
  old.status = 'completed'; old.outcome = 'READY';
  store.updateRun(old, 'build', 'idle');
  store.saveSpecDecision(old, { revision: task.revision, mode: 'skip', required: false, reason: 'Stale', missing: [] });
  store.recordOutput(old, 'late output'); store.invalidateReviews(old);
  (controller as any).recordMetadata(old, { session_id: 'historical-thread', turn_id: 'historical-turn', execution_finished: true });
  (controller as any).registerInterrupt(old, () => { throw Error('stale turn'); });
  assert.deepEqual(store.task(project.id, task.id), before);
  assert.equal(store.output(old.id), undefined); assert.equal(controller.canInterrupt(old.id), false);
  assert.equal(store.readRun(project.id, task.id, old.id).diagnostic?.turn_id, 'historical-turn');
  assert.notEqual(fresh.worktree, old.worktree); assert.notEqual(fresh.branch, old.branch); assert.equal(fresh.parent_run_id, null);
  assert.equal(store.task(project.id, task.id).publication_status, 'unknown');
  assert.equal(store.task(project.id, task.id).pr_url, stopped.pr_url);
  store.recordProcess(task.id, { pid: 1234567, pgid: 1234567, started_at: 'test exit', state: 'exited', run_id: fresh.id });
  assert.equal(store.task(project.id, task.id).stop_unverified, 1, 'a new confirmed exit cannot verify unrelated legacy execution');
  assert.throws(() => store.beginPublication(project.id, task.id, before.state_version), /неизвестном исходе/);
});

test('live survivor keeps its slot after bounded Stop, preserves edits and queues fresh work behind global pause', async t => {
  const { store, project, directory, controller } = fixture(t);
  const task = store.createTask(project.id, 'Resistant execution', 1);
  const old = store.queueSpec(project.id, task.id, 1, directory);
  mkdirSync(old.worktree, { recursive: true }); writeFileSync(join(old.worktree, 'partial.txt'), 'keep partial edits');
  let pid = 0, ready!: () => void, freshStarted = false;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const nativeKill = process.kill.bind(process);
  t.after(() => { if (pid) { try { nativeKill(-pid, 'SIGKILL'); } catch {} } });
  t.mock.method(process, 'kill', (target: number, signal?: NodeJS.Signals | number) => target === -pid && signal !== 0 ? true : nativeKill(target, signal));
  t.mock.method(controller as any, 'perform', async (run: AgentRun) => {
    if (run.id !== old.id) { freshStarted = true; return; }
    run.status = 'running'; store.updateRun(run, 'spec', 'running');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    pid = child.pid!; child.stdout!.once('data', ready); await once(child, 'close');
  });
  controller.enqueue(old); await entered;
  store.pauseExecution(null);
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
  const started = Date.now(); await controller.deleteTask(task.id, true);
  assert.ok(Date.now() - started < 5000, 'card deadline includes census and signals');
  const stopped = store.task(project.id, task.id);
  assert.equal(stopped.stage, 'backlog'); assert.match(stopped.execution_warning!, /ещё работает/);
  assert.equal((controller as any).scheduler.isActive(task.id), true);
  assert.equal(store.executionProcesses(task.id).find(row => row.pid === pid)?.run_id, old.id);
  assert.ok(store.executionProcesses(task.id).find(row => row.pid === pid)?.started_at);
  assert.throws(() => controller.assertResultsResetIdle(task.id), /Процессы|callbacks/);
  const fresh = store.queueSpec(project.id, task.id, stopped.state_version, directory); controller.enqueue(fresh);
  assert.equal(freshStarted, false); assert.notEqual(fresh.worktree, old.worktree);
  assert.equal(readFileSync(join(old.worktree, 'partial.txt'), 'utf8'), 'keep partial edits');
  nativeKill(-pid, 'SIGKILL');
  await waitFor(() => !(controller as any).scheduler.isActive(task.id));
  assert.equal(freshStarted, false, 'pause still applies after survivor exits');
  store.resumeExecution(store.executionPause().state_version); controller.resume();
  await waitFor(() => freshStarted);
  assert.equal(store.runs()[0].status, 'interrupted'); assert.equal(store.runs().length, 2);
  pid = 0;
});

for (const reused of [false, true]) test(`restart ${reused ? 'rejects reused identity without signalling a foreign group' : 'recovers the live slot and stops its verified group'}`, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-stop-restart-')));
  const child = nativeSpawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  let store = new Store(directory), controller: SpecController | undefined;
  t.after(async () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} await controller?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput), task = store.createTask(project.id, 'Restart identity', 1);
  const run = store.queueSpec(project.id, task.id, 1, directory);
  const identity = processCensus().find(row => row.pid === child.pid)!;
  store.recordProcess(task.id, { ...identity, started_at: reused ? 'incorrect historical start' : identity.started_at, state: 'running', run_id: run.id });
  store.close(); store = new Store(directory);
  controller = new SpecController(store, directory, () => {});
  assert.equal((controller as any).scheduler.isActive(task.id), !reused);
  store.beginDeletion(project.id, task.id, store.rawTask(project.id, task.id).state_version);
  const sent: number[] = [], kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => { if (signal && signal !== 0) sent.push(pid); return kill(pid, signal); });
  await controller.deleteTask(task.id, true);
  assert.equal(store.task(project.id, task.id).stage, 'backlog');
  if (reused) {
    assert.deepEqual(sent, []); kill(child.pid!, 0);
    assert.equal(store.executionProcesses(task.id)[0].state, 'unknown');
    assert.match(store.task(project.id, task.id).execution_warning!, /не подтвержден/);
  } else {
    assert.ok(sent.includes(-child.pid!));
    assert.equal(store.executionProcesses(task.id)[0].state, 'exited');
    assert.equal(store.task(project.id, task.id).stop_unverified, 0);
  }
});

test('queued Stop request replay after restart cannot stop a new run or reset its lifecycle', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-stop-replay-')));
  let store = new Store(directory);
  const project = store.addProject(projectInput), task = store.createTask(project.id, 'Replay', 1);
  const old = store.queueSpec(project.id, task.id, 1, directory), requestId = randomUUID();
  const version = store.task(project.id, task.id).state_version;
  const fingerprint = JSON.stringify(['task.stop', project.id, task.id, version, null]);
  store.mutate(requestId, fingerprint, () => { const task = store.beginDeletion(project.id, old.task_id, version); return { stopping: true, generation: task.execution_generation }; });
  store.close();
  const origin = 'http://127.0.0.1:4317';
  const app = await createApp({ directory, origin, generateTitle: async () => 'Title' }); store = app.store;
  t.after(async () => { await app.app.close(); rmSync(directory, { recursive: true, force: true }); });
  store.pauseExecution(null);
  const stopped = store.task(project.id, task.id); assert.equal(stopped.stage, 'backlog'); assert.equal(stopped.run_state, 'idle');
  const fresh = store.queueSpec(project.id, task.id, stopped.state_version, directory);
  const before = store.task(project.id, task.id);
  const session = await app.app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token: app.token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const response = await app.app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks/${task.id}/stop`, headers, payload: { request_id: requestId, state_version: version } });
  assert.equal(response.statusCode, 200); assert.deepEqual(store.task(project.id, task.id), before); assert.equal(store.hasRun(fresh), true);
});

for (const boundary of ['before-push', 'during-push', 'during-create', 'during-confirmation'] as const) test(`Stop ${boundary} preserves remote receipts in old history without mutating new local state`, async t => {
  const { store, project, directory, controller } = fixture(t);
  const task = store.createTask(project.id, 'Remote boundary', 1), old = store.queueSpec(project.id, task.id, 1, directory);
  old.head_sha = 'approved-sha'; old.round_id = randomUUID();
  for (const id of [old.id, old.round_id]) saveArtifact(artifactDirectory(directory, id), 'result.json', JSON.stringify({ result: { summary: 'Checked' } }));
  store.db.prepare("UPDATE tasks SET publication_status = 'pending', publication_run_id = ? WHERE id = ?").run(old.id, task.id);
  let stopped = false, fresh: AgentRun | undefined;
  const stop = async () => {
    store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
    store.finishDeletion(task.id, undefined, true); store.releaseStoppedTask(project.id, task.id); stopped = true;
    fresh = store.queueSpec(project.id, task.id, store.task(project.id, task.id).state_version, directory);
    fresh.status = 'running'; store.updateRun(fresh, 'build', 'running');
  };
  const scope = new ProcessScope(undefined, undefined, () => store.hasRun(old));
  const operations: string[] = [], url = 'https://github.com/owner/repo/pull/2';
  const command = async (file: string, args: string[]) => {
    scope.check();
    if (args.includes('--slurp')) return '[[]]';
    if (args.includes('--push')) { if (boundary === 'before-push') await stop(); return project.remote_url; }
    if (file === 'git' && args[0] === 'push') { operations.push('push'); if (boundary === 'during-push') await stop(); return ''; }
    if (file === 'gh' && args[0] === 'pr') { operations.push('create'); if (boundary === 'during-create') await stop(); return url; }
    if (boundary === 'during-confirmation') await stop();
    return JSON.stringify({ number: 2, html_url: url, state: 'open', merged_at: null, head: { ref: old.branch, sha: old.head_sha, repo: { full_name: project.repository } }, base: { ref: project.target_branch, repo: { full_name: project.repository } }, body: `<!-- swfactory-task:${task.id} -->` });
  };
  await scope.run(async () => {
    try {
      const identity = await publishGithub(project, task, old, [], directory, command, async () => { checkExecution(); }, (operation, result) => {
        store.event('publication.remote-operation', task.id, { run_id: old.id, operation, result: result ?? 'in-flight', branch: old.branch });
        if (operation === 'pr-url') store.db.prepare('UPDATE tasks SET pr_url = ? WHERE id = ?').run(result, task.id);
        if (operation === 'pr-confirmed') store.finishPublication(old, JSON.parse(result!));
      });
      store.finishPublication(old, identity);
    } catch { store.finishPublication(old); }
  }, undefined, old.id);
  assert.equal(stopped, true); assert.ok(fresh);
  assert.deepEqual(operations, boundary === 'before-push' ? [] : boundary === 'during-push' ? ['push'] : ['push', 'create']);
  const current = store.task(project.id, task.id);
  assert.equal(current.stage, 'build'); assert.equal(current.run_state, 'running'); assert.equal(store.hasRun(fresh!), true);
  assert.equal(current.publication_status, boundary === 'during-confirmation' ? 'confirmed' : 'unknown');
  if (boundary === 'during-create' || boundary === 'during-confirmation') assert.equal(current.pr_url, url);
  assert.ok(store.events(0).filter(e => e.type === 'publication.remote-operation').every(e => JSON.parse(e.payload).run_id === old.id));
  assert.throws(() => store.beginPublication(project.id, task.id, current.state_version), /неизвестном исходе/);
  assert.equal(controller.error, null);
});

test('unknown publication from a stopped generation permits guidance and human answers in a fresh local cycle', async t => {
  const { store, project, directory, controller } = fixture(t);
  const task = store.createTask(project.id, 'Independent local work', 1);
  store.queueSpec(project.id, task.id, 1, directory);
  store.db.prepare("UPDATE tasks SET publication_status = 'unknown' WHERE id = ?").run(task.id);
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
  await controller.deleteTask(task.id, true);
  const fresh = store.queueSpec(project.id, task.id, store.task(project.id, task.id).state_version, directory);
  fresh.status = 'running'; store.updateRun(fresh, 'spec', 'running');
  controller.chat.add(project.id, task.id, store.task(project.id, task.id).state_version, 'Fresh guidance', 'guidance');
  controller.chat.control(fresh, async () => {}); await setImmediate();
  assert.equal(controller.chat.context(fresh)[0].text, 'Fresh guidance');
  fresh.status = 'completed'; fresh.outcome = 'NEEDS_INPUT';
  store.updateRun(fresh, 'needs-human', 'waiting', undefined, { outcome: 'NEEDS_INPUT', title: 'Local', summary: 'Question', requirements: [], acceptance_criteria: [], assumptions: [], out_of_scope: [], questions: [{ text: 'Choice?', context: 'Local work', impact: 'Implementation', options: [], required: true }] });
  const question = store.humanRequests().find(request => request.run_id === fresh.id)!;
  const answered = store.answer(project.id, task.id, question.id, store.task(project.id, task.id).state_version, ['Local choice']).run!;
  assert.equal(answered.worktree, fresh.worktree); assert.equal(answered.parent_run_id, fresh.id);
  assert.equal(store.task(project.id, task.id).publication_status, 'unknown');
});

test('stopped BLOCKED history cannot resume its preserved worktree through dependency continuation', async t => {
  const { store, project, directory, controller } = fixture(t);
  const task = store.createTask(project.id, 'Stopped dependency history', 1);
  const old = store.queueSpec(project.id, task.id, 1, directory, 'skip');
  old.status = 'completed'; old.outcome = 'BLOCKED'; store.updateRun(old, 'needs-human', 'interrupted');
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
  await controller.deleteTask(task.id, true);
  assert.throws(() => store.dependencyOrigin(project.id, task.id, store.task(project.id, task.id).state_version), /BLOCKED/);
});

test('restart finishes an accepted Stop and a new run never inherits the cancelled ProcessScope', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-stop-cancelled-scope-')));
  const child = nativeSpawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  let store = new Store(directory), controller: SpecController | undefined;
  t.after(async () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} await controller?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput), task = store.createTask(project.id, 'Interrupted Stop', 1);
  const old = store.queueSpec(project.id, task.id, 1, directory), identity = processCensus().find(row => row.pid === child.pid)!;
  store.recordProcess(task.id, { ...identity, state: 'running', run_id: old.id });
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version); store.close();
  store = new Store(directory); controller = new SpecController(store, directory, () => {});
  let started = false;
  t.mock.method(controller as any, 'perform', async () => { started = true; });
  const fresh = store.queueSpec(project.id, task.id, store.task(project.id, task.id).state_version, directory); controller.enqueue(fresh);
  await waitFor(() => started);
  assert.equal(store.hasRun(fresh), true); assert.equal(store.hasRun(old), false);
  assert.notEqual(fresh.worktree, old.worktree);
});

test('Stop during the final Review source check cannot advance a new attempt at the same stage and revision', async t => {
  const { store, project, directory, controller } = fixture(t);
  const task = store.createTask(project.id, 'Review callback race', 1);
  const old = store.queueSpec(project.id, task.id, 1, directory, 'skip');
  old.role = 'review-code'; old.round_id = old.id;
  store.db.prepare("UPDATE runs SET role = 'review-code', round_id = id WHERE id = ?").run(old.id);
  let verifies = 0, fresh: AgentRun | undefined;
  t.mock.method(controller as any, 'review', async () => ({ outcome: 'PASS', summary: 'Checked', findings: [], evidence: ['Inspected'], applicable: true, applicability: '', questions: [] }));
  t.mock.method(controller, 'verifyReviewSource', async () => {
    if (++verifies !== 2) return;
    store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
    store.finishDeletion(task.id, undefined, true); store.releaseStoppedTask(project.id, task.id);
    fresh = store.queueSpec(project.id, task.id, store.task(project.id, task.id).state_version, directory);
    fresh.status = 'running'; store.updateRun(fresh, 'review', 'running');
  });
  await (controller as any).owned(old, () => (controller as any).performReview(old));
  assert.ok(fresh); assert.equal(verifies, 2);
  assert.equal(store.task(project.id, task.id).stage, 'review');
  assert.equal(store.task(project.id, task.id).run_state, 'running');
  assert.equal(store.runs().length, 2); assert.equal(store.hasRun(fresh!), true);
});

test('an archived legacy deleted marker cannot bypass another Stop when execution is unknown', async t => {
  const { store, project, controller } = fixture(t);
  const task = store.createTask(project.id, 'Legacy archive', 1);
  store.db.prepare("UPDATE tasks SET archived = 1, deletion_state = 'deleted', stop_unverified = 1, legacy_execution_unknown = 1 WHERE id = ?").run(task.id);
  store.beginDeletion(project.id, task.id, 1);
  assert.equal(store.rawTask(project.id, task.id).deletion_state, 'stopping');
  await controller.deleteTask(task.id, true);
  const saved = store.rawTask(project.id, task.id);
  assert.equal(saved.archived, 1); assert.equal(saved.deletion_state, 'failed');
  assert.equal(saved.stop_unverified, 1); assert.match(saved.execution_warning!, /недостаточно/);
});

test('explicit start after Stop fetches current target into a real fresh worktree and leaves old partial edits intact', async t => {
  const { store, directory, controller } = fixture(t);
  const repo = join(directory, 'repo'), remote = join(directory, 'remote.git'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), 'original'); git('add', '.'); git('commit', '-m', 'original');
  git('init', '--bare', remote); git('remote', 'add', 'origin', remote); git('push', 'origin', 'main');
  const project = store.addProject({ ...projectInput, checkout: repo, common_dir: join(repo, '.git'), remote_url: remote });
  const task = store.createTask(project.id, 'Fresh local cycle', 1), old = store.queueSpec(project.id, task.id, 1, directory);
  old.base_sha = git('rev-parse', 'HEAD'); old.status = 'running'; store.updateRun(old, 'spec', 'running');
  mkdirSync(join(directory, 'worktrees', project.id), { recursive: true });
  git('worktree', 'add', '-b', old.branch, old.worktree, old.base_sha);
  writeFileSync(join(old.worktree, 'partial.txt'), 'uncommitted old edits');
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version); await controller.deleteTask(task.id, true);
  writeFileSync(join(repo, 'README.md'), 'current target'); git('add', '.'); git('commit', '-m', 'advance target'); git('push', 'origin', 'main');
  const target = git('rev-parse', 'HEAD');
  t.mock.method(controller as any, 'execute', async (input: { cwd: string }) => {
    assert.notEqual(input.cwd, old.worktree);
    assert.equal(readFileSync(join(input.cwd, 'README.md'), 'utf8'), 'current target');
    assert.equal(existsSync(join(input.cwd, 'partial.txt')), false);
    return { outcome: 'NEEDS_INPUT', title: 'Fresh requirements', summary: 'Local question', requirements: ['Keep task scope'], acceptance_criteria: ['Answer question'], assumptions: [], out_of_scope: [], questions: [{ text: 'Choice?', context: 'New cycle', impact: 'Implementation', options: [], required: true }] };
  });
  const fresh = store.queueSpec(project.id, task.id, store.task(project.id, task.id).state_version, directory); controller.enqueue(fresh);
  await waitFor(() => ['completed', 'failed'].includes(store.readRun(project.id, task.id, fresh.id).status));
  await controller.close();
  const saved = store.readRun(project.id, task.id, fresh.id);
  assert.equal(saved.status, 'completed', saved.error ?? ''); assert.equal(saved.base_sha, target);
  assert.equal(saved.parent_run_id, null); assert.notEqual(saved.branch, old.branch);
  assert.equal(readFileSync(join(old.worktree, 'partial.txt'), 'utf8'), 'uncommitted old edits');
  assert.equal(store.readRun(project.id, task.id, old.id).status, 'interrupted');
});
