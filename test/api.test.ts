import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { get } from 'node:http';
import { artifactDirectory } from '../src/server/artifacts.js';
import { SpecController } from '../src/server/spec.js';
import { createApp } from '../src/server/app.js';
import type { Project, Task } from '../src/shared.js';

const origin = 'http://127.0.0.1:4317';
async function fixture(t: { after: (fn: () => Promise<void>) => void }, generate?: (description: string, signal: AbortSignal) => Promise<string>) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-api-'));
  const result = await createApp({ directory, origin, generateTitle: generate ?? (async (_description, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); })), inspect: async input => ({ ...input, common_dir: `${input.checkout}/.git`, remote_url: 'git@github.com:owner/repo.git', host: 'github.com', repository: 'owner/repo' }) });
  t.after(async () => { await result.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await result.app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token: result.token } });
  assert.equal(session.statusCode, 200);
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const projectResponse = await result.app.inject({ method: 'POST', url: '/api/projects', headers, payload: { request_id: randomUUID(), state_version: 0, checkout: '/repo', remote: 'origin', target_branch: 'main', hosting: 'github' } });
  assert.equal(projectResponse.statusCode, 200);
  return { ...result, directory, headers, project: projectResponse.json<Project>() };
}

test('description, immutable revisions, replay, ownership, stale state and allowed transition', async t => {
  const { app, store, headers, project } = await fixture(t);
  const url = `/api/projects/${project.id}/tasks`;
  const payload = { request_id: randomUUID(), state_version: 1, description: '  <script>alert(1)</script>\nТочное описание  ' };
  const created = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(created.statusCode, 200);
  const task = created.json<Task>();
  assert.equal(task.description, payload.description);
  assert.equal(task.title, null);
  assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload })).json(), task);
  assert.equal(store.snapshot().tasks.length, 1);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, description: 'different' } })).statusCode, 409);
  const edit = { request_id: randomUUID(), state_version: 1, description: '  редакция 2\n' };
  const edited = await app.inject({ method: 'PATCH', url: `${url}/${task.id}`, headers, payload: edit });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json<Task>().revision, 2);
  assert.equal((await app.inject({ method: 'PATCH', url: `${url}/${task.id}`, headers, payload: { ...edit, request_id: randomUUID() } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/${randomUUID()}/tasks/${task.id}`, headers, payload: edit })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/${randomUUID()}/tasks/${task.id}`, headers, payload: { ...edit, request_id: randomUUID() } })).statusCode, 404);
  const revisions = (await app.inject({ url: `${url}/${task.id}/revisions`, headers })).json();
  assert.deepEqual(revisions.map((r: { description: string }) => r.description), [payload.description, edit.description]);
  store.db.prepare("UPDATE tasks SET stage = 'spec' WHERE id = ?").run(task.id);
  assert.equal((await app.inject({ method: 'PATCH', url: `${url}/${task.id}`, headers, payload: { ...edit, request_id: randomUUID(), state_version: 2 } })).statusCode, 409);
  assert.equal(store.events(0).filter(e => !e.type.startsWith('title.')).length, 3);
});

