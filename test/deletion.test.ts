import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { get } from 'node:http';
import { Store } from '../src/server/store.js';
import { SpecController } from '../src/server/spec.js';
import { Chat } from '../src/server/chat.js';
import { Scheduler } from '../src/server/scheduler.js';
import { ProcessScope, spawn, exec } from '../src/server/processes.js';
import { captureLogs } from './helpers/logging.js';
import { createApp } from '../src/server/app.js';
import type { AgentRun, Snapshot } from '../src/shared.js';

const origin = 'http://127.0.0.1:4317';
const projectInput = { checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github' as const, host: 'github.com', repository: 'owner/repo', target_branch: 'main' };
function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-delete-')));
  const store = new Store(directory);
  const project = store.addProject(projectInput);
  const controller = new SpecController(store, directory, () => {}, undefined, undefined, async () => 'Title');
  t.after(async () => { await controller.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, project, controller };
}
async function apiFixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-delete-api-'));
  const result = await createApp({ directory, origin, generateTitle: async () => 'Title' });
  const session = await result.app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token: result.token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const project = result.store.addProject(projectInput);
  t.after(async () => { await result.app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...result, project, directory, headers };
}

test('message history stays readable during Stop without allowing writes or bypassing ownership/auth', async t => {
  const { app, store, project, headers } = await apiFixture(t);
  const task = store.createTask(project.id, 'Keep message history', 1);
  const url = `/api/projects/${project.id}/tasks/${task.id}/messages`;
  const message = { request_id: randomUUID(), state_version: task.state_version, text: 'Saved guidance', kind: 'guidance' };
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: message })).statusCode, 200);
  store.beginDeletion(project.id, task.id, store.rawTask(project.id, task.id).state_version);
  const stopping = store.rawTask(project.id, task.id);
  const history = await app.inject({ url, headers });
  assert.equal(history.statusCode, 200);
  assert.equal(history.json()[0].text, message.text);
  assert.equal(history.json()[0].status, 'revoked');
  assert.equal(history.json()[0].error, 'Сообщение отозвано при остановке исполнения; доставка и применение запрещены.');
  assert.equal((await app.inject({ url: url.replace(project.id, randomUUID()), headers })).statusCode, 404);
  assert.equal((await app.inject({ url, headers: { ...headers, cookie: '' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...message, request_id: randomUUID(), state_version: stopping.state_version } })).statusCode, 409);
  assert.deepEqual(store.rawTask(project.id, task.id), stopping, 'history reads and rejected writes preserve Stop state');
  store.finishDeletion(task.id, undefined, true);
  store.releaseStoppedTask(project.id, task.id);
  assert.equal(store.rawTask(project.id, task.id).stage, 'backlog');
  assert.equal(store.rawTask(project.id, task.id).description, task.description);
  assert.equal(store.rawTask(project.id, task.id).revision, task.revision);
  const stopped = await app.inject({ url, headers });
  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(stopped.json(), history.json());
});

test('delete API checks ownership/version before side effects; concurrent requests replay once and preserve files/history', async t => {
  const { app, store, project, directory, headers } = await apiFixture(t);
  const task = store.createTask(project.id, 'Keep all files', 1);
  writeFileSync(join(directory, 'kept.txt'), 'history');
  const path = `/api/projects/${project.id}/tasks/${task.id}/delete`;
  const payload = { request_id: randomUUID(), state_version: task.state_version };
  const send = (data = payload, url = path) => app.inject({ method: 'POST', url, headers, payload: data });
  assert.equal((await send({ ...payload, state_version: 2 })).statusCode, 409);
  assert.equal((await send(payload, path.replace(project.id, randomUUID()))).statusCode, 404);
  assert.equal(store.rawTask(project.id, task.id).deletion_state, null);
  const results = await Promise.all([send(), send()]);
  assert.equal(results[0].statusCode, 200); assert.equal(results[0].json().deleted, true);
  assert.deepEqual(results[1].json(), results[0].json());
  assert.deepEqual((await send()).json(), results[0].json());
  assert.equal((await send({ ...payload, state_version: 2 })).statusCode, 409);
  assert.equal((await send({ ...payload, request_id: randomUUID() })).json().deleted, true);
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.events(0).filter(e => e.type === 'task.deleted').length, 1);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM task_revisions').get() as { n: number }).n, 1);
  assert.equal(existsSync(join(directory, 'kept.txt')), true);
  assert.throws(() => store.editTask(project.id, task.id, 'late', 1), /заблокированы/);
});

for (const state of ['idle', 'queued', 'running', 'waiting', 'interrupted', 'completed'] as const) test(`logical deletion preserves related history in state ${state}`, async t => {
  const { store, project, controller } = fixture(t);
  const task = store.createTask(project.id, 'Task', 1);
  const run = store.queueSpec(project.id, task.id, 1, '/tmp');
  run.status = 'completed'; run.outcome = 'NEEDS_INPUT';
  store.updateRun(run, 'needs-human', 'waiting', undefined, { title: 'Task', outcome: 'NEEDS_INPUT', summary: 'Question', requirements: [], acceptance_criteria: [], assumptions: [], out_of_scope: [], questions: [] });
  store.db.prepare('UPDATE tasks SET run_state = ?, stage = ?, publication_status = ?, pr_url = ? WHERE id = ?').run(state, state === 'completed' ? 'pr-created' : 'needs-human', state === 'completed' ? 'confirmed' : null, state === 'completed' ? 'https://github.com/owner/repo/pull/1' : null, task.id);
  store.db.prepare("INSERT INTO chat_messages (id, task_id, revision, kind, text, status) VALUES (?, ?, 1, 'requirements', 'Late requirement', 'queued')").run(randomUUID(), task.id);
  store.beginDeletion(project.id, task.id, store.rawTask(project.id, task.id).state_version);
  await controller.deleteTask(task.id);
  assert.equal(store.rawTask(project.id, task.id).deletion_state, 'deleted');
  assert.equal(store.runs().length, 1); assert.equal(store.humanRequests()[0].status, 'revoked');
  assert.equal(store.snapshot().human_requests.length, 0); assert.equal(store.snapshot().runs.length, 0);
  assert.equal((store.db.prepare('SELECT status FROM chat_messages').get() as { status: string }).status, 'revoked');
  store.finishTitle(task, 'Late'); store.updateRun(run, 'build', 'idle'); store.applyRequirements(task.id);
  assert.equal(store.rawTask(project.id, task.id).description, 'Task');
  assert.equal(store.snapshot().tasks.length, 0);
  if (state === 'completed') assert.equal(store.rawTask(project.id, task.id).pr_url, 'https://github.com/owner/repo/pull/1');
});

