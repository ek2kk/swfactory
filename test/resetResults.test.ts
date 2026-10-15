import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { get } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { SpecController } from '../src/server/spec.js';
import { Chat } from '../src/server/chat.js';
import { artifactDirectory, saveArtifact } from '../src/server/artifacts.js';
import { run as gitCommand } from '../src/server/git.js';
import type { AgentRun, Snapshot, SpecResult } from '../src/shared.js';

const origin = 'http://127.0.0.1:4317';
const projectInput = { checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github' as const, host: 'github.com', repository: 'owner/repo', target_branch: 'main' };
const needsInput: SpecResult = { outcome: 'NEEDS_INPUT', title: 'Saved title', summary: 'Old feedback', requirements: [], acceptance_criteria: [], assumptions: [], out_of_scope: [], questions: [{ text: 'Old question', context: 'Old context', impact: 'Old impact', options: [], required: true }] };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-reset-')));
  let commands = 0;
  const options = { directory, origin, generateTitle: async () => 'Title', issueCommand: async () => '[]', command: async () => { commands++; throw new Error('No Git operation expected'); } };
  const current = await createApp(options);
  const project = current.store.addProject(projectInput);
  const f = { ...current, project, directory, headers: {} as Record<string, string>, commands: () => commands,
    async restart() { await f.app.close(); Object.assign(f, await createApp(options)); await authenticate(); },
    post(taskId: string, action: string, payload: object) { return f.app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks/${taskId}/${action}`, headers: f.headers, payload }); },
  };
  async function authenticate() {
    const session = await f.app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token: f.token } });
    f.headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  }
  await authenticate();
  t.after(async () => { await f.app.close(); rmSync(directory, { recursive: true, force: true }); });
  return f;
}

function seed(store: Store, projectId: string, directory: string, state: 'completed' | 'failed' | 'needs-human' = 'needs-human') {
  store.importGithubIssue(projectId, { number: 17, url: 'https://github.com/owner/repo/issues/17', title: 'Original title', description: '  # Original Markdown\r\n\r\n- [x] Exact source  \r\n' });
  let task = store.snapshot().tasks.find(task => task.issue_number === 17)!;
  new Chat(store, () => {}).add(projectId, task.id, task.state_version, 'Applied requirement', 'requirements');
  store.db.prepare("UPDATE tasks SET title = 'Original title', title_state = 'completed' WHERE id = ?").run(task.id);
  task = store.task(projectId, task.id);
  const startRequest = { request_id: randomUUID(), state_version: task.state_version };
  const spec = store.mutate(startRequest.request_id, JSON.stringify(['spec.start', projectId, task.id, task.state_version]), () => store.queueSpec(projectId, task.id, task.state_version, directory)) as AgentRun;
  spec.status = 'completed'; spec.outcome = 'NEEDS_INPUT';
  store.updateRun(spec, 'needs-human', 'waiting', undefined, needsInput);
  const ids = [spec.id];
  for (const role of ['build', 'review-code', 'review-security', 'review-ui-ux', 'approve'] as const) {
    const id = randomUUID();
    store.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version,
      status, branch, worktree, base_sha, parent_run_id, role, spec_run_id, round_id, repair_round_id, repair_attempt, diagnostic, outcome, report)
      SELECT ?, task_id, project_id, description_revision, config, project_version,
      'completed', branch, worktree, base_sha, ?, ?, ?, ?, ?, 2, ?, ?, 1 FROM runs WHERE id = ?`)
      .run(id, ids.at(-1), role, spec.id, ids[1] ?? id, 'old-repair-round', JSON.stringify({ session_id: 'old-session-id', result_saved: true, result_run_id: spec.id, execution_finished: true }), role === 'build' ? 'READY' : role === 'approve' ? 'ESCALATE' : 'PASS', spec.id);
    ids.push(id);
  }
  const build = store.readRun(projectId, task.id, ids[1]);
  store.saveReviewPlan(build, { policy_version: 2, build_id: build.id, head_sha: 'old-head', source_hash: 'old-source', revision: task.revision, diff_base: 'old-base', diff: 'Old diff', requirements: 'Old feedback', checks: [{ role: 'review-security', required: true, reason: 'Old reuse', reuse_run_id: ids[3] }] });
  store.db.prepare('INSERT INTO run_output VALUES (?, ?, ?, 1)').run(spec.id, 'Old agent output', new Date().toISOString());
  store.db.prepare("UPDATE human_requests SET status = 'answered', answers = ? WHERE task_id = ?").run(JSON.stringify(['Old answer']), task.id);
  store.db.prepare('INSERT INTO human_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), task.id, ids.at(-1), task.revision, 'approve', state === 'needs-human' ? 'pending' : 'answered', JSON.stringify(needsInput), JSON.stringify(['publish', 'Old feedback']));
  store.db.prepare(`INSERT INTO chat_messages (id, task_id, revision, run_id, session_id, kind, text, status)
    VALUES (?, ?, ?, ?, 'old-session-id', 'guidance', 'Old guidance', 'delivered')`).run(randomUUID(), task.id, task.revision, spec.id);
  store.db.prepare("UPDATE tasks SET stage = ?, run_state = ?, publication_status = ?, pr_number = ?, pr_url = ? WHERE id = ?")
    .run(state === 'completed' ? 'pr-created' : 'needs-human', state === 'completed' ? 'completed' : state === 'failed' ? 'interrupted' : 'waiting', state === 'completed' ? 'confirmed' : null, state === 'completed' ? 73 : null, state === 'completed' ? 'https://github.com/owner/repo/pull/73' : null, task.id);
  if (state === 'failed') store.db.prepare("UPDATE runs SET status = 'failed', error = 'Old failure' WHERE id = ?").run(ids.at(-1));
  for (const id of ids) {
    const path = artifactDirectory(directory, id);
    saveArtifact(path, 'report.md', 'Old report'); saveArtifact(path, 'events.jsonl', 'Old transcript');
    mkdirSync(join(path, 'nested')); writeFileSync(join(path, 'nested', 'stderr.log'), 'Old log');
  }
  mkdirSync(spec.worktree, { recursive: true }); writeFileSync(join(spec.worktree, 'keep.txt'), 'Git results');
  symlinkSync(spec.worktree, join(directory, 'artifacts', spec.id, 'worktree-link'));
  return { task: store.task(projectId, task.id), ids, spec, startRequest };
}

for (const state of ['completed', 'failed', 'needs-human'] as const) test(`reset ${state} preserves versioned requirements/issue/project/Git, clears every result and survives restart`, async t => {
  const f = await fixture(t);
  const { task, ids, spec, startRequest } = seed(f.store, f.project.id, f.directory, state);
  const revisions = f.store.revisions(f.project.id, task.id), settings = f.store.settings(f.project.id);
  const link = f.store.db.prepare('SELECT * FROM github_issues WHERE task_id = ?').get(task.id);
  const unrelated = artifactDirectory(f.directory, randomUUID()); saveArtifact(unrelated, 'report.md', 'Unrelated');
  const response = await f.post(task.id, 'reset-results', { request_id: randomUUID(), state_version: task.state_version });
  assert.equal(response.statusCode, 200, response.body);
  const saved = f.store.task(f.project.id, task.id);
  for (const key of ['id', 'project_id', 'title', 'description', 'revision', 'issue_number', 'issue_url'] as const) assert.equal(saved[key], task[key], key);
  assert.equal(saved.stage, 'backlog'); assert.equal(saved.run_state, 'idle'); assert.ok(saved.state_version > task.state_version);
  assert.equal(saved.spec_decision, null); assert.equal(saved.publication_status, null); assert.equal(saved.pr_url, null); assert.equal(saved.pr_number, null); assert.equal(saved.has_results, 0); assert.equal(saved.reset_pending, 0);
  assert.deepEqual(f.store.project(f.project.id), f.project); assert.deepEqual(f.store.settings(f.project.id), settings);
  assert.deepEqual(f.store.revisions(f.project.id, task.id), revisions); assert.match(saved.description, /Applied requirement/);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM github_issues WHERE task_id = ?').get(task.id), link);
  for (const table of ['runs', 'run_output', 'review_plans', 'human_requests', 'chat_messages', 'result_cleanups']) assert.equal((f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  for (const id of ids) assert.equal(existsSync(join(f.directory, 'artifacts', id)), false);
  assert.equal(readFileSync(join(spec.worktree, 'keep.txt'), 'utf8'), 'Git results'); assert.equal(existsSync(unrelated), true);
  const events = f.store.events(0); assert.ok(!JSON.stringify(events).includes('old-session-id')); assert.ok(!events.some(event => JSON.parse(event.payload).run_id));
  const history = (await f.app.inject({ url: `/api/projects/${f.project.id}/tasks/${task.id}/history`, headers: f.headers })).json();
  assert.equal(history.resets.length, 1); assert.equal(JSON.parse(history.resets[0].payload).previous_pr?.url ?? null, task.pr_url);
  assert.equal((await f.post(task.id, 'start', startRequest)).statusCode, 409, 'cached old requests cannot return deleted runs or execute them');
  assert.equal((await f.app.inject({ url: `/api/projects/${f.project.id}/tasks/${task.id}/runs/${spec.id}/report`, headers: f.headers })).statusCode, 404);
  assert.equal(f.store.importGithubIssue(f.project.id, { number: 17, title: 'Remote replacement', description: 'Do not overwrite local requirements', url: task.issue_url! }), false);
  assert.equal(f.store.snapshot().tasks.length, 1); assert.equal(f.commands(), 0, 'reset never performs Git or remote operations');
  await f.restart();
  assert.deepEqual(f.store.task(f.project.id, task.id), saved); assert.equal(f.store.runs().length, 0); assert.equal(f.commands(), 0);
});

for (const [name, sql] of [
  ['queued task', "UPDATE tasks SET run_state = 'queued'"], ['running task', "UPDATE tasks SET run_state = 'running'"],
  ['queued title', "UPDATE tasks SET title_state = 'pending'"], ['running title', "UPDATE tasks SET title_state = 'running'"],
  ['queued run', "UPDATE runs SET status = 'queued'"], ['running run', "UPDATE runs SET status = 'running'"],
  ['sending callback', "UPDATE chat_messages SET status = 'sending'"],
  ['unknown execution', 'UPDATE tasks SET execution_unverified = 1'], ['unverified stop', 'UPDATE tasks SET stop_unverified = 1'],
  ['stopping', "UPDATE tasks SET deletion_state = 'stopping'"], ['failed stop', "UPDATE tasks SET deletion_state = 'failed'"],
  ['pending publication', "UPDATE tasks SET publication_status = 'pending'"], ['unknown publication', "UPDATE tasks SET publication_status = 'unknown'"],
  ['manual archive', "UPDATE tasks SET archived = 1, archive_source = 'manual'"],
] as const) test(`reset rejects ${name} without clearing data or restrictions`, async t => {
  const f = await fixture(t); const { task, ids } = seed(f.store, f.project.id, f.directory);
  f.store.db.exec(sql);
  const before = f.store.snapshot(), request_id = randomUUID();
  const response = await f.post(task.id, 'reset-results', { request_id, state_version: task.state_version });
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(f.store.snapshot(), before);
  assert.ok(existsSync(join(f.directory, 'artifacts', ids[0])));
  assert.equal(f.store.db.prepare('SELECT 1 FROM requests WHERE id = ?').get(request_id), undefined);
});

test('ownership, schema, Origin/session and version guards precede all reset side effects', async t => {
  const f = await fixture(t); const { task, ids } = seed(f.store, f.project.id, f.directory);
  const path = `/api/projects/${f.project.id}/tasks/${task.id}/reset-results`, payload = { request_id: randomUUID(), state_version: task.state_version };
  for (const [status, overrides] of [
    [409, { payload: { ...payload, state_version: task.state_version - 1 } }],
    [400, { payload: { ...payload, extra: true } }], [400, { payload: { ...payload, request_id: '../unsafe' } }],
    [404, { url: path.replace(f.project.id, randomUUID()) }],
    [403, { headers: { ...f.headers, origin: 'https://other.example' } }],
    [401, { headers: { ...f.headers, cookie: '' } }],
  ] as const) assert.equal((await f.app.inject({ method: 'POST', url: path, headers: f.headers, payload, ...overrides })).statusCode, status);
  assert.equal(f.store.runs().length, ids.length); assert.ok(existsSync(join(f.directory, 'artifacts', ids[0])));
});

test('concurrent reset/replay and stale requests cannot reset a subsequent explicit run', async t => {
  const f = await fixture(t); const { task } = seed(f.store, f.project.id, f.directory);
  const payload = { request_id: randomUUID(), state_version: task.state_version };
  const responses = await Promise.all([f.post(task.id, 'reset-results', payload), f.post(task.id, 'reset-results', payload)]);
  assert.ok(responses.every(response => response.statusCode === 200)); assert.deepEqual(responses[0].json(), responses[1].json());
  assert.equal(f.store.events(0).filter(event => event.type === 'task.results-reset').length, 1);
  f.store.pauseExecution(null);
  const started = await f.post(task.id, 'start', { request_id: randomUUID(), state_version: f.store.task(f.project.id, task.id).state_version, spec_mode: 'spec' });
  assert.equal(started.statusCode, 200, started.body);
  const run = started.json<AgentRun>(); saveArtifact(artifactDirectory(f.directory, run.id), 'report.md', 'New cycle');
  const before = f.store.snapshot();
  assert.deepEqual((await f.post(task.id, 'reset-results', payload)).json(), responses[0].json());
  assert.equal((await f.post(task.id, 'reset-results', { ...payload, request_id: randomUUID() })).statusCode, 409);
  assert.equal((await f.post(task.id, 'reset-results', { ...payload, state_version: before.tasks[0].state_version })).statusCode, 409, 'same request ID cannot change intent');
  assert.deepEqual(f.store.snapshot(), before); assert.ok(existsSync(join(f.directory, 'artifacts', run.id, 'report.md')));
});

test('failed DB reset rolls back metadata/request and leaves every file intact', async t => {
  const f = await fixture(t); const { task, ids } = seed(f.store, f.project.id, f.directory);
  const before = f.store.snapshot(), payload = { request_id: randomUUID(), state_version: task.state_version };
  f.store.db.exec("CREATE TRIGGER fail_reset BEFORE INSERT ON result_cleanups BEGIN SELECT RAISE(ABORT, 'write failed'); END");
  assert.equal((await f.post(task.id, 'reset-results', payload)).statusCode, 500);
  assert.deepEqual(f.store.snapshot(), before); assert.ok(ids.every(id => existsSync(join(f.directory, 'artifacts', id))));
  assert.equal(f.store.db.prepare('SELECT 1 FROM requests WHERE id = ?').get(payload.request_id), undefined);
});

test('unsafe artifact root fails closed; cleanup journal survives restart and retries without touching symlink targets', async t => {
  const f = await fixture(t); const { task, ids } = seed(f.store, f.project.id, f.directory);
  const root = join(f.directory, 'artifacts'), kept = join(f.directory, 'kept-artifacts');
  renameSync(root, kept); symlinkSync(kept, root);
  const payload = { request_id: randomUUID(), state_version: task.state_version };
  assert.equal((await f.post(task.id, 'reset-results', payload)).statusCode, 409);
  assert.equal(f.store.rawTask(f.project.id, task.id).reset_pending, 1); assert.ok(f.store.rawTask(f.project.id, task.id).reset_error);
  assert.ok(ids.every(id => existsSync(join(kept, id)))); assert.equal(f.store.runs().length, 0);
  const version = f.store.rawTask(f.project.id, task.id).state_version;
  for (const action of ['start', 'archive', 'stop']) assert.equal((await f.post(task.id, action, { request_id: randomUUID(), state_version: version })).statusCode, 409);
  await f.restart(); assert.equal(f.store.rawTask(f.project.id, task.id).reset_pending, 1);
  unlinkSync(root); renameSync(kept, root);
  assert.equal((await f.post(task.id, 'reset-results', payload)).statusCode, 200);
  assert.equal(f.store.task(f.project.id, task.id).reset_pending, 0); assert.ok(ids.every(id => !existsSync(join(root, id))));
});

test('final DB failure after file removal is not success; restart completes the durable cleanup exactly once', async t => {
  const f = await fixture(t); const { task, ids } = seed(f.store, f.project.id, f.directory, 'completed');
  f.store.db.exec("CREATE TRIGGER fail_reset_finish BEFORE INSERT ON events WHEN NEW.type = 'task.results-reset' BEGIN SELECT RAISE(ABORT, 'write failed'); END");
  const payload = { request_id: randomUUID(), state_version: task.state_version };
  assert.equal((await f.post(task.id, 'reset-results', payload)).statusCode, 409);
  assert.ok(ids.every(id => !existsSync(join(f.directory, 'artifacts', id))));
  assert.equal(f.store.rawTask(f.project.id, task.id).reset_pending, 1); assert.ok(f.store.resultsCleanup(task.id));
  f.store.db.exec('DROP TRIGGER fail_reset_finish');
  await f.restart();
  assert.equal(f.store.task(f.project.id, task.id).reset_pending, 0);
  const resets = f.store.events(0).filter(event => event.type === 'task.results-reset');
  assert.equal(resets.length, 1); assert.equal(JSON.parse(resets[0].payload).previous_pr.url, task.pr_url);
  assert.equal((await f.post(task.id, 'reset-results', payload)).statusCode, 200);
  assert.equal(f.store.events(0).filter(event => event.type === 'task.results-reset').length, 1);
});

test('existing stop/reconciliation works without archiving and never clears unknown publication', async t => {
  const f = await fixture(t); const { task } = seed(f.store, f.project.id, f.directory);
  f.store.db.prepare('UPDATE tasks SET stop_unverified = 1 WHERE id = ?').run(task.id);
  const stop = () => f.post(task.id, 'stop', { request_id: randomUUID(), state_version: f.store.rawTask(f.project.id, task.id).state_version });
  assert.equal((await stop()).json().deleted, false);
  assert.equal(f.store.rawTask(f.project.id, task.id).archived, 0);
  const response = await f.post(task.id, 'stop', { request_id: randomUUID(), state_version: f.store.rawTask(f.project.id, task.id).state_version, reconciliation: 'Checked task processes, Codex sessions and descendants: stopped; no remote publication.' });
  assert.equal(response.json().deleted, true); assert.equal(f.store.task(f.project.id, task.id).archived, 0);
  f.store.db.prepare("UPDATE tasks SET stop_unverified = 1, publication_status = 'unknown' WHERE id = ?").run(task.id);
  assert.equal((await stop()).json().deleted, false);
  await f.post(task.id, 'stop', { request_id: randomUUID(), state_version: f.store.rawTask(f.project.id, task.id).state_version, reconciliation: 'Checked stopped processes and remote result: remote publication is still unknown.' });
  assert.equal(f.store.task(f.project.id, task.id).publication_status, 'unknown');
  assert.equal((await f.post(task.id, 'reset-results', { request_id: randomUUID(), state_version: f.store.task(f.project.id, task.id).state_version })).statusCode, 409);
  f.store.db.prepare('UPDATE tasks SET publication_status = NULL WHERE id = ?').run(task.id);
  assert.equal((await f.post(task.id, 'reset-results', { request_id: randomUUID(), state_version: f.store.task(f.project.id, task.id).state_version })).statusCode, 200);
});

test('scheduler completion and in-flight chat callbacks remain reset barriers, even after persisted run completion', async t => {
  const f = await fixture(t); const { task, spec } = seed(f.store, f.project.id, f.directory);
  const controller = new SpecController(f.store, f.directory, () => {});
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(controller as any, 'perform', async () => { entered(); await gate; });
  controller.enqueue(spec); await started;
  f.store.db.prepare('UPDATE tasks SET execution_unverified = 0 WHERE id = ?').run(task.id);
  assert.throws(() => controller.assertResultsResetIdle(task.id), /callbacks/);
  release(); await nextTurn();
  controller.chat.add(f.project.id, task.id, task.state_version, 'Deferred message', 'guidance');
  let delivered!: () => void;
  controller.chat.control(spec, async () => new Promise<void>(resolve => { delivered = resolve; }));
  controller.chat.control(spec, null);
  assert.throws(() => controller.assertResultsResetIdle(task.id), /callbacks/);
  delivered(); await nextTurn(); assert.doesNotThrow(() => controller.assertResultsResetIdle(task.id));
  await controller.close();
  assert.equal((await f.post(task.id, 'reset-results', { request_id: randomUUID(), state_version: f.store.task(f.project.id, task.id).state_version })).statusCode, 200);
  const fresh = f.store.queueSpec(f.project.id, task.id, f.store.task(f.project.id, task.id).state_version, f.directory);
  const before = f.store.snapshot();
  (controller as any).recordMetadata(spec, { session_id: 'late-old-session' });
  (controller as any).registerInterrupt(spec, () => {});
  controller.chat.control(spec, async () => {}); f.store.recordOutput(spec, 'Late old output'); f.store.updateRun(spec, 'needs-human', 'waiting');
  f.store.invalidateReviews(spec);
  assert.deepEqual(f.store.snapshot(), before); assert.deepEqual(controller.chat.context(fresh), []);
});

test('asynchronous Review verification blocks reset until its Git callbacks finish', async t => {
  const f = await fixture(t); const { task, ids } = seed(f.store, f.project.id, f.directory);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const controller = new SpecController(f.store, f.directory, () => {}, async () => { entered(); await gate; throw new Error('Verification finished'); });
  t.mock.method(controller as any, 'requirements', () => ({}));
  const verifying = controller.verifyReviewSource(f.store.readRun(f.project.id, task.id, ids.at(-1)!));
  const failure = assert.rejects(verifying, /Verification finished/);
  await started; assert.throws(() => controller.assertResultsResetIdle(task.id), /callbacks/);
  release(); await failure; assert.doesNotThrow(() => controller.assertResultsResetIdle(task.id));
  await controller.close();
});

for (const resetStage of [undefined, 'review-code'] as const) test(`two SSE clients receive ${resetStage ?? 'full'} reset with matching stages and human requests`, async t => {
  const f = await fixture(t); const { task } = resetStage ? stageSeed(f) : seed(f.store, f.project.id, f.directory);
  if (resetStage) f.store.db.prepare("UPDATE tasks SET publication_status = 'confirmed' WHERE id = ?").run(task.id);
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const address = f.app.server.address(); assert.ok(address && typeof address !== 'string');
  function subscribe() {
    let connected!: () => void; const ready = new Promise<void>(resolve => { connected = resolve; });
    const reset = new Promise<void>((resolve, reject) => {
      let buffer = '', seen = false;
      const request = get(`http://127.0.0.1:${(address as { port: number }).port}/api/events`, { headers: f.headers }, response => response.on('data', chunk => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const entry = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = entry.match(/data: ([^\n]+)/)?.[1]; if (!data) continue;
          if (entry.includes('event: change') && JSON.parse(data).type === 'task.results-reset') seen = true;
          if (entry.includes('event: snapshot')) {
            const snapshot: Snapshot = JSON.parse(data); connected();
            if (seen) {
              const saved = snapshot.tasks.find(t => t.id === task.id)!;
              assert.equal(saved.stage, resetStage ? 'review' : 'backlog'); assert.equal(saved.run_state, 'idle'); assert.equal(saved.reset_pending, 0);
              if (resetStage) {
                assert.equal(snapshot.runs.length, 4);
                assert.ok(!snapshot.runs.some(r => ['review-code', 'approve'].includes(r.role)));
                assert.ok(snapshot.runs.some(r => r.role === 'review-security' && r.outcome === 'PASS'));
                assert.ok(!snapshot.human_requests.some(r => r.role === 'approve'));
              } else { assert.deepEqual(snapshot.runs, []); assert.deepEqual(snapshot.human_requests, []); }
              request.destroy(); resolve();
            }
          }
        }
      }));
      request.on('error', reject); request.setTimeout(3000, () => { request.destroy(); reject(new Error('SSE timeout')); });
      t.after(async () => { request.destroy(); });
    });
    return { ready, reset };
  }
  const a = subscribe(), b = subscribe(); await Promise.all([a.ready, b.ready]);
  assert.equal((await f.post(task.id, 'reset-results', { request_id: randomUUID(), state_version: task.state_version, ...(resetStage ? { stage: resetStage } : {}) })).statusCode, 200);
  await Promise.all([a.reset, b.reset]);
});

test('explicit new Spec fetches current target into a new worktree with no old feedback, answers, sessions or frozen config', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-reset-git-'))), checkout = join(root, 'repo'), remote = join(root, 'remote.git'), directory = join(root, 'data');
  mkdirSync(checkout);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(checkout, 'README.md'), 'initial'); git('add', '.'); git('commit', '-m', 'initial'); git('init', '--bare', remote); git('remote', 'add', 'origin', remote); git('push', 'origin', 'main');
  const store = new Store(directory);
  const project = store.addProject({ ...projectInput, checkout, common_dir: join(checkout, '.git'), remote_url: remote });
  const old = seed(store, project.id, directory);
  rmSync(old.spec.worktree, { recursive: true });
  git('worktree', 'add', '-b', old.spec.branch, old.spec.worktree, 'HEAD');
  const oldHead = git('rev-parse', old.spec.branch);
  const resetController = new SpecController(store, directory, () => {});
  let runner: SpecController | undefined;
  t.after(async () => { await runner?.close(); await resetController.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const resetId = randomUUID();
  store.mutate(resetId, JSON.stringify(['task.reset-results', project.id, old.task.id, old.task.state_version]), () => store.beginResultsReset(project.id, old.task.id, old.task.state_version, resetId));
  resetController.completeResultsReset(old.task.id, resetId);
  writeFileSync(join(checkout, 'README.md'), 'new target'); git('add', '.'); git('commit', '-m', 'new target'); git('push', 'origin', 'main');
  const newHead = git('rev-parse', 'HEAD');
  store.saveSettings(project.id, { ...store.settings(project.id), instructions: 'Fresh project instructions' }, project.state_version);
  const fresh = store.queueSpec(project.id, old.task.id, store.task(project.id, old.task.id).state_version, directory);
  assert.notEqual(fresh.id, old.spec.id); assert.notEqual(fresh.branch, old.spec.branch); assert.notEqual(fresh.worktree, old.spec.worktree);
  assert.equal(fresh.parent_run_id, null); assert.equal(fresh.spec_run_id, null); assert.equal(fresh.round_id, null); assert.equal(fresh.repair_attempt, 0); assert.deepEqual(fresh.diagnostic, {});
  let executed = 0;
  runner = new SpecController(store, directory, () => {}, gitCommand, async input => {
    executed++; assert.match(input.prompt, /Fresh project instructions/); assert.match(input.prompt, /Applied requirement/);
    assert.doesNotMatch(input.prompt, /Old feedback|Old guidance|Old answer|old-session-id|Previous Spec results|Previously delivered/);
    assert.equal(readFileSync(join(input.cwd, 'README.md'), 'utf8'), 'new target');
    return { ...needsInput, summary: 'Fresh specification', questions: [{ ...needsInput.questions[0], text: 'New question' }] };
  });
  runner.enqueue(fresh); await runner.close();
  const saved = store.readRun(project.id, old.task.id, fresh.id);
  assert.equal(saved.status, 'completed', saved.error ?? ''); assert.equal(saved.base_sha, newHead); assert.equal(executed, 1);
  assert.equal(git('rev-parse', old.spec.branch), oldHead); assert.equal(git('rev-parse', 'HEAD'), newHead);
  assert.equal(readFileSync(join(old.spec.worktree, 'README.md'), 'utf8'), 'initial'); assert.equal(store.humanRequests().length, 1);
});

function stageSeed(f: Awaited<ReturnType<typeof fixture>>) {
  const seeded = seed(f.store, f.project.id, f.directory);
  f.store.db.prepare(`UPDATE runs SET repair_round_id = NULL, repair_attempt = 0, diagnostic = '{}',
    base_sha = 'base', head_sha = 'head', source_hash = 'source', stale = 0 WHERE task_id = ?`).run(seeded.task.id);
  f.store.db.prepare("UPDATE runs SET outcome = 'READY', spec_run_id = NULL, round_id = NULL WHERE id = ?").run(seeded.spec.id);
  f.store.db.prepare('UPDATE runs SET round_id = NULL WHERE id = ?').run(seeded.ids[1]);
  f.store.db.prepare("UPDATE tasks SET stage = 'approve', run_state = 'completed' WHERE id = ?").run(seeded.task.id);
  f.store.db.prepare('UPDATE review_plans SET plan = ? WHERE build_id = ?').run(JSON.stringify({ policy_version: 2,
    build_id: seeded.ids[1], head_sha: 'head', source_hash: 'source', revision: seeded.task.revision, diff_base: 'base', diff: 'change', requirements: 'requirements',
    checks: ['review-code', 'review-security', 'review-ui-ux'].map(role => ({ role, required: true, reason: 'Required' })) }), seeded.ids[1]);
  return { ...seeded, task: f.store.task(f.project.id, seeded.task.id) };
}

for (const [role, removedIndexes, next] of [
  ['spec', [0, 1, 2, 3, 4, 5], 'spec'], ['build', [1, 2, 3, 4, 5], 'build'],
  ['review-code', [2, 5], 'review-code'], ['review-security', [3, 5], 'review-security'],
  ['review-ui-ux', [4, 5], 'review-ui-ux'], ['approve', [5], 'approve'],
] as const) test(`stage reset ${role}: exact cascade, independent results, restart, files and durable state`, async t => {
  const f = await fixture(t), { task, ids } = stageSeed(f);
  f.store.pauseExecution(null);
  const pause = f.store.executionPause(), revisions = f.store.revisions(f.project.id, task.id);
  const preview = await f.app.inject({ url: `/api/projects/${f.project.id}/tasks/${task.id}/reset-results/${role}`, headers: f.headers });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json().runs.map((r: AgentRun) => r.id), removedIndexes.map(i => ids[i]));
  assert.equal(preview.json().restart.role, next);
  const payload = { request_id: randomUUID(), state_version: task.state_version, stage: role };
  assert.equal((await f.post(task.id, 'reset-results', payload)).statusCode, 200);
  const saved = f.store.task(f.project.id, task.id);
  assert.equal(saved.run_state, 'idle'); assert.equal(saved.results_restart?.role, next);
  assert.equal(saved.description, task.description); assert.equal(saved.title, task.title); assert.equal(saved.issue_url, task.issue_url);
  assert.deepEqual(f.store.revisions(f.project.id, task.id), revisions); assert.deepEqual(f.store.executionPause(), pause);
  for (let i = 0; i < ids.length; i++) assert.equal(existsSync(join(f.directory, 'artifacts', ids[i])), !removedIndexes.some(index => index === i));
  const kept = f.store.runs();
  for (const run of kept) for (const ref of [run.parent_run_id, run.spec_run_id, run.round_id, run.repair_round_id]) if (ref) assert.ok(kept.some(r => r.id === ref), ref);
  const keptBuild = kept.find(r => r.role === 'build');
  if (keptBuild) assert.equal(f.store.reviewPasses({ ...keptBuild, round_id: ids[1] }), role === 'approve');
  assert.equal(f.commands(), 0, 'reset makes no Git calls and does not enqueue agents');
  await f.restart(); assert.deepEqual(f.store.task(f.project.id, task.id), saved);
  const restarted = await f.post(task.id, 'restart-results', { request_id: randomUUID(), state_version: saved.state_version });
  assert.equal(restarted.statusCode, 200, restarted.body);
  const fresh = f.store.readRun(f.project.id, task.id, restarted.json().id);
  assert.equal(fresh.role, next); assert.ok(!ids.includes(fresh.id)); assert.deepEqual(fresh.diagnostic, {});
  assert.equal(fresh.description_revision, task.revision); assert.equal(fresh.repair_attempt, 0);
  if (next === 'build') { assert.notEqual(fresh.worktree, kept[0].worktree); assert.equal(fresh.base_sha, null); assert.equal(fresh.parent_run_id, null); assert.equal(fresh.spec_run_id, ids[0]); }
  const beforeReplay = f.store.snapshot();
  assert.equal((await f.post(task.id, 'reset-results', payload)).statusCode, 200);
  assert.deepEqual(f.store.snapshot(), beforeReplay);
});