test('validation, CSRF, Host, authentication, duplicate project and absent filesystem endpoints', async t => {
  const { app, headers, project } = await fixture(t);
  assert.equal((await app.inject({ url: '/api/snapshot', headers: { host: '127.0.0.1:4317' } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/snapshot', headers: { ...headers, origin: 'https://evil.test' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/snapshot', headers: { ...headers, host: 'evil.test' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/session', headers, payload: { token: 'bad' } })).statusCode, 401);
  const payload = { request_id: randomUUID(), state_version: 1, description: 'hello' };
  const url = `/api/projects/${project.id}/tasks`;
  assert.equal((await app.inject({ method: 'POST', url, headers: { host: headers.host, cookie: headers.cookie }, payload })).statusCode, 403);
  for (const bad of [{ ...payload, description: ' \n ' }, { ...payload, state_version: '1' }, { ...payload, extra: true }, { ...payload, request_id: 'bad' }]) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: bad })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, state_version: 2 } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { request_id: randomUUID(), state_version: 0, checkout: '/repo', remote: 'origin', target_branch: 'main', hosting: 'github' } })).statusCode, 409);
  assert.equal((await app.inject({ url: '/api/artifacts/../../etc/passwd', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/events', headers: { ...headers, 'last-event-id': 'NaN' } })).statusCode, 400);
});

test('SSE reconnect replays missed events, snapshots and live changes', async t => {
  const { app, headers, store, project } = await fixture(t);
  const task = store.mutate('create', 'create', () => store.createTask(project.id, 'SSE test', 1)) as Task;
  const run = store.queueSpec(project.id, task.id, 1, '/tmp');
  run.status = 'running'; store.updateRun(run, 'spec', 'running');
  store.recordOutput(run, 'First output');
  // A separate editable task triggers the existing publish path during the live update.
  const editable = store.createTask(project.id, 'Edit trigger', 1);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const text = await new Promise<string>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${address.port}/api/events`, { headers: { ...headers, 'last-event-id': '1' } }, response => {
      assert.equal(response.statusCode, 200);
      let data = '', edited = false;
      response.on('data', chunk => {
        data += chunk;
        if (data.includes('event: snapshot') && !edited) {
          edited = true;
          store.recordOutput(run, 'Second output');
          void app.inject({ method: 'PATCH', url: `/api/projects/${project.id}/tasks/${editable.id}`, headers,
            payload: { request_id: randomUUID(), state_version: 1, description: 'live edit' },
          }).then(result => { assert.equal(result.statusCode, 200); }).catch(reject);
        }
        if (data.includes('task.edited') && data.includes('live edit')) { resolve(data); request.destroy(); }
      });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => { request.destroy(); reject(new Error('SSE timeout')); });
  });
  assert.match(text, /event: change/);
  assert.match(text, /task.created/);
  assert.match(text, /event: snapshot/);
  assert.ok(text.includes(task.id));
  assert.match(text, /task.edited/);
  assert.match(text, /live edit/);
  assert.match(text, /First output/);
  assert.match(text, /Second output/);
  const snapshot = (await app.inject({ url: '/api/snapshot', headers })).json();
  assert.equal(snapshot.runs[0].output_preview, 'Second output');
  assert.equal(snapshot.runs[0].output_version, 2);
  const outputUrl = `/api/projects/${project.id}/tasks/${task.id}/runs/${run.id}/output`;
  assert.equal((await app.inject({ url: outputUrl, headers })).json().text, 'Second output');
  assert.equal((await app.inject({ url: outputUrl.replace(task.id, editable.id), headers })).statusCode, 404);
  const reconnect = await new Promise<string>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${address.port}/api/events`, { headers: { ...headers, 'last-event-id': String(snapshot.cursor) } }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; if (data.includes('Second output') && data.endsWith('\n\n')) { resolve(data); request.destroy(); } });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => { request.destroy(); reject(new Error('SSE timeout')); });
  });
  assert.equal(reconnect.split('Second output').length - 1, 1);
  assert.ok(!reconnect.includes('First output'));
  assert.ok(!reconnect.includes('"type":"run.output"'));
});

