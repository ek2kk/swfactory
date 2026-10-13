import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { Chat } from '../src/server/chat.js';
import { DeliveryError } from '../src/server/interactive.js';
import { readTranscript, transcriptEntry } from '../src/server/transcript.js';
import { artifactDirectory, saveArtifact } from '../src/server/artifacts.js';

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
  saveArtifact(path, 'log-format.json', JSON.stringify({ format: 'redacted-v1' }));
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
