import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { Chat } from '../src/server/chat.js';
import { DeliveryError } from '../src/server/interactive.js';
import { readTranscript, transcriptEntry } from '../src/server/transcript.js';
import { artifactDirectory, saveArtifact } from '../src/server/artifacts.js';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as jsx from 'react/jsx-runtime';
import * as stageHistory from '../src/client/stageHistory.js';
import * as shared from '../src/shared.js';
import type { AgentRun, TranscriptEntry } from '../src/shared.js';

function conversationPolling(status: AgentRun['status'], pages: { entries: TranscriptEntry[]; next_offset: number; more: boolean }[]) {
  const values: any[] = [], timers = new Map<number, () => void>(), calls: string[] = [];
  let index = 0, timerId = 0, effect!: () => () => void, cleanup: (() => void) | undefined;
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': jsx,
    'react': {
      useState(initial: unknown) {
        const slot = index++;
        if (!(slot in values)) values[slot] = initial;
        return [values[slot], (value: any) => { values[slot] = typeof value === 'function' ? value(values[slot]) : value; }];
      },
      useRef(current: unknown) { return values[index++] ??= { current }; },
      useEffect(callback: () => () => void) { effect = callback; },
    },
    './taskView.js': {}, './stageHistory.js': stageHistory, '../shared.js': shared,
  };
  const module = { exports: {} as any };
  runInNewContext(transformSync(readFileSync(new URL('../src/client/chat.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
    module,
    require(name: string) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
    setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  function render(nextStatus = status, active = true) {
    cleanup?.(); index = 0;
    module.exports.RunConversation({ runs: [{ id: 'run', role: 'spec', status: nextStatus, description_revision: 1 }], role: 'spec', revision: 1,
      path: '/task', messages: [], requests: [], active, api: async (path: string) => {
        if (path.includes('/transcript')) {
          calls.push(path);
          const page = pages.shift(); assert.ok(page, 'no unexpected transcript requests'); return page;
        }
        return { events: [], next_id: 0, more: false };
      } });
    cleanup = effect();
  }
  return { calls, values, render, close: () => cleanup?.(), async tick() {
    const next = timers.entries().next().value; assert.ok(next, 'poll scheduled');
    timers.delete(next[0]); next[1](); await setImmediate();
  } };
}

test('completed transcript drains every page once and stays drained across polling and tab changes', async t => {
  const entry = (id: string): TranscriptEntry => ({ id, kind: 'agent', title: '', text: id, at: '' });
  const poll = conversationPolling('completed', [
    { entries: [entry('first')], next_offset: 10, more: true },
    { entries: [entry('last')], next_offset: 20, more: false },
  ]);
  t.after(poll.close);
  poll.render(); await setImmediate(); await poll.tick();
  assert.deepEqual(poll.calls, ['/task/runs/run/transcript?offset=0', '/task/runs/run/transcript?offset=10']);
  await poll.tick(); await poll.tick();
  poll.render('completed', false); poll.render(); await setImmediate(); await poll.tick();
  assert.equal(poll.calls.length, 2, 'finished history is never polled again');
  assert.equal(poll.values[0].run.length, 2, 'all pages remain readable');
});

test('running transcript keeps polling and drains the final pages after completion', async t => {
  const final: TranscriptEntry = { id: 'final', kind: 'agent', title: '', text: 'Final message', at: '' };
  const poll = conversationPolling('running', [
    { entries: [], next_offset: 10, more: false },
    { entries: [], next_offset: 10, more: false },
    { entries: [final], next_offset: 20, more: true },
    { entries: [final], next_offset: 30, more: false },
  ]);
  t.after(poll.close);
  poll.render(); await setImmediate(); await poll.tick();
  assert.equal(poll.calls.length, 2, 'more=false does not stop a running transcript');
  poll.render('completed'); await setImmediate(); await poll.tick(); await poll.tick();
  assert.deepEqual(poll.calls, [0, 10, 10, 20].map(offset => `/task/runs/run/transcript?offset=${offset}`));
  assert.equal(poll.values[0].run.length, 1, 'final message is loaded once without duplicates');
  assert.equal(poll.values[0].run[0].text, final.text);
});

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-chat-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject({ checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github', host: 'github.com', repository: 'owner/repo', target_branch: 'main' });
  const task = store.createTask(project.id, 'Original', 1);
  const chat = new Chat(store, () => {});
  const run = store.queueSpec(project.id, task.id, 1, directory);
  run.status = 'running'; store.updateRun(run, 'spec', 'running');
  const add = (text: string, kind: 'guidance' | 'requirements' = 'guidance') => store.mutate(text, text, () => chat.add(project.id, task.id, store.task(project.id, task.id).state_version, text, kind));
  return { directory, store, project, task, run, chat, add, restart: () => { store.close(); store = new Store(directory); return store; } };
}
test('chat preserves credential values through delivery and restart', async t => {
  const { chat, add, run, restart } = fixture(t);
  const text = 'token="test-value" Bearer fakecredential1234567890';
  add(text);
  assert.equal(chat.messages(run.task_id)[0].text, text);
  chat.control(run, async (_id, prompt) => { assert.ok(prompt.endsWith(text)); });
  await setImmediate();
  const store = restart();
  assert.equal(new Chat(store, () => {}).messages(run.task_id)[0].text, text);
});
test('queued guidance uses the same executor, confirms only on ack and request replay never resends', async t => {
  const { chat, add, run } = fixture(t);
  add('First'); add('First');
  let acknowledge!: () => void;
  let calls = 0;
  chat.control(run, async (_id, text) => { calls++; assert.match(text, /First/); await new Promise<void>(resolve => { acknowledge = resolve; }); });
  chat.flush(run.task_id);
  assert.equal(calls, 1);
  assert.equal(chat.messages(run.task_id)[0].status, 'sending');
  acknowledge(); await setImmediate();
  assert.equal(chat.messages(run.task_id)[0].status, 'delivered');
  chat.control(run, null); add('Later');
  assert.equal(chat.messages(run.task_id)[1].status, 'queued');
});
test('rejected and unknown delivery never auto-retry; restart preserves history and marks sending unknown', async t => {
  const { chat, add, run, restart } = fixture(t);
  add('Reject'); chat.control(run, async () => { throw new DeliveryError('failed', 'No active turn'); });
  await setImmediate(); assert.equal(chat.messages(run.task_id)[0].status, 'failed');
  add('Unknown'); chat.control(run, async () => { throw new DeliveryError('unknown', 'No ack'); });
  await setImmediate(); assert.equal(chat.messages(run.task_id)[1].status, 'unknown');
  add('Restart'); chat.control(run, async () => new Promise<void>(() => {}));
  assert.equal(chat.messages(run.task_id)[2].status, 'sending');
  const store = restart(); const next = new Chat(store, () => {});
  assert.deepEqual(next.messages(run.task_id).map(m => m.status), ['failed', 'unknown', 'unknown']);
  assert.equal(store.task(run.project_id, run.task_id).run_state, 'interrupted');
});
test('requirements wait for completion, create a revision and revoke stale guidance and pending questions', t => {
  const { chat, add, store, task, project, run } = fixture(t);
  add('New requirement', 'requirements'); add('Old guidance');
  assert.equal(store.task(project.id, task.id).revision, 1);
  assert.equal(chat.messages(task.id)[0].status, 'queued');
  run.status = 'completed'; run.outcome = 'NEEDS_INPUT';
  store.updateRun(run, 'needs-human', 'waiting', undefined, { outcome: 'NEEDS_INPUT', title: 'Title', summary: 'Question', requirements: [], acceptance_criteria: [], assumptions: [], out_of_scope: [], questions: [{ text: 'Q?', context: 'C', impact: 'I', options: [], required: true }] });
  const next = store.task(project.id, task.id);
  assert.equal(next.revision, 2); assert.equal(next.stage, 'backlog'); assert.equal(next.run_state, 'idle');
  assert.match(next.description, /Original[\s\S]*New requirement/);
  assert.equal(store.humanRequests()[0].status, 'revoked');
  assert.deepEqual(chat.messages(task.id).map(m => m.status), ['applied', 'revoked']);
  assert.equal(store.specRun(project.id, task.id, run.id).status, 'completed');
});
test('ordinary guidance cannot answer NEEDS_INPUT, grant approval or edit requirements', t => {
  const { add, store, run, task, project } = fixture(t);
  run.status = 'completed'; run.outcome = 'NEEDS_INPUT';
  store.updateRun(run, 'needs-human', 'waiting', undefined, { outcome: 'NEEDS_INPUT', title: 'Title', summary: 'Q', requirements: [], acceptance_criteria: [], assumptions: [], out_of_scope: [], questions: [{ text: 'Q?', context: 'C', impact: 'I', options: [], required: true }] });
  add('publish now');
  assert.equal(store.task(project.id, task.id).revision, 1);
  assert.equal(store.humanRequests()[0].status, 'pending');
  assert.equal(store.runs().length, 1);
});
test('transcript handles legacy and app-server events, long UTF-8 lines, partial tails and untrusted text', t => {
  const { directory, run } = fixture(t);
  const path = artifactDirectory(directory, run.id);
  const message = 'Ж'.repeat(70_000) + '<script>bad()</script>';
  const line = JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', text: message } } });
  writeFileSync(join(path, 'events.jsonl'), line + '\n{"unfinished":');
  const page = readTranscript(directory, run.id, 0);
  assert.equal(page.entries[0].text, message);
  assert.equal(page.next_offset, Buffer.byteLength(line + '\n'));
  assert.equal(readTranscript(directory, run.id, page.next_offset).next_offset, page.next_offset);
  assert.equal(transcriptEntry({ type: 'item.completed', item: { type: 'agent_message', text: 'Old' } }, 'id')?.text, 'Old');
  assert.equal(transcriptEntry({ method: 'item/agentMessage/delta', params: { delta: 'partial secret' } }, 'id'), null);
  assert.equal(transcriptEntry({ method: 'item/started', params: { item: { type: 'commandExecution', command: 'npm test' } } }, 'id')?.status, 'in_progress');
});

test('Composer offers only guidance and messages show their application and Stop revocation status', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Composer, Message } = await import('../src/client/chat.js');
  const { store, task, run, chat, add } = fixture(t);
  const composer = renderToStaticMarkup(createElement(Composer, { task, path: '/task', api: async () => { throw new Error('unused'); }, refresh: async () => {} }));
  assert.match(composer, /Сообщение агенту/);
  assert.ok(!composer.includes('<select')); assert.ok(!composer.includes('Тип сообщения'));
  add('Change', 'requirements');
  const message = renderToStaticMarkup(createElement(Message, { message: chat.messages(run.task_id)[0] }));
  assert.match(message, /Изменение требований/);
  assert.match(message, /Ожидает применения после текущего этапа/);
  assert.match(message, /Версия требований: 1/);
  assert.ok(!message.includes('Ожидает доставки'));
  add('Guidance', 'guidance');
  store.beginDeletion(task.project_id, task.id, store.task(task.project_id, task.id).state_version);
  for (const revoked of chat.messages(task.id)) {
    assert.equal(revoked.status, 'revoked');
    const html = renderToStaticMarkup(createElement(Message, { message: revoked }));
    assert.match(html, /Отозвано ·/);
    assert.match(html, /Сообщение отозвано при остановке исполнения/);
    assert.doesNotMatch(html, /требования изменились|Задача удаляется/);
  }
});