for (const reconnect of [false, true]) test(`SSE large snapshot and live update${reconnect ? ' with replay over 500 events' : ''}`, { timeout: 5000 }, async t => {
  const { app, headers, store, project } = await fixture(t);
  const description = 'SSE ' + 'x'.repeat(99_996);
  const task = store.createTask(project.id, description, 1);
  const editable = store.createTask(project.id, 'Edit trigger', 1);
  if (reconnect) for (let i = 0; i < 1100; i++) store.event('test.replay', task.id, { i });
  const initialCursor = store.snapshot().cursor;
  const expectedIds: number[] = [];
  if (reconnect) {
    let cursor = 1;
    while (cursor < initialCursor) {
      const batch = store.events(cursor);
      expectedIds.push(...batch.map(event => event.id));
      cursor = batch.at(-1)!.id;
    }
    assert.ok(expectedIds.length > 500);
  }
  let highWaterMark = 0;
  app.server.on('request', (_request, response) => { highWaterMark = response.writableHighWaterMark; });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const frames = await new Promise<{ id: number; event: string; data: any }[]>((resolve, reject) => {
    const frames: { id: number; event: string; data: any }[] = [];
    const request = get(`http://127.0.0.1:${address.port}/api/events`, {
      headers: reconnect ? { ...headers, 'last-event-id': '1' } : headers,
    }, response => {
      assert.equal(response.statusCode, 200);
      let buffer = '', snapshots = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        buffer += chunk;
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const match = frame.match(/^id: (\d+)\nevent: (\w+)\ndata: (.+)$/s);
          if (!match) continue;
          const parsed = { id: Number(match[1]), event: match[2], data: JSON.parse(match[3]) };
          frames.push(parsed);
          if (parsed.event !== 'snapshot') continue;
          if (++snapshots === 1) {
            void app.inject({ method: 'PATCH', url: `/api/projects/${project.id}/tasks/${editable.id}`, headers,
              payload: { request_id: randomUUID(), state_version: 1, description: 'live edit' },
            }).then(result => { assert.equal(result.statusCode, 200); }).catch(reject);
          } else { resolve(frames); request.destroy(); }
        }
      });
    });
    t.after(() => request.destroy());
    request.on('error', reject);
    request.setTimeout(2000, () => { request.destroy(); reject(new Error('SSE timeout')); });
  });
  const snapshots = frames.filter(frame => frame.event === 'snapshot');
  assert.equal(snapshots.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshots[0].data)) > highWaterMark);
  for (const snapshot of snapshots) assert.equal(snapshot.data.tasks.find((value: Task) => value.id === task.id).description, description);
  const firstSnapshot = frames.indexOf(snapshots[0]);
  assert.deepEqual(frames.slice(0, firstSnapshot).map(frame => frame.id), expectedIds);
  assert.equal(snapshots[0].id, initialCursor);
  assert.equal(snapshots[1].data.tasks.find((value: Task) => value.id === editable.id).description, 'live edit');
  assert.ok(frames.some(frame => frame.event === 'change' && frame.data.type === 'task.edited'));
  assert.deepEqual(frames.map(frame => frame.id), frames.map(frame => frame.id).toSorted((a, b) => a - b));
});