test('reset follows review inputs into repair Build and all later rounds, preserving the predecessor Build', async t => {
  const f = await fixture(t), { task, ids } = stageSeed(f);
  const build2 = randomUUID(), review2 = randomUUID();
  f.store.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version, status, branch, worktree,
    base_sha, head_sha, source_hash, parent_run_id, role, spec_run_id, repair_round_id, repair_attempt, outcome)
    SELECT ?, task_id, project_id, description_revision, config, project_version, 'completed', branch, worktree,
    base_sha, 'head2', 'source2', ?, 'build', spec_run_id, ?, 1, 'READY' FROM runs WHERE id = ?`).run(build2, ids[3], ids[1], ids[1]);
  f.store.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version, status, branch, worktree,
    base_sha, head_sha, source_hash, parent_run_id, role, spec_run_id, round_id, repair_round_id, outcome)
    SELECT ?, task_id, project_id, description_revision, config, project_version, 'completed', branch, worktree,
    base_sha, head_sha, source_hash, id, 'review-code', spec_run_id, id, repair_round_id, 'PASS' FROM runs WHERE id = ?`).run(review2, build2);
  const plan = f.store.resultsResetPlan(f.project.id, task.id, 'review-security');
  assert.deepEqual(new Set(plan.runs.map(r => r.id)), new Set([ids[3], ids[5], build2, review2]));
  assert.equal(plan.restart.build_id, ids[1]); assert.equal(plan.restart.role, 'review-security');
  assert.equal((await f.post(task.id, 'reset-results', { request_id: randomUUID(), state_version: task.state_version, stage: 'review-security' })).statusCode, 200);
  assert.deepEqual(f.store.runs().map(r => r.id), [ids[0], ids[1], ids[2], ids[4]]);
});

