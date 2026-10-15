import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn as nativeSpawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { Scheduler } from '../src/server/scheduler.js';
import { ProcessScope, spawn } from '../src/server/processes.js';
import { captureLogs } from './helpers/logging.js';

const origin = 'http://127.0.0.1:4317';

test('HTTP completion uses route template and server ID; query, headers, bodies and errors never reach logs', async t => {
  const capture = captureLogs();
  const directory = mkdtempSync(join(tmpdir(), 'factory-logging-'));
  const secret = 'plain-environment-credential';
  const previous = process.env.TEST_API_KEY;
  process.env.TEST_API_KEY = secret;
  const { app, token } = await createApp({ directory, origin, logStream: capture.stream });
  t.after(async () => {
    await app.close(); await capture.app.close(); rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.TEST_API_KEY; else process.env.TEST_API_KEY = previous;
  });
  const headers = { host: '127.0.0.1:4317', origin, authorization: `Bearer ${secret}`, 'x-request-id': secret };
  const session = await app.inject({ method: 'POST', url: '/api/session', headers, payload: { token } });
  const cookie = String(session.headers['set-cookie']).split(';')[0];
  const taskId = randomUUID(), projectId = randomUUID(), requestId = randomUUID();
  await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/tasks/${taskId}?secret=${secret}`, headers: { ...headers, cookie },
    payload: { request_id: requestId, state_version: 1, description: 'PRIVATE DESCRIPTION' } });
  await app.inject({ url: `/api/snapshot?secret=${secret}`, headers }); // unauthenticated
  await app.inject({ method: 'POST', url: '/api/session', headers, payload: { token: secret, extra: 'PRIVATE BODY' } }); // validation
  await app.inject({ url: `/unknown/${secret}?prompt=PRIVATE`, headers });
  // Defence against Fastify/Pino automatic error/message serializers and child bindings.
  app.log.error({ msg: 'PRIVATE PROMPT', message: 'PRIVATE ERROR' });
  app.log.error({ err: Object.assign(new Error('PRIVATE PROMPT'), { cmd: secret, stderr: 'PRIVATE OUTPUT' }), req: { headers }, body: secret }, secret);
  app.log.child({ project_id: secret, config: { secret } }).info({ event: 'redaction.check', reason: secret, prompt: 'PRIVATE PROMPT' });
  const lines = capture.lines;
  const completed = lines.filter(line => line.event === 'http.completed');
  assert.equal(completed.length, 5);
  const edited = completed.find(line => line.method === 'PATCH')!;
  assert.equal(edited.route, '/api/projects/:projectId/tasks/:taskId');
  assert.equal(edited.status, 404); assert.equal(edited.reason, 'http_404');
  assert.equal(edited.project_id, projectId); assert.equal(edited.task_id, taskId); assert.equal(edited.request_id, requestId);
  assert.equal(typeof edited.duration_ms, 'number'); assert.equal(typeof edited.http_request_id, 'string');
  assert.notEqual(edited.http_request_id, requestId); assert.match(String(edited.http_request_id), /^req-/);
  assert.ok(lines.some(line => line.event === 'http.rejected' && line.reason === 'validation'));
  assert.ok(completed.some(line => line.status === 401));
  assert.ok(lines.some(line => line.event === 'redaction.check' && line.reason === '[REDACTED]' && line.project_id === '[REDACTED]'));
  const output = JSON.stringify(lines);
  for (const forbidden of [secret, token, cookie, 'PRIVATE', 'authorization', 'stderr', 'stack']) assert.ok(!output.includes(forbidden), forbidden);
});

test('scheduler reports capacity, same-task and rate-limit blocking without polling spam; records queue wait', async () => {
  const { app, log, lines } = captureLogs();
  let available = true;
  const scheduler = new Scheduler(() => available, log, () => 'rate_limit');
  const releases: (() => void)[] = [];
  const work = () => new Promise<void>(resolve => releases.push(resolve));
  const jobs = [scheduler.enqueue('one', work), scheduler.enqueue('two', work), scheduler.enqueue('three', work)];
  jobs.push(scheduler.enqueue('four', async () => {}));
  assert.ok(lines.some(line => line.event === 'scheduler.changed' && line.reason === 'capacity' && line.active === 3 && line.queued === 1 && line.limit === 3));
  releases.forEach(release => release()); await Promise.all(jobs);
  assert.ok(lines.some(line => line.task_id === 'four' && line.event === 'job.started' && typeof line.queue_wait_ms === 'number'));
  const first = scheduler.enqueue('same', work), second = scheduler.enqueue('same', async () => {});
  assert.ok(lines.some(line => line.event === 'scheduler.changed' && line.reason === 'task_active'));
  releases.at(-1)!(); await Promise.all([first, second]);
  available = false;
  const paused = scheduler.enqueue('paused', async () => {});
  const cancelled = scheduler.enqueue('cancelled', async () => {});
  scheduler.cancel('cancelled'); await cancelled;
  assert.equal(lines.filter(line => line.event === 'scheduler.changed').at(-1)?.reason, 'rate_limit');
  const count = lines.filter(line => line.event === 'scheduler.changed').length;
  await delay(550);
  assert.equal(lines.filter(line => line.event === 'scheduler.changed').length, count);
  assert.ok(lines.some(line => line.reason === 'rate_limit' && line.queued === 1));
  available = true; scheduler.wake(); await paused;
  scheduler.close(); await app.close();
});

test('process logs distinguish stop request, leader exit, confirmed group stop and unknown stop without raw error', async t => {
  const { app, log, lines } = captureLogs();
  const scope = new ProcessScope(undefined, log.child({ task_id: 'process-task' }));
  let role = 'spec';
  const job = scope.run(async () => {
    role = 'build';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'close');
  }, () => log.child({ task_id: 'process-task', run_id: 'process-run', role }));
  await scope.stop(); await job;
  const started = lines.find(line => line.event === 'process.started')!;
  assert.equal(started.run_id, 'process-run'); assert.equal(started.role, 'build');
  assert.equal(typeof started.pid, 'number'); assert.equal(started.pid, started.pgid);
  assert.ok(lines.some(line => line.event === 'process.stop-requested'));
  assert.ok(lines.some(line => line.event === 'process.signal-sent'));
  assert.ok(lines.some(line => line.event === 'process.exited' && line.run_id === 'process-run'));
  assert.ok(lines.some(line => line.event === 'process.stop-confirmed' && line.execution_finished === true));
  const unknown = new ProcessScope(undefined, log);
  t.mock.method(unknown as any, 'discoverDescendantGroups', async () => { throw new Error('PRIVATE PROMPT api_key=credential'); });
  await assert.rejects(unknown.stop());
  assert.ok(lines.some(line => line.event === 'process.stop-unknown' && line.execution_finished === false));
  assert.ok(!JSON.stringify(lines).includes('PRIVATE PROMPT'));
  await app.close();
});

test('main keeps bootstrap URL on stderr, stdout is JSON and SIGTERM drains shutdown logs', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-main-logging-'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const child = nativeSpawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
    env: { ...process.env, LOG_LEVEL: 'info', PORT: String(port), SWFACTORY_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); });
  for (let i = 0; i < 200 && !stderr.includes('#token=') && child.exitCode === null; i++) await delay(20);
  assert.match(stderr, /SW Factory: http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/);
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  const lines = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(lines.some(line => line.event === 'backend.started'));
  assert.ok(lines.some(line => line.event === 'backend.shutdown-started'));
  assert.ok(lines.some(line => line.event === 'backend.shutdown-finished'));
  assert.ok(!stdout.includes('#token=')); assert.ok(!stdout.includes(stderr.match(/#token=([a-f0-9]+)/)![1]));
});


test('LOG_LEVEL overrides info default without a transport', async () => {
  const previous = process.env.LOG_LEVEL;
  try {
    delete process.env.LOG_LEVEL;
    const normal = captureLogs();
    assert.equal(normal.log.level, 'info'); await normal.app.close();
    process.env.LOG_LEVEL = 'error';
    const capture = captureLogs();
    capture.log.info({ event: 'invisible' }); capture.log.error({ event: 'visible' });
    assert.deepEqual(capture.lines.map(line => line.event), ['visible']);
    await capture.app.close();
  } finally { if (previous === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = previous; }
});