test('SSE server shutdown closes a client waiting for drain', { timeout: 3000 }, async t => {
  const { app, headers } = await fixture(t);
  let writes = 0;
  let blockedResponse: import('node:http').ServerResponse | undefined;
  app.server.on('request', (request, response) => {
    if (request.url !== '/api/events') return;
    blockedResponse = response;
    t.mock.method(response, 'write', () => { writes++; response.flushHeaders(); return false; });
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${address.port}/api/events`, { headers }, response => {
      response.on('error', () => {}); response.resume(); resolve();
    });
    t.after(() => request.destroy());
    request.on('error', reject);
  });
  assert.ok(blockedResponse);
  assert.equal(writes, 1);
  await app.close();
  assert.equal(blockedResponse.destroyed, true);
  assert.equal(blockedResponse.listenerCount('drain'), 0);
  blockedResponse.emit('drain');
  await setImmediate();
  assert.equal(writes, 1, 'closed sender never resumes against a closed Store');
});


test('saved card receives an asynchronous title and request replay does not generate twice', async t => {
  let calls = 0;
  const { app, store, project, headers } = await fixture(t, async description => { calls++; assert.equal(description, 'Export CSV'); return 'CSV export'; });
  const url = `/api/projects/${project.id}/tasks`;
  const payload = { request_id: randomUUID(), state_version: 1, description: 'Export CSV' };
  const response = await app.inject({ method: 'POST', url, headers, payload });
  const task = response.json<Task>();
  assert.equal(task.title, null);
  await setImmediate(); await setImmediate();
  assert.equal(store.task(project.id, task.id).title, 'CSV export');
  assert.equal(store.events(0).at(-1)?.type, 'title.completed');
  assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload })).json(), task);
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal((await app.inject({ url: '/api/snapshot', headers })).json().tasks[0].title, 'CSV export');
});

test('model settings, frozen config, start replay/version/ownership and report access', async t => {
  const { app, store, headers, project } = await fixture(t);
  const settingsUrl = `/api/projects/${project.id}/settings`;
  const defaults = (await app.inject({ url: settingsUrl, headers })).json();
  assert.equal(Object.keys(defaults.models).length, 6);
  const config = { models: { ...defaults.models, spec: 'exact-model' }, instructions: 'Project instructions' };
  const settings = { ...config, state_version: 1, request_id: randomUUID() };
  assert.equal((await app.inject({ method: 'PUT', url: settingsUrl, headers, payload: settings })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: settingsUrl, headers, payload: settings })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: settingsUrl, headers, payload: { ...settings, request_id: randomUUID() } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PUT', url: settingsUrl, headers, payload: { ...settings, models: { spec: 'one' } } })).statusCode, 400);
  const task = store.createTask(project.id, 'Spec', 2);
  const url = `/api/projects/${project.id}/tasks/${task.id}/start`;
  const payload = { request_id: randomUUID(), state_version: task.state_version };
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${randomUUID()}/tasks/${task.id}/start`, headers, payload })).statusCode, 404);
  const started = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(started.statusCode, 200);
  assert.deepEqual(started.json().config, config);
  assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload })).json(), started.json());
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, request_id: randomUUID() } })).statusCode, 409);
  assert.equal(store.runs().length, 1);
  assert.equal((await app.inject({ url: `/api/projects/${project.id}/tasks/${task.id}/runs/${started.json().id}/report`, headers })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/projects/${randomUUID()}/tasks/${task.id}/runs/${started.json().id}/report`, headers })).statusCode, 404);
});

test('human answer schema, ownership, stale action, replay and exactly one continuation', async t => {
  const { app, store, project, headers } = await fixture(t);
  const task = store.createTask(project.id, 'Question', 1);
  const run = store.queueSpec(project.id, task.id, 1, '/tmp');
  run.status = 'completed'; run.outcome = 'NEEDS_INPUT';
  const result = { outcome: 'NEEDS_INPUT' as const, title: 'Question', summary: 'Context', requirements: [], acceptance_criteria: [], assumptions: [], out_of_scope: [],
    questions: [{ text: 'Which?', context: 'Context', impact: 'Impact', options: ['A', 'B'], required: true }] };
  store.updateRun(run, 'needs-human', 'waiting', result.title, result);
  const human = store.humanRequests()[0];
  const url = `/api/projects/${project.id}/tasks/${task.id}/questions/${human.id}/answer`;
  const payload = { request_id: randomUUID(), state_version: store.task(project.id, task.id).state_version, answers: ['Free text'] };
  for (const answers of [null, [3], ['x'.repeat(4097)]]) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, answers } })).statusCode, 400);
  }
  for (const answers of [[], [' '], ['A', 'B']]) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, answers } })).statusCode, 422);
  }
  assert.equal((await app.inject({ method: 'POST', url: url.replace(project.id, randomUUID()), headers, payload })).statusCode, 404);
  const other = store.createTask(project.id, 'Other', 1);
  assert.equal((await app.inject({ method: 'POST', url: url.replace(task.id, other.id), headers, payload })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, state_version: 1 } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://evil.test' }, payload })).statusCode, 403);
  const response = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(response.statusCode, 200); assert.ok(response.json().run.id);
  assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload })).json(), response.json());
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, request_id: randomUUID() } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, answers: ['Changed'] } })).statusCode, 409);
  assert.equal(store.runs().length, 2);
  assert.deepEqual((await app.inject({ url: '/api/snapshot', headers })).json().human_requests[0].answers, ['Free text']);
});

test('Build action requires current Spec, schema/ownership/version and replays without a second run', async t => {
  const { app, store, headers, project } = await fixture(t);
  const task = store.createTask(project.id, 'Build something', 1);
  const url = `/api/projects/${project.id}/tasks/${task.id}/build`;
  const request = (payload: object, path = url) => app.inject({ method: 'POST', url: path, headers, payload });
  assert.equal((await request({ request_id: randomUUID(), state_version: 1 })).statusCode, 409);
  assert.equal((await request({ request_id: randomUUID(), state_version: '1' })).statusCode, 400);
  const spec = store.queueSpec(project.id, task.id, 1, '/tmp');
  spec.status = 'completed'; spec.outcome = 'READY'; store.updateRun(spec, 'build', 'idle');
  const version = store.task(project.id, task.id).state_version;
  const payload = { request_id: randomUUID(), state_version: version };
  assert.equal((await request({ ...payload, request_id: randomUUID() }, url.replace(project.id, randomUUID()))).statusCode, 404);
  assert.equal((await request({ ...payload, state_version: version - 1 })).statusCode, 409);
  const response = await request(payload); assert.equal(response.statusCode, 200);
  assert.equal(response.json().role, 'build');
  assert.deepEqual((await request(payload)).json(), response.json());
  assert.equal((await request({ ...payload, request_id: randomUUID() })).statusCode, 409);
  assert.equal(store.runs().filter(run => run.role === 'build').length, 1);
});

test('Review action requires committed Build, schema/ownership/version and replays without a second run', async t => {
  const { app, store, headers, project } = await fixture(t);
  const task = store.createTask(project.id, 'Build something', 1);
  const url = `/api/projects/${project.id}/tasks/${task.id}/review`;
  const request = (payload: object, path = url) => app.inject({ method: 'POST', url: path, headers, payload });
  assert.equal((await request({ request_id: randomUUID(), state_version: 1 })).statusCode, 409);
  assert.equal((await request({ request_id: randomUUID(), state_version: '1' })).statusCode, 400);
  const spec = store.queueSpec(project.id, task.id, 1, '/tmp');
  spec.status = 'completed'; spec.outcome = 'READY'; store.updateRun(spec, 'build', 'idle');
  const build = store.queueBuild(project.id, task.id, store.task(project.id, task.id).state_version);
  build.status = 'completed'; build.outcome = 'READY'; build.head_sha = 'head'; build.source_hash = 'hash';
  store.updateRun(build, 'review', 'idle');
  const version = store.task(project.id, task.id).state_version;
  const payload = { request_id: randomUUID(), state_version: version };
  assert.equal((await request({ ...payload, request_id: randomUUID() }, url.replace(project.id, randomUUID()))).statusCode, 404);
  assert.equal((await request({ ...payload, state_version: version - 1 })).statusCode, 409);
  const response = await request(payload); assert.equal(response.statusCode, 200);
  assert.equal(response.json().role, 'review-code');
  assert.deepEqual((await request(payload)).json(), response.json());
  assert.equal((await request({ ...payload, request_id: randomUUID() })).statusCode, 409);
  assert.equal(store.runs().filter(run => run.role === 'review-code').length, 1);
});

test('Repair action validates complete round, ownership, schema, version and replay', async t => {
  const { app, store, headers, project } = await fixture(t);
  const task = store.createTask(project.id, 'Repair something', 1);
  const url = `/api/projects/${project.id}/tasks/${task.id}/repair`;
  const request = (payload: object, path = url) => app.inject({ method: 'POST', url: path, headers, payload });
  assert.equal((await request({ request_id: randomUUID(), state_version: 1 })).statusCode, 409);
  assert.equal((await request({ request_id: randomUUID(), state_version: '1' })).statusCode, 400);
  const spec = store.queueSpec(project.id, task.id, 1, '/tmp');
  spec.status = 'completed'; spec.outcome = 'READY'; store.updateRun(spec, 'build', 'idle');
  const build = store.queueBuild(project.id, task.id, store.task(project.id, task.id).state_version);
  build.status = 'completed'; build.outcome = 'READY'; build.head_sha = 'head'; build.source_hash = 'hash';
  store.updateRun(build, 'review', 'idle');
  for (let i = 0; i < 3; i++) {
    const review = store.queueReview(project.id, task.id, store.task(project.id, task.id).state_version);
    review.status = 'completed'; review.outcome = 'CHANGES';
    store.updateRun(review, i === 2 ? 'needs-human' : 'review', i === 2 ? 'interrupted' : 'idle');
  }
  const version = store.task(project.id, task.id).state_version;
  const payload = { request_id: randomUUID(), state_version: version };
  assert.equal((await request(payload, url.replace(project.id, randomUUID()))).statusCode, 404);
  assert.equal((await request({ ...payload, state_version: version - 1 })).statusCode, 409);
  const response = await request(payload); assert.equal(response.statusCode, 200);
  assert.equal(response.json().role, 'build');
  assert.deepEqual((await request(payload)).json(), response.json());
  assert.equal((await request({ ...payload, request_id: randomUUID() })).statusCode, 409);
  assert.equal(store.runs().filter(run => run.role === 'build').length, 2);
});

test('Approve actions reject missing PASS, foreign requests and malformed decisions', async t => {
  const { app, store, headers, project } = await fixture(t);
  const task = store.createTask(project.id, 'Approve something', 1);
  const url = `/api/projects/${project.id}/tasks/${task.id}`;
  const payload = { request_id: randomUUID(), state_version: 1 };
  assert.equal((await app.inject({ method: 'POST', url: `${url}/approve`, headers, payload })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `${url}/approve`, headers, payload: { ...payload, state_version: '1' } })).statusCode, 400);
  const path = `${url}/decisions/${randomUUID()}`;
  assert.equal((await app.inject({ method: 'POST', url: path, headers, payload: { ...payload, decision: 'merge', feedback: '' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: path, headers, payload: { ...payload, decision: 'publish', feedback: '' } })).statusCode, 404);
});


test('Concurrent decision replay queues the persisted repair exactly once', async t => {
  const { app, store, headers, project } = await fixture(t);
  const task = store.createTask(project.id, 'Repair after escalation', 1);
  const spec = store.queueSpec(project.id, task.id, 1, '/tmp');
  spec.status = 'completed'; spec.outcome = 'READY'; store.updateRun(spec, 'build', 'idle');
  const build = store.queueBuild(project.id, task.id, store.task(project.id, task.id).state_version);
  build.status = 'completed'; build.outcome = 'READY'; build.head_sha = 'head'; build.source_hash = 'hash';
  store.updateRun(build, 'review', 'idle');
  for (let i = 0; i < 3; i++) {
    const review = store.queueReview(project.id, task.id, store.task(project.id, task.id).state_version);
    review.status = 'completed'; review.outcome = 'PASS';
    store.updateRun(review, i === 2 ? 'approve' : 'review', 'idle');
  }
  const approve = store.queueApprove(project.id, task.id, store.task(project.id, task.id).state_version);
  approve.status = 'completed'; approve.outcome = 'ESCALATE';
  store.updateRun(approve, 'needs-human', 'waiting', undefined, { outcome: 'ESCALATE', summary: 'Risk', risks: ['Rollout'], affected_paths: [], questions: [] });
  const human = store.humanRequests().at(-1)!;
  let checks = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(SpecController.prototype, 'verifyReviewSource', async () => {
    if (++checks === 2) release();
    await barrier;
  });
  const enqueued: string[] = [];
  t.mock.method(SpecController.prototype, 'enqueue', (run: { id: string }) => { enqueued.push(run.id); });
  const payload = { request_id: randomUUID(), state_version: store.task(project.id, task.id).state_version, decision: 'repair', feedback: 'Use canary' };
  const send = () => app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks/${task.id}/decisions/${human.id}`, headers, payload });
  const responses = await Promise.all([send(), send()]);
  assert.deepEqual(responses.map(r => r.statusCode), [200, 200]);
  assert.deepEqual(responses[0].json(), responses[1].json());
  assert.equal(checks, 2); assert.deepEqual(enqueued, [responses[0].json().run.id]);
  assert.equal(store.runs().filter(r => r.role === 'build').length, 2);
  assert.equal(store.events(0).filter(e => e.type === 'approve.decided').length, 1);
});