for (const mismatch of ['revision', 'spec-project', 'build-project', 'build-stale', 'head', 'source'] as const) test(`reset rejects incompatible prerequisites: ${mismatch}`, async t => {
  const f = await fixture(t), { task, ids } = stageSeed(f);
  if (mismatch === 'revision') f.store.db.prepare('UPDATE tasks SET revision = revision + 1 WHERE id = ?').run(task.id);
  if (mismatch === 'spec-project') f.store.db.prepare('UPDATE runs SET project_version = 0 WHERE id = ?').run(ids[0]);
  if (mismatch === 'build-project') f.store.db.prepare('UPDATE runs SET project_version = 0 WHERE id = ?').run(ids[1]);
  if (mismatch === 'build-stale') f.store.db.prepare('UPDATE runs SET stale = 1 WHERE id = ?').run(ids[1]);
  if (mismatch === 'head' || mismatch === 'source') f.store.db.prepare(`UPDATE runs SET ${mismatch === 'head' ? 'head_sha' : 'source_hash'} = 'mismatch' WHERE id = ?`).run(ids[2]);
  const plan = f.store.resultsResetPlan(f.project.id, task.id, 'approve');
  assert.equal(plan.restart.role, ['revision', 'spec-project'].includes(mismatch) ? 'spec' : ['head', 'source'].includes(mismatch) ? 'review-code' : 'build');
  if (plan.restart.role === 'spec') assert.match(plan.restart.reason, /Сначала требуется новая Spec/);
});

