import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { get } from 'node:http';
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
  return { ...result, headers, project: projectResponse.json<Project>() };
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
          void app.inject({ method: 'PATCH', url: `/api/projects/${project.id}/tasks/${task.id}`, headers,
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
  assert.equal(store.snapshot().tasks.length, 1);
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