test('Publication API requires owned task, valid schema and an approved current version', async t => {
  const { app, store, headers, project } = await fixture(t);
  const task = store.createTask(project.id, 'Publish only after review', 1);
  const payload = { request_id: randomUUID(), state_version: task.state_version };
  const url = `/api/projects/${project.id}/tasks/${task.id}/publish`;
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, unexpected: true } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://other.test' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${randomUUID()}/tasks/${task.id}/publish`, headers, payload })).statusCode, 404);
  assert.equal(store.task(project.id, task.id).publication_status, null);
  assert.equal(store.replay(payload.request_id, JSON.stringify(['publication.start', project.id, task.id, task.state_version])), undefined);
});

test('diagnostic actions validate versions/schema/ownership, replay once, and logs require owned run', async t => {
  const { app, store, headers, project, directory } = await fixture(t);
  const task = store.createTask(project.id, 'diagnostics', 1);
  const run = store.queueSpec(project.id, task.id, 1, '/tmp');
  run.status = 'failed'; run.base_sha = 'base'; run.source_hash = 'hash'; run.diagnostic = { error_kind: 'rate_limit', execution_finished: true, reset_at: null };
  store.updateRun(run, 'needs-human', 'interrupted');
  const resume = { request_id: randomUUID(), state_version: store.executionPause().state_version };
  const response = await app.inject({ method: 'POST', url: '/api/execution/resume', headers, payload: resume }); assert.equal(response.statusCode, 200);
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/execution/resume', headers, payload: resume })).json(), response.json());
  assert.equal((await app.inject({ method: 'POST', url: '/api/execution/resume', headers, payload: { ...resume, request_id: randomUUID() } })).statusCode, 409);
  const path = `/api/projects/${project.id}/tasks/${task.id}`;
  const artifacts = artifactDirectory(directory, run.id);
  writeFileSync(join(artifacts, 'stderr.log'), 'Bearer fakecredential1234567890\n');
  const legacy = await app.inject({ url: `${path}/runs/${run.id}/log?name=stderr.log&offset=0`, headers });
  assert.equal(legacy.statusCode, 409); assert.ok(!legacy.body.includes('fakecredential1234567890'));
  assert.equal((await app.inject({ url: `${path}/runs/${run.id}/log?name=../state.sqlite&offset=0`, headers })).statusCode, 400);
  assert.equal((await app.inject({ url: `${path}/runs/${run.id}/log?name=stderr.log&offset=-1`, headers })).statusCode, 400);
  assert.equal((await app.inject({ url: `${path}/runs/${randomUUID()}/log?name=stderr.log&offset=0`, headers })).statusCode, 404);
  const retry = { request_id: randomUUID(), state_version: store.task(project.id, task.id).state_version };
  const enqueue = t.mock.method(SpecController.prototype, 'enqueue', () => {});
  const retried = await app.inject({ method: 'POST', url: `${path}/retry`, headers, payload: retry }); assert.equal(retried.statusCode, 200);
  assert.deepEqual((await app.inject({ method: 'POST', url: `${path}/retry`, headers, payload: retry })).json(), retried.json()); assert.equal(enqueue.mock.callCount(), 1);
  assert.equal((await app.inject({ method: 'POST', url: `${path}/retry`, headers, payload: { ...retry, request_id: randomUUID() } })).statusCode, 409);
});