test('paused queue cancellation does not start the task and leaves other jobs runnable', async t => {
  const { store, project, controller } = fixture(t);
  store.pauseExecution(null);
  const a = store.createTask(project.id, 'A', 1), b = store.createTask(project.id, 'B', 1);
  const calls: string[] = [];
  t.mock.method(controller as any, 'perform', async (run: AgentRun) => { calls.push(run.task_id); });
  controller.enqueue(store.queueSpec(project.id, a.id, 1, '/tmp'));
  controller.enqueue(store.queueSpec(project.id, b.id, 1, '/tmp'));
  store.beginDeletion(project.id, a.id, store.rawTask(project.id, a.id).state_version);
  await controller.deleteTask(a.id);
  assert.deepEqual(calls, []);
  store.resumeExecution(store.executionPause().state_version); controller.resume(); await setImmediate();
  assert.deepEqual(calls, [b.id]);
});

test('controlled groups stop without reconciliation; other task keeps running', async t => {
  const { store, project, controller } = fixture(t);
  const task = store.createTask(project.id, 'Active', 1);
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  let pid = 0, descendant = 0;
  const other = store.createTask(project.id, 'Unrelated', 1);
  let releaseOther!: () => void, otherStarted = false;
  const otherBarrier = new Promise<void>(resolve => { releaseOther = resolve; });
  t.after(() => releaseOther());
  t.mock.method(controller as any, 'perform', async (run: AgentRun) => {
    if (run.task_id === other.id) { otherStarted = true; await otherBarrier; return; }
    const child = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore',detached:true});console.log(c.pid);setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
    pid = child.pid!;
    child.stdout!.once('data', chunk => { descendant = Number(String(chunk).trim()); ready(); });
    await once(child, 'close');
  });
  controller.enqueue(store.queueSpec(project.id, task.id, 1, '/tmp')); await started;
  controller.enqueue(store.queueSpec(project.id, other.id, 1, '/tmp'));
  await delay(100); assert.equal(otherStarted, true);
  store.beginDeletion(project.id, task.id, store.rawTask(project.id, task.id).state_version);
  assert.equal(store.snapshot().tasks.length, 2);
  await controller.deleteTask(task.id);
  assert.equal(store.rawTask(project.id, task.id).deletion_state, 'deleted');
  assert.equal(store.rawTask(project.id, task.id).stop_unverified, 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  assert.equal(store.snapshot().tasks[0].id, other.id);
  releaseOther();
});

for (const role of ['spec', 'title'] as const) test(`Stop after ${role} leader exits returns to Backlog without requiring proof about hypothetical orphans`, async t => {
  const { store, project, controller } = fixture(t);
  const task = store.createTask(project.id, 'Orphan regression', 1);
  let descendant = 0;
  const work = async () => {
    const child = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});console.log(c.pid);c.unref();`], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', chunk => { descendant = Number(String(chunk).trim()); });
    await once(child, 'close');
    return 'Title';
  };
  t.after(() => { if (descendant) { try { process.kill(-descendant, 'SIGKILL'); } catch {} } });
  if (role === 'spec') await (controller as any).owned(store.queueSpec(project.id, task.id, 1, '/tmp'), work);
  else {
    t.mock.method(controller.titles as any, 'generate', work);
    controller.titles.kick();
    for (let i = 0; i < 200 && store.rawTask(project.id, task.id).title_state !== 'completed'; i++) await delay(10);
    assert.equal(store.rawTask(project.id, task.id).title_state, 'completed');
  }
  assert.ok(descendant > 0);
  store.beginDeletion(project.id, task.id, store.rawTask(project.id, task.id).state_version);
  await controller.deleteTask(task.id, true);
  const stopped = store.task(project.id, task.id);
  assert.equal(stopped.stage, 'backlog'); assert.equal(stopped.run_state, 'idle'); assert.equal(stopped.archived, 0);
  const next = store.queueSpec(project.id, task.id, stopped.state_version, '/tmp');
  assert.equal(next.parent_run_id, null);
});

test('scope holds scheduler slot after leader exit until detached descendants end', async t => {
  const { app, log, lines } = captureLogs();
  t.after(() => app.close());
  const scope = new ProcessScope(undefined, log.child({ task_id: 'descendant-task' })), scheduler = new Scheduler();
  let childPid = 0, release!: () => void, releaseBlockers!: () => void;
  const started = new Promise<void>(resolve => { release = resolve; });
  const blockers = new Promise<void>(resolve => { releaseBlockers = resolve; });
  let leaderClosed = false, nextStarted = false;
  const job = scheduler.enqueue('a', () => scope.run(async () => {
    const child = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore'],detached:true});c.stdout.pipe(process.stdout);setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
    childPid = child.pid!; child.stdout!.once('data', release);
    await once(child, 'close'); leaderClosed = true;
  }, log.child({ task_id: 'descendant-task', run_id: 'descendant-run', role: 'build' })));
  const b = scheduler.enqueue('b', () => blockers), c = scheduler.enqueue('c', () => blockers);
  const next = scheduler.enqueue('d', async () => { nextStarted = true; });
  await started;
  const stop = scope.stop();
  await delay(100);
  assert.equal(leaderClosed, true, 'leader exits on TERM');
  assert.equal(nextStarted, false, 'slot remains occupied by the resistant descendant');
  await stop; await job; await next;
  assert.equal(nextStarted, true);
  const signals = lines.filter(line => line.event === 'process.signal-sent');
  assert.equal(new Set(signals.map(line => line.pgid)).size, 2, 'leader and detached descendant were signalled');
  for (const line of signals) {
    assert.equal(line.task_id, 'descendant-task'); assert.equal(line.run_id, 'descendant-run'); assert.equal(line.role, 'build');
  }
  assert.ok(lines.some(line => line.event === 'process.stop-confirmed' && line.run_id === 'descendant-run'));
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  assert.throws(() => scope.run(() => exec(process.execPath, ['-e', "throw Error('must not start')"], {})), /abort/i);
  releaseBlockers(); await Promise.all([b, c]); scheduler.close();
});

test('unconfirmed callback leaves card visible and blocked; a fresh delete succeeds after callback ends', async t => {
  const { store, project, controller } = fixture(t);
  const task = store.createTask(project.id, 'Unresponsive', 1);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(controller as any, 'perform', () => barrier);
  controller.enqueue(store.queueSpec(project.id, task.id, 1, '/tmp')); await setImmediate();
  store.beginDeletion(project.id, task.id, store.rawTask(project.id, task.id).state_version);
  await controller.deleteTask(task.id);
  assert.equal(store.rawTask(project.id, task.id).deletion_state, 'failed');
  assert.match(store.snapshot().tasks[0].deletion_error!, /не подтвержден/);
  assert.throws(() => store.queueSpec(project.id, task.id, 1, '/tmp'), /заблокированы/);
  release(); await setImmediate();
  store.beginDeletion(project.id, task.id, store.rawTask(project.id, task.id).state_version);
  await controller.deleteTask(task.id); assert.equal(store.snapshot().tasks.length, 0);
});

test('late chat acknowledgement cannot deliver revoked guidance or apply requirements', async t => {
  const { store, project, controller } = fixture(t);
  const task = store.createTask(project.id, 'Chat', 1), run = store.queueSpec(project.id, task.id, 1, '/tmp');
  const chat = new Chat(store, () => {});
  let ack!: () => void; const response = new Promise<void>(resolve => { ack = resolve; });
  chat.add(project.id, task.id, store.task(project.id, task.id).state_version, 'Guidance', 'guidance');
  chat.control(run, () => response);
  assert.equal(chat.messages(task.id)[0].status, 'sending');
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
  await controller.deleteTask(task.id); ack(); await setImmediate();
  chat.control(run, async () => { throw new Error('No new control'); }); chat.flush(task.id);
  assert.equal(chat.messages(task.id)[0].status, 'revoked'); assert.equal(store.snapshot().tasks.length, 0);
});

test('restart preserves deletion intent and refuses inferred process termination; audited human reconciliation enables deletion', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-delete-restart-'));
  let store = new Store(directory); const project = store.addProject(projectInput);
  const task = store.createTask(project.id, 'Restart', 1);
  const run = store.queueSpec(project.id, task.id, 1, '/tmp');
  store.db.prepare("UPDATE tasks SET execution_unverified = 1, publication_status = 'pending' WHERE id = ?").run(task.id);
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version); store.close();
  store = new Store(directory);
  const controller = new SpecController(store, directory, () => {});
  t.after(async () => { await controller.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.rawTask(project.id, task.id).deletion_state, null);
  await controller.deleteTask(task.id);
  assert.equal(store.snapshot().tasks.length, 1); assert.equal(store.rawTask(project.id, task.id).publication_status, 'unknown');
  const evidence = 'Human checked PID tree: no surviving processes. GitHub checked manually; existing branch retained.';
  store.beginDeletion(project.id, task.id, store.rawTask(project.id, task.id).state_version, evidence);
  await controller.deleteTask(task.id);
  assert.equal(store.snapshot().tasks.length, 0); assert.equal(store.runs()[0].id, run.id);
  assert.ok(store.events(0).some(e => e.type === 'task.stop-verified-by-human' && e.payload.includes(evidence)));
});

for (const version of [11, 12]) for (const history of ['title', 'edited-title', 'completed-run', 'failed-run']) test(`v${version} migration preserves unverified ${history} with an orphan`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-delete-upgrade-'));
  let store = new Store(directory);
  let controller: SpecController | undefined;
  let orphan = 0;
  t.after(async () => {
    if (orphan) { try { process.kill(-orphan, 'SIGKILL'); } catch {} }
    await controller?.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const project = store.addProject(projectInput);
  const task = store.createTask(project.id, 'Historical execution', 1);
  const untouched = store.createTask(project.id, 'Never executed', 1);
  if (history.endsWith('title')) {
    store.claimTitle(task); store.finishTitle(task, 'Completed title');
    if (history === 'edited-title') store.editTask(project.id, task.id, 'New description', task.state_version);
  } else {
    const run = store.queueSpec(project.id, task.id, 1, '/tmp');
    store.db.prepare("UPDATE runs SET status = ?, diagnostic = '{\"execution_finished\":true}' WHERE id = ?").run(history === 'completed-run' ? 'completed' : 'failed', run.id);
    store.db.prepare("UPDATE tasks SET run_state = 'idle', title_state = 'pending' WHERE id = ?").run(task.id);
  }
  const leader = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});console.log(c.pid);c.unref();`], { stdio: ['ignore', 'pipe', 'pipe'] });
  leader.stdout!.on('data', chunk => { orphan = Number(String(chunk).trim()); });
  await once(leader, 'close');
  assert.ok(orphan > 0); process.kill(orphan, 0);
  if (version === 11) {
    for (const column of ['deletion_state', 'deletion_error', 'execution_unverified', 'stop_unverified']) store.db.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
  }
  store.db.pragma(`user_version = ${version}`); store.close();
  store = new Store(directory);
  controller = new SpecController(store, directory, () => {}, undefined, undefined, async () => 'Title');
  assert.equal(store.rawTask(project.id, untouched.id).stop_unverified, 0);
  store.beginDeletion(project.id, task.id, store.rawTask(project.id, task.id).state_version);
  await controller.deleteTask(task.id);
  assert.equal(store.rawTask(project.id, task.id).deletion_state, 'failed');
  assert.equal(store.rawTask(project.id, task.id).stop_unverified, 1);
  process.kill(orphan, 0);
  process.kill(-orphan, 'SIGKILL');
  for (let i = 0; i < 200; i++) {
    try { process.kill(orphan, 0); } catch { break; }
    await delay(10);
  }
  assert.throws(() => process.kill(orphan, 0), { code: 'ESRCH' }); orphan = 0;
  store.beginDeletion(project.id, task.id, store.rawTask(project.id, task.id).state_version, 'Checked historical orphan: stopped; no remote publication.');
  await controller.deleteTask(task.id);
  assert.equal(store.rawTask(project.id, task.id).deletion_state, 'deleted');
  await controller.close(); controller = undefined; store.close();
  store = new Store(directory);
  assert.equal(store.db.pragma('user_version', { simple: true }), 22);
  assert.equal(store.rawTask(project.id, task.id).stop_unverified, 0, 'migration must not repeat after reconciliation');
});

