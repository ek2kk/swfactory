import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import type { Task } from '../src/shared.js';
import type { IssueCommand } from '../src/server/issues.js';

const origin = 'http://127.0.0.1:4317';
async function fixture(t: { after: (fn: () => Promise<void>) => void }, issueCommand: IssueCommand = async () => '[]') {
  const directory = mkdtempSync(join(tmpdir(), 'factory-project-deletion-'));
  const result = await createApp({ directory, origin, issueCommand, generateTitle: async () => 'Title' });
  t.after(async () => { await result.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = result.store.addProject({ checkout: directory, common_dir: join(directory, '.git'), remote: 'origin',
    remote_url: 'git@github.com:owner/repo.git', hosting: 'github', host: 'github.com', repository: 'owner/repo', target_branch: 'main' });
  const session = await result.app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token: result.token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const remove = (payload = { request_id: randomUUID(), state_version: result.store.project(project.id).state_version }, extraHeaders = headers) =>
    result.app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, headers: extraHeaders, payload });
  return { ...result, directory, project, headers, remove };
}

test('project deletion checks auth/version, removes only registration/settings, replays once and survives reload', async t => {
  const f = await fixture(t);
  const marker = join(f.directory, 'checkout-marker'); writeFileSync(marker, 'keep repository');
  f.store.saveSettings(f.project.id, { ...f.store.settings(f.project.id), instructions: 'Saved' }, 1);
  const request = { request_id: randomUUID(), state_version: 2 };
  assert.equal((await f.remove(request, { ...f.headers, cookie: '' })).statusCode, 401);
  assert.equal((await f.remove(request, { ...f.headers, origin: 'http://evil.test' })).statusCode, 403);
  assert.equal((await f.remove({ request_id: randomUUID(), state_version: 1 })).statusCode, 409);
  assert.equal(f.store.settings(f.project.id).instructions, 'Saved');
  assert.equal((await f.remove(request)).statusCode, 200);
  assert.equal((await f.remove(request)).statusCode, 200);
  assert.equal(f.store.events(0).filter(event => event.type === 'project.deleted').length, 1);
  assert.equal(f.store.db.prepare('SELECT * FROM project_settings').all().length, 0);
  assert.equal(readFileSync(marker, 'utf8'), 'keep repository');
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/tasks`, headers: f.headers,
    payload: { request_id: randomUUID(), state_version: 2, description: 'Late create' } })).statusCode, 404);
  assert.throws(() => f.store.importGithubIssue(f.project.id, { number: 1, title: 'Late', description: 'Late', url: 'https://github.com/owner/repo/issues/1' }), /Проект не найден/);
  await f.app.close();
  const reopened = new Store(f.directory);
  try {
    assert.equal(reopened.snapshot().projects.length, 0);
    const { id: _id, state_version: _version, ...input } = f.project;
    assert.notEqual(reopened.addProject(input).id, f.project.id);
  } finally { reopened.close(); }
});

for (const flags of [
  { stage: 'backlog', run_state: 'idle' }, { run_state: 'queued' }, { run_state: 'running' }, { run_state: 'waiting' },
  { run_state: 'completed' }, { title_state: 'running' }, { stop_unverified: 1 }, { publication_status: 'pending' },
  { publication_status: 'unknown' }, { archived: 1, run_state: 'completed' },
]) test(`any linked task blocks project deletion: ${JSON.stringify(flags)}`, async t => {
  const f = await fixture(t);
  const task = f.store.createTask(f.project.id, 'Retain history', 1);
  f.store.db.prepare(`UPDATE tasks SET ${Object.keys(flags).map(key => `${key} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(flags), task.id);
  const before = f.store.snapshot();
  const response = await f.remove();
  assert.equal(response.statusCode, 409); assert.match(response.json().message, /включая архивные/);
  assert.deepEqual(f.store.snapshot(), before);
});

for (const first of ['delete', 'create']) test(`concurrent create and delete stay consistent (${first} first)`, async t => {
  const f = await fixture(t);
  const deletion = () => f.remove({ request_id: randomUUID(), state_version: 1 });
  const creation = () => f.app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/tasks`, headers: f.headers,
    payload: { request_id: randomUUID(), state_version: 1, description: 'Concurrent' } });
  const responses = await Promise.all(first === 'delete' ? [deletion(), creation()] : [creation(), deletion()]);
  assert.equal(responses[0].statusCode, 200);
  assert.equal(responses[1].statusCode, first === 'delete' ? 404 : 409);
  const snapshot = f.store.snapshot();
  assert.equal(snapshot.projects.length, first === 'delete' ? 0 : 1);
  assert.equal(snapshot.tasks.length, snapshot.projects.length);
  assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('deletion cancels import, ignores a late response and stops polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: (response: string) => void, signal!: AbortSignal, calls = 0;
  const delayed = new Promise<string>(resolve => { release = resolve; });
  const f = await fixture(t, async (_args, currentSignal) => { calls++; signal = currentSignal; return delayed; });
  const pending = f.issues.refresh(f.project.id);
  assert.equal(calls, 1);
  assert.equal((await f.remove()).statusCode, 200);
  assert.equal(signal.aborted, true);
  release(JSON.stringify([{ number: 1, title: 'Late', body: 'Late', state: 'open', labels: ['ready-for-agent'], html_url: 'https://github.com/owner/repo/issues/1' }]));
  await pending;
  t.mock.timers.tick(120_000); await f.issues.settled();
  assert.equal(calls, 1); assert.deepEqual(f.issues.syncing, []); assert.deepEqual(f.issues.errors, []);
  assert.equal(f.store.snapshot().projects.length, 0); assert.equal(f.store.snapshot().tasks.length, 0);
  assert.throws(() => f.issues.refresh(f.project.id), /Проект не найден/);
});

test('an import saved first blocks a simultaneous project deletion without losing issue history', async t => {
  const f = await fixture(t, async () => JSON.stringify([{ number: 1, title: 'Imported', body: 'History', state: 'open', labels: ['ready-for-agent'], html_url: 'https://github.com/owner/repo/issues/1' }]));
  await f.issues.refresh(f.project.id);
  assert.equal((await f.remove()).statusCode, 409);
  const task = f.store.snapshot().tasks[0] as Task;
  assert.equal(task.issue_number, 1); assert.equal(f.store.revisions(f.project.id, task.id).length, 1);
  assert.equal(f.store.snapshot().projects.length, 1);
});