test('chat API validates ownership, replay, versions and origin; requirements invalidate the revision', async t => {
  const { app, store, headers, project } = await fixture(t);
  const task = store.createTask(project.id, 'Task', 1);
  const url = `/api/projects/${project.id}/tasks/${task.id}/messages`;
  const payload = { request_id: randomUUID(), state_version: task.state_version, text: '<script>alert(1)</script>', kind: 'guidance' };
  const response = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(response.statusCode, 200);
  assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload })).json(), response.json());
  const messages = (await app.inject({ url, headers })).json();
  assert.equal(messages.length, 1); assert.equal(messages[0].status, 'queued');
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://evil.test' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/projects/${randomUUID()}/tasks/${task.id}/messages`, headers })).statusCode, 404);
  for (const extra of [{ text: ' ' }, { kind: 'publish' }, { text: 'x'.repeat(4097) }, { unknown: true }]) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, request_id: randomUUID(), ...extra } })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, request_id: randomUUID(), state_version: 100 } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, request_id: randomUUID(), kind: 'requirements', text: 'Extra requirement' } })).statusCode, 200);
  assert.equal(store.task(project.id, task.id).revision, 2);
  assert.deepEqual((await app.inject({ url, headers })).json().map((m: { status: string }) => m.status), ['revoked', 'applied']);
});