test('v12 migration preserves an audited reconciliation and runs only once', t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-delete-audit-upgrade-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput);
  const task = store.createTask(project.id, 'Already verified', 1);
  store.claimTitle(task); store.finishTitle(task, 'Title');
  store.db.prepare("UPDATE tasks SET stop_unverified = 1, deletion_state = 'failed' WHERE id = ?").run(task.id);
  store.beginDeletion(project.id, task.id, task.state_version, 'Human verified no surviving processes or remote operations.');
  store.finishDeletion(task.id, 'Callback pending');
  store.db.pragma('user_version = 12'); store.close();
  store = new Store(directory);
  assert.equal(store.rawTask(project.id, task.id).stop_unverified, 0);
  const untouched = store.createTask(project.id, 'No execution', 1);
  store.close(); store = new Store(directory);
  assert.equal(store.rawTask(project.id, untouched.id).stop_unverified, 0, 'interrupted pending title is not historical execution on subsequent startup');
  assert.equal(store.rawTask(project.id, task.id).stop_unverified, 0);
});

for (const action of ['delete', 'archive']) test(`two independent SSE clients receive ${action} and removal snapshot`, async t => {
  const { app, store, project, headers } = await apiFixture(t);
  const task = store.createTask(project.id, 'Two tabs', 1);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const subscribe = () => {
    let ready!: () => void; const connected = new Promise<void>(resolve => { ready = resolve; });
    const removed = new Promise<void>((resolve, reject) => {
      let buffer = '', eventSeen = false;
      const req = get(`http://127.0.0.1:${address.port}/api/events`, { headers }, response => {
        response.on('data', chunk => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const entry = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = entry.match(/data: ([^\n]+)/)?.[1]; if (!data) continue;
            if (entry.includes('event: change') && JSON.parse(data).type === (action === 'archive' ? 'task.archived' : 'task.deleted')) eventSeen = true;
            if (entry.includes('event: snapshot')) {
              const snapshot: Snapshot = JSON.parse(data);
              if (snapshot.tasks.some(t => t.id === task.id)) ready();
              else if (eventSeen) { if (action === 'archive') assert.equal(snapshot.archived_tasks?.some(t => t.id === task.id), true); req.destroy(); resolve(); }
            }
          }
        });
      });
      req.on('error', reject); req.setTimeout(2000, () => { req.destroy(); reject(new Error('SSE timeout')); });
    });
    return { connected, removed };
  };
  const a = subscribe(), b = subscribe(); await Promise.all([a.connected, b.connected]);
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks/${task.id}/${action}`, headers, payload: { request_id: randomUUID(), state_version: 1 } });
  assert.equal(action === 'archive' ? response.json().archived : response.json().deleted, action === 'archive' ? 1 : true); await Promise.all([a.removed, b.removed]);
});

import { publishGithub } from '../src/server/publication.js';
import { artifactDirectory, saveArtifact } from '../src/server/artifacts.js';

for (const boundary of ['before-push', 'during-create', 'after-confirmation'] as const) test(`publication deletion boundary ${boundary} retains unknown/confirmed evidence and never retries remote mutation`, async t => {
  const { store, project, directory, controller } = fixture(t);
  const task = store.createTask(project.id, 'Publish', 1);
  const run = store.queueSpec(project.id, task.id, 1, '/tmp');
  run.head_sha = 'approved-sha'; run.round_id = randomUUID();
  for (const id of [run.id, run.round_id]) saveArtifact(artifactDirectory(directory, id), 'result.json', JSON.stringify({ result: { summary: 'Checked' } }));
  store.db.prepare("UPDATE tasks SET publication_status = 'pending' WHERE id = ?").run(task.id);
  const scope = new ProcessScope();
  const operations: string[] = [];
  let deleted = false;
  const begin = () => { store.beginDeletion(project.id, task.id, store.rawTask(project.id, task.id).state_version); deleted = true; };
  const url = 'https://github.com/owner/repo/pull/2';
  const command = async (file: string, args: string[], _cwd: string) => {
    if (args.includes('--slurp')) return '[[]]';
    if (args.includes('--push')) { if (boundary === 'before-push') { begin(); scope.controller.abort(); } return project.remote_url; }
    if (file === 'git' && args[0] === 'push') { operations.push('push'); return ''; }
    if (file === 'gh' && args[0] === 'pr') { operations.push('create'); if (boundary === 'during-create') { begin(); scope.controller.abort(); } return url; }
    return JSON.stringify({ number: 2, html_url: url, state: 'open', merged_at: null, head: { ref: run.branch, sha: run.head_sha, repo: { full_name: project.repository } }, base: { ref: project.target_branch, repo: { full_name: project.repository } }, body: `<!-- swfactory-task:${task.id} -->` });
  };
  let identity: { number: number; url: string } | undefined;
  await scope.run(async () => {
    try {
      identity = await publishGithub(project, task, run, [], directory, async (...args) => { scope.check(); return command(...args); }, async () => {
        scope.check(); if (deleted) throw new Error('Deleted');
      }, (operation, result) => {
        store.event('publication.remote-operation', task.id, { operation, result: result ?? 'unknown' });
        if (operation === 'pr-url') store.db.prepare('UPDATE tasks SET pr_url = ? WHERE id = ?').run(result, task.id);
      });
    } catch (error) { if (boundary === 'after-confirmation') throw error; }
    store.finishPublication(run, identity);
  });
  if (boundary === 'after-confirmation') begin();
  await controller.deleteTask(task.id);
  const saved = store.rawTask(project.id, task.id);
  assert.equal(saved.deletion_state, 'deleted');
  assert.deepEqual(operations, boundary === 'before-push' ? [] : ['push', 'create']);
  assert.equal(saved.publication_status, boundary === 'after-confirmation' ? 'confirmed' : 'unknown');
  if (boundary !== 'before-push') assert.equal(saved.pr_url, url);
  assert.throws(() => store.beginPublication(project.id, task.id, saved.state_version), /заблокированы/);
  await controller.deleteTask(task.id); assert.equal(operations.filter(op => op === 'create').length, boundary === 'before-push' ? 0 : 1);
});

test('late title result and human answer cannot revive a deleted task', async t => {
  const { store, project, controller } = fixture(t);
  const task = store.createTask(project.id, 'Late title', 1);
  let titleDone!: (value: string) => void;
  const titles = new (await import('../src/server/title.js')).Titles(store, () => {}, (_description, signal) => new Promise(resolve => {
    titleDone = resolve; signal.addEventListener('abort', () => resolve('Late completion'), { once: true });
  }));
  titles.kick(); await setImmediate();
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
  await titles.cancel(task.id); titleDone('Too late'); await setImmediate();
  await controller.deleteTask(task.id); await titles.close();
  assert.equal(store.rawTask(project.id, task.id).title, null);
  assert.equal(store.rawTask(project.id, task.id).deletion_state, 'deleted');
  assert.throws(() => store.answer(project.id, task.id, randomUUID(), 1, ['Late answer']), /заблокированы/);
  for (const action of [() => store.queueBuild(project.id, task.id, 1), () => store.retryRun(project.id, task.id, 1), () => store.queueRepair(project.id, task.id, 1), () => controller.chat.add(project.id, task.id, 1, 'Late', 'guidance')]) assert.throws(action, /заблокированы/);
});


test('an inaccessible process group is never treated as confirmed stopped', async t => {
  const scope = new ProcessScope();
  scope.track({ pid: 123456 } as import('node:child_process').ChildProcess);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  assert.equal(scope.knownGroupsStopped(), false);
});

test('archive hides an old NeedsHuman task without asserting stop, keeps history and protects mutations', async t => {
  const { app, store, project, headers } = await apiFixture(t);
  const task = store.createTask(project.id, 'Old NeedsHuman', 1);
  const run = store.queueSpec(project.id, task.id, 1, '/tmp');
  store.db.prepare("UPDATE tasks SET stage = 'needs-human', run_state = 'interrupted', deletion_state = 'failed', stop_unverified = 1 WHERE id = ?").run(task.id);
  const path = `/api/projects/${project.id}/tasks/${task.id}`;
  const payload = { request_id: randomUUID(), state_version: store.rawTask(project.id, task.id).state_version };
  const send = (url: string, data = payload) => app.inject({ method: 'POST', url, headers, payload: data });
  assert.equal((await send(path + '/archive', { ...payload, state_version: 999 })).statusCode, 409);
  assert.equal((await send(path.replace(project.id, randomUUID()) + '/archive')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: path + '/archive', headers: { host: headers.host, origin }, payload })).statusCode, 401);
  const response = await send(path + '/archive');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().archived, 1);
  const archivedEvent = store.events(0).find(event => event.type === 'task.archived' && event.task_id === task.id)!;
  assert.equal(JSON.parse(archivedEvent.payload).state_version, response.json().state_version, 'API and SSE carry the same archive notification key');
  assert.equal(store.snapshot().tasks.length, 0);
  await setImmediate();
  assert.equal(store.snapshot().archived_tasks?.[0].deletion_state, 'failed');
  assert.equal(store.rawTask(project.id, task.id).stop_unverified, 1);
  assert.deepEqual((await send(path + '/archive')).json(), response.json());
  assert.equal(store.events(0).filter(event => event.type === 'task.archived').length, 1);
  const history = await app.inject({ url: path + '/history', headers });
  assert.equal(history.statusCode, 200); assert.equal(history.json().runs[0].id, run.id);
  assert.equal(history.json().revisions[0].description, 'Old NeedsHuman');
  assert.equal((await app.inject({ url: path.replace(project.id, randomUUID()) + '/history', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: path + `/runs/${run.id}/output`, headers })).statusCode, 200);
  assert.equal((await app.inject({ url: path.replace(project.id, randomUUID()) + `/runs/${run.id}/output`, headers })).statusCode, 404);
  assert.throws(() => store.queueSpec(project.id, task.id, 1, '/tmp'), /заблокированы/);
  assert.throws(() => store.beginPublication(project.id, task.id, 1), /заблокированы/);
  const stop = await send(path + '/stop', { request_id: randomUUID(), state_version: store.rawTask(project.id, task.id).state_version });
  assert.equal(stop.json().deleted, false); assert.equal(store.snapshot().tasks.length, 0);
  const verified = await app.inject({ method: 'POST', url: path + '/stop', headers, payload: {
    request_id: randomUUID(), state_version: store.rawTask(project.id, task.id).state_version,
    reconciliation: 'Checked historical processes and remote result: all stopped.',
  } });
  assert.equal(verified.json().deleted, true);
  assert.equal(store.snapshot().archived_tasks?.[0].deletion_state, 'deleted');
  assert.equal(store.snapshot().tasks.length, 0);
});

test('archiving is durable before a pending callback stops and does not free its scheduler slot', async t => {
  const { store, project, controller } = fixture(t);
  const task = store.createTask(project.id, 'Active callback', 1);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(controller as any, 'perform', () => barrier);
  controller.enqueue(store.queueSpec(project.id, task.id, 1, '/tmp')); await setImmediate();
  store.db.transaction(() => store.archiveTask(project.id, task.id, store.rawTask(project.id, task.id).state_version))();
  const stopping = controller.deleteTask(task.id);
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.snapshot().archived_tasks?.[0].deletion_state, 'stopping');
  assert.equal((controller as any).scheduler.active.has(task.id), true);
  release(); await stopping;
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.snapshot().archived_tasks?.[0].deletion_state, 'deleted');
});

test('v14 migration exposes previously deleted history; failed cards archive explicitly and survive restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-archive-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput);
  const deleted = store.createTask(project.id, 'Previously deleted', 1);
  const failed = store.createTask(project.id, 'Old failed deletion', 1);
  store.db.prepare("UPDATE tasks SET deletion_state = 'deleted' WHERE id = ?").run(deleted.id);
  store.db.prepare("UPDATE tasks SET deletion_state = 'failed', stop_unverified = 1 WHERE id = ?").run(failed.id);
  store.db.exec('ALTER TABLE tasks DROP COLUMN archived; PRAGMA user_version = 13'); store.close();
  store = new Store(directory);
  assert.equal(store.snapshot().archived_tasks?.[0].id, deleted.id);
  assert.equal(store.snapshot().tasks[0].id, failed.id);
  store.archiveTask(project.id, failed.id, store.rawTask(project.id, failed.id).state_version);
  store.close(); store = new Store(directory);
  assert.equal(store.snapshot().tasks.length, 0);
  const saved = store.snapshot().archived_tasks!.find(task => task.id === failed.id)!;
  assert.equal(saved.deletion_state, 'failed'); assert.equal(saved.stop_unverified, 1);
});

import { GithubIssues } from '../src/server/issues.js';

function githubCard(store: Store, projectId: string) {
  store.importGithubIssue(projectId, { number: 1, title: 'Imported card', description: 'Original description', url: 'https://github.com/owner/repo/issues/1' });
  return store.snapshot().tasks.find(task => task.issue_number === 1)!;
}
async function syncCard(store: Store, controller: SpecController, matches: boolean) {
  const importer = new GithubIssues(store, () => {}, async args => JSON.stringify(args.at(-1)!.includes('?') ? [] : {
    number: 1, title: 'Remote title', body: 'Remote description', state: 'open', labels: matches ? ['ready-for-agent'] : [], html_url: 'https://github.com/owner/repo/issues/1',
  }), taskId => controller.deleteTask(taskId));
  importer.start(); await importer.settled(); await importer.close();
  assert.deepEqual(importer.errors, []);
}

test('legacy delete manually archives a restored card whose stop is already confirmed', async t => {
  const { app, store, project, headers } = await apiFixture(t);
  const task = githubCard(store, project.id);
  store.reconcileGithubIssue(project.id, 1, false, 'Removed label');
  store.finishDeletion(task.id);
  store.reconcileGithubIssue(project.id, 1, true, '');
  const payload = { request_id: randomUUID(), state_version: store.rawTask(project.id, task.id).state_version };
  const send = () => app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks/${task.id}/delete`, headers, payload });
  const response = await send();
  assert.equal(response.statusCode, 200); assert.equal(response.json().deleted, true);
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.snapshot().archived_tasks![0].archive_source, 'manual');
  assert.equal(store.reconcileGithubIssue(project.id, 1, true, ''), undefined);
  assert.deepEqual((await send()).json(), response.json());
  assert.equal(store.events(0).filter(event => event.type === 'task.archived').length, 2);
  assert.equal(store.revisions(project.id, task.id)[0].description, task.description);
});