test('deleted PASS cannot reappear through reuse, output caches, feedback or retained parent references', async t => {
  const f = await fixture(t), { task, ids } = stageSeed(f);
  const build = f.store.readRun(f.project.id, task.id, ids[1]), plan = f.store.reviewPlan(build.id)!;
  plan.checks[0].reuse_run_id = ids[2];
  f.store.db.prepare('UPDATE review_plans SET plan = ? WHERE build_id = ?').run(JSON.stringify(plan), build.id);
  f.store.db.prepare('UPDATE runs SET diagnostic = ? WHERE id = ?').run(JSON.stringify({ session_id: 'deleted-review-session' }), ids[2]);
  f.store.db.prepare('INSERT INTO run_output VALUES (?, ?, ?, 1)').run(ids[2], 'Deleted PASS', new Date().toISOString());
  f.store.db.prepare(`INSERT INTO chat_messages (id, task_id, revision, run_id, session_id, kind, text, status)
    VALUES (?, ?, ?, ?, 'deleted-review-session', 'guidance', 'Deleted feedback', 'delivered')`).run(randomUUID(), task.id, task.revision, ids[2]);
  assert.equal((await f.post(task.id, 'reset-results', { request_id: randomUUID(), state_version: task.state_version, stage: 'review-code' })).statusCode, 200);
  assert.equal(f.store.reviewPlan(build.id)!.checks[0].reuse_run_id, undefined);
  assert.equal(f.store.reviewPlan(build.id)!.checks[0].required, true);
  assert.equal(f.store.output(ids[2]), undefined);
  assert.equal(f.store.reviewPasses({ ...build, round_id: build.id }), false);
  assert.doesNotMatch(JSON.stringify(f.store.snapshot()), /deleted-review-session/);
  assert.doesNotMatch(JSON.stringify(new Chat(f.store, () => {}).messages(task.id)), /Deleted feedback/);
});