import { api as clientApi } from '../src/client/api.js';

test('lost chat response followed by SSE version update retries the original request without another revision', async t => {
  const { app, store, headers, project } = await fixture(t);
  const task = store.createTask(project.id, 'Original description', 1);
  const path = `/projects/${project.id}/tasks/${task.id}/messages`;
  const requests: Record<string, unknown>[] = [];
  let saved: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)); requests.push(payload);
    const response = await app.inject({ method: 'POST', url, headers, payload });
    assert.equal(response.statusCode, 200);
    if (requests.length === 1) { saved = response.json(); throw new TypeError('Response lost after commit'); }
    return new Response(response.body, { status: response.statusCode });
  });
  const message = { state_version: task.state_version, text: 'Extra requirement', kind: 'requirements' };
  await assert.rejects(clientApi(path, 'POST', message), /Response lost/);

  // Deliver the updated task through the same SSE snapshot contract used by App.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const updated = await new Promise<Task>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${address.port}/api/events`, { headers }, response => {
      let buffer = '';
      response.on('data', chunk => {
        buffer += chunk;
        const snapshot = buffer.match(/event: snapshot\ndata: ([^\n]+)\n\n/);
        if (snapshot) { resolve(JSON.parse(snapshot[1]).tasks.find((value: Task) => value.id === task.id)); request.destroy(); }
      });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => { request.destroy(); reject(new Error('SSE timeout')); });
  });
  assert.ok(updated.state_version > task.state_version);
  assert.equal(updated.revision, 2);
  const result = await clientApi(path, 'POST', { ...message, state_version: updated.state_version });
  assert.equal(store.task(project.id, task.id).revision, 2, 'retry must not append the requirements again');
  assert.equal((store.db.prepare('SELECT count(*) AS count FROM chat_messages WHERE task_id = ?').get(task.id) as { count: number }).count, 1);
  assert.deepEqual(requests[1], requests[0], 'payload and request_id stay frozen despite SSE');
  assert.deepEqual(result, saved);
});

