import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { chooseProjectFolder } from '../src/server/folder-dialog.js';

test('macOS dialog preserves path characters, handles cancellation and rejects errors/invalid output', { skip: process.platform !== 'darwin' }, async () => {
  const path = '/Users/test/ Проект "один" \'два\'/';
  assert.equal(await chooseProjectFolder(async script => {
    assert.match(script, /choose folder/);
    assert.match(script, /errorNumber is -128/);
    return `${path}\n`;
  }), path);
  assert.equal(await chooseProjectFolder(async () => '\n'), null);
  assert.equal(await chooseProjectFolder(async () => '/folder with trailing whitespace \n\n'), '/folder with trailing whitespace \n');
  await assert.rejects(chooseProjectFolder(async () => { throw new Error('osascript failed'); }), /osascript failed/);
  await assert.rejects(chooseProjectFolder(async () => 'relative/path\n'), /Invalid folder/);
});

test('folder endpoint is protected, single-flight, non-blocking and only fills the checkout', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-folder-'));
  const origin = 'http://127.0.0.1:4317';
  const path = '/Users/test/Проект "один" \'два\'/';
  let calls = 0;
  let result: string | null = path;
  let fail = false;
  let release!: () => void;
  let started!: () => void;
  let barrier: Promise<void> | undefined;
  const { app, store, token } = await createApp({ directory, origin,
    chooseFolder: async () => {
      calls++; started?.();
      await barrier;
      if (fail) throw new Error('Private native error');
      return result;
    },
    inspect: async input => ({ ...input, common_dir: `${input.checkout}/.git`, remote_url: 'git@github.com:owner/repo.git', host: 'github.com', repository: 'owner/repo' }),
  });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const url = '/api/projects/choose-folder';
  for (const [badHeaders, status] of [
    [{ host: headers.host, origin }, 401],
    [{ ...headers, host: 'evil.test' }, 403],
    [{ ...headers, origin: 'https://evil.test' }, 403],
    [{ host: headers.host, cookie: headers.cookie }, 403],
    [{ ...headers, 'sec-fetch-site': 'cross-site' }, 403],
  ] as const) {
    assert.equal((await app.inject({ method: 'POST', url, headers: badHeaders })).statusCode, status);
  }
  assert.equal((await app.inject({ url, headers })).statusCode, 404);
  assert.equal(calls, 0);
  const choose = () => app.inject({ method: 'POST', url, headers });
  const selected = await choose();
  assert.equal(selected.statusCode, 200); assert.deepEqual(selected.json(), { checkout: path });
  assert.equal(store.snapshot().projects.length, 0); assert.equal(store.events(0).length, 0);
  result = null;
  const cancelled = await choose();
  assert.equal(cancelled.statusCode, 200); assert.deepEqual(cancelled.json(), { checkout: null });
  fail = true;
  const failed = await choose();
  assert.equal(failed.statusCode, 503); assert.match(failed.json().message, /введите абсолютный путь вручную/);
  assert.ok(!failed.body.includes('Private native error'));
  fail = false; result = path;
  assert.equal((await choose()).statusCode, 200);
  barrier = new Promise(resolve => { release = resolve; });
  const opened = new Promise<void>(resolve => { started = resolve; });
  const pending = choose().then(response => response);
  await opened;
  const before = calls;
  try {
    assert.equal((await choose()).statusCode, 409); assert.equal(calls, before);
    assert.equal((await app.inject({ url: '/api/snapshot', headers })).statusCode, 200);
    assert.equal(store.snapshot().projects.length, 0);
  } finally { release(); }
  assert.equal((await pending).statusCode, 200);
  const payload = { checkout: selected.json().checkout, remote: 'origin', target_branch: 'main', hosting: 'github', request_id: randomUUID(), state_version: 0 };
  const connected = await app.inject({ method: 'POST', url: '/api/projects', headers, payload });
  assert.equal(connected.statusCode, 200); assert.equal(connected.json().checkout, path);
  assert.equal(store.snapshot().projects.length, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { ...payload, request_id: randomUUID() } })).statusCode, 409);
  assert.equal(store.snapshot().projects.length, 1);
});

test('selected non-Git directory still fails the existing connection validation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-folder-non-git-'));
  const origin = 'http://127.0.0.1:4317';
  const { app, store, token } = await createApp({ directory, origin, chooseFolder: async () => directory });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const selected = await app.inject({ method: 'POST', url: '/api/projects/choose-folder', headers });
  const connected = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: {
    checkout: selected.json().checkout, remote: 'origin', target_branch: 'main', hosting: 'github', request_id: randomUUID(), state_version: 0,
  } });
  assert.equal(connected.statusCode, 422); assert.match(connected.json().message, /репозиторий/);
  assert.equal(store.snapshot().projects.length, 0);
});