for (const status of ['pending', 'unknown'] as const) test(`partial reset cannot clear ${status} publication`, async t => {
  const f = await fixture(t), { task } = stageSeed(f);
  f.store.db.prepare('UPDATE tasks SET publication_status = ? WHERE id = ?').run(status, task.id);
  const before = f.store.snapshot();
  assert.equal((await f.post(task.id, 'reset-results', { request_id: randomUUID(), state_version: task.state_version, stage: 'approve' })).statusCode, 409);
  assert.deepEqual(f.store.snapshot(), before);
});

for (const role of ['review-ui', 'review-ux', 'review-ui-ux'] as const) test(`legacy UI/UX compatibility during reset ${role}`, async t => {
  const f = await fixture(t), { task, ids } = stageSeed(f);
  const config = f.store.settings(f.project.id); delete config.models['review-ui-ux']; config.models['review-ui'] = 'legacy'; config.models['review-ux'] = 'legacy';
  f.store.db.prepare('UPDATE runs SET config = ? WHERE task_id = ?').run(JSON.stringify(config), task.id);
  f.store.db.prepare("UPDATE runs SET role = 'review-ui' WHERE id = ?").run(ids[4]);
  const ux = randomUUID();
  f.store.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version, status, branch, worktree,
    base_sha, head_sha, source_hash, parent_run_id, role, spec_run_id, round_id, outcome)
    SELECT ?, task_id, project_id, description_revision, config, project_version, status, branch, worktree,
    base_sha, head_sha, source_hash, id, 'review-ux', spec_run_id, round_id, outcome FROM runs WHERE id = ?`).run(ux, ids[4]);
  const plan = f.store.resultsResetPlan(f.project.id, task.id, role);
  assert.deepEqual(new Set(plan.runs.map(r => r.id)), new Set([ids[5], ...(role !== 'review-ux' ? [ids[4]] : []), ...(role !== 'review-ui' ? [ux] : [])]));
  assert.equal((await f.post(task.id, 'reset-results', { request_id: randomUUID(), state_version: task.state_version, stage: role })).statusCode, 200);
  for (const run of f.store.runs()) if (run.parent_run_id) assert.ok(f.store.hasRun({ id: run.parent_run_id, task_id: task.id }));
});

test('partial cleanup retry keeps the original cascade across restart and cannot expand to a different stage', async t => {
  const f = await fixture(t), { task, ids } = stageSeed(f);
  const root = join(f.directory, 'artifacts'), kept = join(f.directory, 'kept'); renameSync(root, kept); symlinkSync(kept, root);
  const payload = { request_id: randomUUID(), state_version: task.state_version, stage: 'review-code' };
  assert.equal((await f.post(task.id, 'reset-results', payload)).statusCode, 409);
  assert.ok(f.store.resultsCleanup(task.id)); assert.ok(f.store.runs().some(r => r.id === ids[3]));
  await f.restart(); unlinkSync(root); renameSync(kept, root);
  const preview = await f.app.inject({ url: `/api/projects/${f.project.id}/tasks/${task.id}/reset-results/build`, headers: f.headers });
  assert.equal(preview.json().role, 'review-code'); assert.equal(preview.json().state_version, f.store.rawTask(f.project.id, task.id).state_version);
  assert.equal((await f.post(task.id, 'reset-results', { request_id: randomUUID(), state_version: preview.json().state_version, stage: 'build' })).statusCode, 200);
  assert.ok(existsSync(join(root, ids[1]))); assert.ok(existsSync(join(root, ids[3]))); assert.ok(!existsSync(join(root, ids[2])));
  assert.equal(f.store.task(f.project.id, task.id).results_restart?.role, 'review-code');
  assert.equal((await f.post(task.id, 'reset-results', { ...payload, stage: 'build' })).statusCode, 409, 'request replay cannot change its selected stage');
});