for (const status of [401, 409, 500]) test(`client retry resolves only confirmed responses: HTTP ${status}`, async t => {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ message: 'Request failed' }), { status: requests.length === 1 ? status : 200 });
  });
  const path = `/retry-test-${status}`;
  await assert.rejects(clientApi(path, 'POST', { state_version: 1, text: 'Same intent' }), /Request failed/);
  await clientApi(path, 'POST', { state_version: 2, text: 'Same intent' });
  if (status !== 409) assert.deepEqual(requests[1], requests[0]);
  else {
    assert.equal(requests[1].state_version, 2);
    assert.notEqual(requests[1].request_id, requests[0].request_id);
  }
  await clientApi(path, 'POST', { state_version: 3, text: 'Same intent' });
  assert.equal(requests[2].state_version, 3);
  assert.notEqual(requests[2].request_id, requests[1].request_id, 'confirmed success permits a new action');
});

test('interrupt endpoint binds current run/version, rejects publication and replays without another signal', async t => {
  const { app, store, headers, project } = await fixture(t);
  const task = store.createTask(project.id, 'interrupt', 1);
  const run = store.queueSpec(project.id, task.id, 1, '/tmp');
  run.status = 'running'; run.diagnostic = { can_interrupt: true };
  store.updateRun(run, 'spec', 'running');
  const available = t.mock.method(SpecController.prototype, 'canInterrupt', () => true);
  const interrupt = t.mock.method(SpecController.prototype, 'interrupt', () => {});
  const url = `/api/projects/${project.id}/tasks/${task.id}/runs/${run.id}/interrupt`;
  const payload = { request_id: randomUUID(), state_version: store.task(project.id, task.id).state_version };
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, state_version: 1 } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: url.replace(run.id, randomUUID()), headers, payload })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://other.test' }, payload })).statusCode, 403);
  store.db.prepare("UPDATE tasks SET publication_status='pending' WHERE id=?").run(task.id);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 409);
  store.db.prepare('UPDATE tasks SET publication_status=NULL WHERE id=?').run(task.id);
  available.mock.mockImplementation(() => false);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 409);
  available.mock.mockImplementation(() => true);
  const response = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(response.statusCode, 200); assert.ok(response.json().diagnostic.interrupt_requested_at);
  assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload })).json(), response.json());
  assert.equal(interrupt.mock.callCount(), 1);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, request_id: randomUUID(), state_version: store.task(project.id, task.id).state_version } })).statusCode, 409);
});

test('task event history is scoped, paginated and preserves saved order for reload', async t => {
  const { app, store, headers, project } = await fixture(t);
  const task = store.createTask(project.id, 'History', 1);
  const other = store.createTask(project.id, 'Other', 1);
  for (let i = 0; i < 505; i++) {
    store.event('run.interrupt-requested', task.id, { run_id: String(i) });
    store.event('human.answered', other.id, { run_id: 'other' });
  }
  const url = `/api/projects/${project.id}/tasks/${task.id}/events`;
  const first = (await app.inject({ url: `${url}?after=0`, headers })).json();
  assert.equal(first.events.length, 500); assert.equal(first.more, true);
  assert.ok(first.events.every((event: { task_id: string }) => event.task_id === task.id));
  const next = (await app.inject({ url: `${url}?after=${first.next_id}`, headers })).json();
  assert.equal(next.more, false); assert.equal(next.events.length, 6);
  const ids = [...first.events, ...next.events].map(event => event.id);
  assert.equal(new Set(ids).size, 506);
  assert.deepEqual([...ids].sort((a, b) => a - b), ids);
  assert.deepEqual((await app.inject({ url: `${url}?after=0`, headers })).json(), first);
  assert.equal((await app.inject({ url: `${url}?after=-1`, headers })).statusCode, 400);
  assert.equal((await app.inject({ url: `${url}?after=0`, headers: { host: headers.host } })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/projects/${randomUUID()}/tasks/${task.id}/events?after=0`, headers })).statusCode, 404);
});