test('legacy delete saves manual visibility atomically before stop and concurrent filter changes', async t => {
  const { app, store, project, headers } = await apiFixture(t);
  const task = githubCard(store, project.id);
  store.reconcileGithubIssue(project.id, 1, false, 'Removed label');
  store.reconcileGithubIssue(project.id, 1, true, '');
  let entered!: () => void, release!: () => void;
  const stopping = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(SpecController.prototype, 'deleteTask', async (id: string) => {
    assert.equal(id, task.id); entered(); await barrier; store.finishDeletion(id);
  });
  const payload = { request_id: randomUUID(), state_version: store.rawTask(project.id, task.id).state_version };
  const response = app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks/${task.id}/delete`, headers, payload }).then(value => value);
  await stopping;
  try {
    assert.equal(store.snapshot().tasks.length, 0);
    assert.equal(store.rawTask(project.id, task.id).archive_source, 'manual');
    const cursor = store.snapshot().cursor;
    for (const matches of [false, true, false, true]) {
      const importer = new GithubIssues(store, () => {}, async args => JSON.stringify(args.at(-1)!.includes('?') ? [] : {
        number: 1, title: 'Remote title', body: 'Remote description', state: 'open', labels: matches ? ['ready-for-agent'] : [], html_url: task.issue_url,
      }));
      importer.start(); await importer.settled(); await importer.close();
      assert.deepEqual(importer.errors, []);
      assert.equal(store.snapshot().tasks.length, 0);
      assert.equal(store.rawTask(project.id, task.id).archive_source, 'manual');
      assert.equal(store.snapshot().cursor, cursor);
    }
  } finally { release(); await response; }
  assert.equal((await response).json().deleted, true);
  assert.equal(store.snapshot().archived_tasks![0].deletion_state, 'deleted');
  assert.equal(store.rawTask(project.id, task.id).archive_source, 'manual');
});

for (const state of ['backlog', 'local-edit', 'queued', 'running', 'needs-human', 'completed'] as const) test(`filter archive stops ${state}, restores without running and retains results`, async t => {
  const { store, project, controller, directory } = fixture(t);
  const task = githubCard(store, project.id);
  let run: AgentRun | undefined;
  if (state === 'local-edit') store.editTask(project.id, task.id, 'Local description', task.state_version);
  if (['queued', 'running', 'needs-human', 'completed'].includes(state)) {
    run = store.queueSpec(project.id, task.id, task.state_version, directory);
    if (state === 'needs-human' || state === 'completed') {
      run.status = 'completed'; run.outcome = state === 'completed' ? 'READY' : 'NEEDS_INPUT'; run.report = 1;
      store.updateRun(run, state === 'completed' ? 'pr-created' : 'needs-human', state === 'completed' ? 'completed' : 'waiting', undefined,
        { title: task.title!, outcome: run.outcome as 'READY' | 'NEEDS_INPUT', summary: 'Saved result', requirements: [], acceptance_criteria: [], assumptions: [], out_of_scope: [], questions: [] });
    }
  }
  store.db.prepare("INSERT INTO chat_messages(id, task_id, revision, kind, text, status) VALUES (?, ?, 1, 'guidance', 'Do not redeliver', 'queued')").run(randomUUID(), task.id);
  const before = store.rawTask(project.id, task.id), revisions = store.revisions(project.id, task.id);
  const preserved = store.runs();
  let started = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(controller as any, 'perform', async (value: AgentRun) => {
    started++;
    value.status = 'running'; store.updateRun(value, 'spec', 'running');
    await barrier;
    value.status = 'completed'; value.outcome = 'READY'; store.updateRun(value, 'build', 'idle');
    if (!store.blocked(task.id)) throw new Error('Pipeline must remain blocked');
  });
  if (state === 'queued') { store.pauseExecution(null); controller.enqueue(run!); }
  if (state === 'running') { controller.enqueue(run!); await setImmediate(); }
  await syncCard(store, controller, false);
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.snapshot().archived_tasks![0].id, task.id);
  assert.equal(store.rawTask(project.id, task.id).description, before.description);
  assert.deepEqual(store.revisions(project.id, task.id), revisions);
  assert.equal(controller.chat.messages(task.id)[0].status, 'revoked');
  if (state === 'running') {
    assert.equal((controller as any).scheduler.active.has(task.id), true);
    assert.equal(store.rawTask(project.id, task.id).deletion_state, 'stopping');
    await syncCard(store, controller, true);
    assert.equal(store.snapshot().tasks[0].id, task.id);
    assert.equal(store.rawTask(project.id, task.id).deletion_state, 'stopping');
    assert.throws(() => store.queueSpec(project.id, task.id, store.rawTask(project.id, task.id).state_version, directory), /заблокированы/);
    release(); await controller.deleteTask(task.id);
    assert.equal(store.snapshot().tasks[0].id, task.id, 'late stop must not archive the restored card');
    assert.equal(store.runs()[0].status, 'interrupted'); assert.equal(store.runs()[0].outcome, null);
    assert.equal(started, 1);
  } else {
    await controller.deleteTask(task.id);
    await syncCard(store, controller, true);
    assert.equal(store.snapshot().tasks[0].id, task.id);
    if (state === 'queued') {
      store.resumeExecution(store.executionPause().state_version); controller.resume(); await setImmediate();
      assert.equal(store.runs()[0].status, 'interrupted');
    }
    if (state === 'needs-human') assert.equal(store.humanRequests()[0].status, 'revoked');
    if (state === 'completed' || state === 'needs-human') {
      assert.deepEqual(store.runs(), preserved.map(run => ({ ...run, revoked: 1 })));
      assert.equal(store.snapshot().runs[0].report, 1, 'restored blocked card exposes saved reports');
    }
    if (state === 'completed') assert.equal(store.rawTask(project.id, task.id).run_state, 'completed');
    assert.equal(started, 0);
  }
  assert.equal(store.rawTask(project.id, task.id).description, before.description);
  assert.equal(store.runs().length, preserved.length);
  assert.equal(controller.chat.messages(task.id)[0].status, 'revoked');
});

for (const state of ['queued', 'running', 'needs-human'] as const) test(`restored ${state} card permits an explicit new Spec after verified stop without resuming old work`, async t => {
  const { app, store, project, headers } = await apiFixture(t);
  store.pauseExecution(null);
  const task = githubCard(store, project.id);
  const original = store.queueSpec(project.id, task.id, 1, '/tmp');
  if (state === 'running') {
    original.status = 'running'; store.updateRun(original, 'spec', 'running');
    store.db.prepare('UPDATE tasks SET stop_unverified = 1, execution_unverified = 1 WHERE id = ?').run(task.id);
  }
  if (state === 'needs-human') {
    original.status = 'completed'; original.outcome = 'NEEDS_INPUT'; original.report = 1;
    store.updateRun(original, 'needs-human', 'waiting', undefined,
      { title: 'Saved title', outcome: 'NEEDS_INPUT', summary: 'Saved questions', requirements: [], acceptance_criteria: [], assumptions: [], out_of_scope: [], questions: [] });
  }
  store.reconcileGithubIssue(project.id, 1, false, 'Removed label');
  store.finishDeletion(task.id, state === 'running' ? 'Unknown processes' : undefined);
  store.reconcileGithubIssue(project.id, 1, true, '');
  const path = `/api/projects/${project.id}/tasks/${task.id}`;
  const post = (action: string, payload: object) => app.inject({ method: 'POST', url: path + action, headers, payload });
  const blocked = store.rawTask(project.id, task.id);
  assert.equal((await post('/start', { request_id: randomUUID(), state_version: blocked.state_version })).statusCode, 409);
  if (state === 'running') {
    store.releaseStoppedTask(project.id, task.id);
    assert.equal(store.rawTask(project.id, task.id).deletion_state, null);
  }
  const payload = { request_id: randomUUID(), state_version: store.rawTask(project.id, task.id).state_version,
    ...(state === 'running' ? { reconciliation: 'Checked processes and sessions: all stopped; no remote publication.' } : {}) };
  const stop = await post('/stop', payload);
  assert.equal(stop.statusCode, 200); assert.equal(stop.json().deleted, true);
  const ready = store.rawTask(project.id, task.id);
  assert.equal(ready.deletion_state, null); assert.equal(ready.stage, 'backlog'); assert.equal(ready.run_state, 'idle');
  const history = store.runs();
  assert.equal(history.length, 1); assert.equal(history[0].id, original.id);
  assert.equal(history[0].status, state === 'needs-human' ? 'completed' : 'interrupted');
  if (state === 'needs-human') {
    assert.equal(history[0].outcome, 'NEEDS_INPUT'); assert.equal(history[0].report, 1);
    assert.equal(store.humanRequests()[0].status, 'revoked');
  }
  assert.deepEqual((await post('/stop', payload)).json(), stop.json());
  assert.deepEqual(store.rawTask(project.id, task.id), ready, 'request replay cannot reset the new lifecycle');
  const start = await post('/start', { request_id: randomUUID(), state_version: ready.state_version });
  assert.equal(start.statusCode, 200);
  assert.notEqual(start.json().id, original.id); assert.notEqual(start.json().worktree, original.worktree);
  assert.equal(start.json().parent_run_id, null); assert.equal(start.json().status, 'queued');
  assert.deepEqual(store.runs()[0], history[0], 'new run preserves the old result and interruption');
});

for (const publication of ['pending', 'unknown', 'confirmed', null]) test(`publication-only stop API preserves visibility and remote safety: ${publication}`, async t => {
  const { app, store, project, headers } = await apiFixture(t);
  const task = store.createTask(project.id, 'Publication verification', 1);
  store.db.prepare("UPDATE tasks SET title_state = 'completed', publication_status = ? WHERE id = ?").run(publication, task.id);
  const before = store.rawTask(project.id, task.id);
  const path = `/api/projects/${project.id}/tasks/${task.id}`;
  const payload = { request_id: randomUUID(), state_version: before.state_version };
  const post = (suffix: string, body = payload) => app.inject({ method: 'POST', url: path + suffix, headers, payload: body });
  const response = await post('/stop');
  assert.equal(response.statusCode, 200); assert.equal(response.json().deleted, true);
  if (publication === 'pending' || publication === 'unknown') assert.match(response.json().warning, /Remote операция/);
  else assert.equal(response.json().warning, null);
  const after = store.rawTask(project.id, task.id);
  assert.equal(after.archived, 0); assert.equal(after.archive_source, null); assert.equal(after.deletion_state, null);
  assert.equal(after.publication_status, publication === 'pending' ? 'unknown' : publication); assert.ok(after.state_version > before.state_version);
  assert.equal(after.stage, 'backlog'); assert.equal(after.run_state, 'idle');
  assert.equal(store.events(0).filter(event => event.type === 'task.archived').length, 0);
  assert.deepEqual((await post('/stop')).json(), response.json());
  assert.deepEqual(store.rawTask(project.id, task.id), after);
  const reset = await post('/reset-results', { request_id: randomUUID(), state_version: after.state_version });
  assert.equal(reset.statusCode, publication === 'confirmed' ? 200 : 409);
  if (publication === 'confirmed') return;
  assert.deepEqual(store.rawTask(project.id, task.id), after);
  assert.throws(() => store.beginPublication(project.id, task.id, after.state_version), /неизвестном исходе/);
});

test('restored card permits stop/reconciliation without re-archiving, preserves unknown publication and replays requests', async t => {
  const { app, store, project, headers } = await apiFixture(t);
  const task = githubCard(store, project.id);
  const run = store.queueSpec(project.id, task.id, 1, '/tmp');
  store.db.prepare("UPDATE tasks SET execution_unverified = 1, stop_unverified = 1, publication_status = 'pending' WHERE id = ?").run(task.id);
  store.reconcileGithubIssue(project.id, 1, false, 'Removed label');
  store.finishDeletion(task.id, 'Unknown processes');
  store.reconcileGithubIssue(project.id, 1, true, '');
  const path = `/api/projects/${project.id}/tasks/${task.id}`;
  const stop = (payload: object) => app.inject({ method: 'POST', url: path + '/stop', headers, payload });
  assert.equal((await stop({ request_id: randomUUID(), state_version: 1 })).statusCode, 409);
  assert.equal((await stop({ request_id: randomUUID(), state_version: store.rawTask(project.id, task.id).state_version })).json().deleted, false);
  assert.equal(store.rawTask(project.id, task.id).archived, 0);
  const payload = { request_id: randomUUID(), state_version: store.rawTask(project.id, task.id).state_version,
    reconciliation: 'Human verified processes stopped; checked remote publication, result remains unknown.' };
  const response = await stop(payload);
  assert.equal(response.statusCode, 200); assert.equal(response.json().deleted, true);
  assert.deepEqual((await stop(payload)).json(), response.json());
  const restored = store.rawTask(project.id, task.id);
  assert.equal(restored.archived, 0); assert.equal(restored.deletion_state, null);
  assert.equal(restored.stop_unverified, 0); assert.equal(restored.execution_unverified, 0);
  assert.equal(restored.publication_status, 'unknown');
  assert.equal(store.runs()[0].id, run.id); assert.equal(store.runs()[0].status, 'interrupted');
  assert.throws(() => store.beginPublication(project.id, task.id, restored.state_version), /неизвестном исходе/);
  assert.equal(store.events(0).filter(e => e.type === 'task.archived').length, 1);
});
