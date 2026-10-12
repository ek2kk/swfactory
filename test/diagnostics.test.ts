import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { Scheduler } from '../src/server/scheduler.js';
import { artifactDirectory, readLog, saveArtifact } from '../src/server/artifacts.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-diagnostics-')));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject({ checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github', host: 'github.com', repository: 'owner/repo', target_branch: 'main' });
  const task = store.createTask(project.id, 'test', 1);
  const run = store.queueSpec(project.id, task.id, 1, directory);
  return { directory, store, project, task, run, restart: () => { store.close(); store = new Store(directory); return store; } };
}

test('failed run retry keeps evidence, budget and frozen model; stale/unknown/publication retries are refused', t => {
  const { store, project, task, run, restart } = fixture(t);
  run.status = 'failed'; run.base_sha = 'base'; run.source_hash = 'hash'; run.repair_attempt = 1;
  run.diagnostic = { error_kind: 'authentication', execution_finished: true };
  store.updateRun(run, 'needs-human', 'interrupted');
  const version = store.task(project.id, task.id).state_version;
  assert.throws(() => store.retryRun(project.id, task.id, version - 1));
  store.db.prepare("UPDATE tasks SET publication_status = 'unknown' WHERE id = ?").run(task.id);
  assert.throws(() => store.retryRun(project.id, task.id, version));
  store.db.prepare('UPDATE tasks SET publication_status = NULL WHERE id = ?').run(task.id);
  const retry = store.mutate('retry', 'retry', () => store.retryRun(project.id, task.id, version)) as typeof run;
  assert.equal(retry.parent_run_id, run.id); assert.equal(retry.repair_attempt, 1); assert.deepEqual(retry.config, run.config);
  assert.deepEqual(retry.diagnostic, {}); assert.equal(retry.finished_at, null);
  assert.equal(store.runs()[0].status, 'failed'); assert.throws(() => store.retryRun(project.id, task.id, version));
  const restarted = restart();
  assert.equal(restarted.runs().at(-1)?.status, 'interrupted');
  assert.throws(() => restarted.retryRun(project.id, task.id, restarted.task(project.id, task.id).state_version));
});

test('rate pause is atomic with run failure, survives restart and protects reset time and version', t => {
  const { store, run, restart } = fixture(t);
  run.status = 'failed'; run.diagnostic = { error_kind: 'rate_limit', reset_at: '2099-01-01T00:00:00.000Z', execution_finished: true };
  store.db.exec("CREATE TRIGGER fail_pause BEFORE INSERT ON events WHEN NEW.type = 'execution.paused' BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
  assert.throws(() => store.updateRun(run, 'needs-human', 'interrupted'));
  assert.equal(store.executionPause().paused, 0); assert.equal(store.runs()[0].status, 'queued');
  store.db.exec('DROP TRIGGER fail_pause'); store.updateRun(run, 'needs-human', 'interrupted');
  const next = restart(); assert.equal(next.executionPause().reset_at, run.diagnostic.reset_at);
  assert.throws(() => next.resumeExecution(next.executionPause().state_version));
  next.db.transaction(() => next.pauseExecution(null))();
  assert.equal(next.executionPause().reset_at, null);
  assert.throws(() => next.resumeExecution(1));
  next.db.transaction(() => next.resumeExecution(next.executionPause().state_version))(); assert.equal(next.executionPause().paused, 0);
});

test('paused scheduler releases finished slots and resumes FIFO; shutdown settles queued jobs', async () => {
  let paused = false; const scheduler = new Scheduler(() => !paused); const started: number[] = []; const releases: (() => void)[] = [];
  const jobs = Array.from({ length: 5 }, (_, i) => scheduler.enqueue(String(i), async () => { started.push(i); await new Promise<void>(resolve => releases[i] = resolve); }));
  assert.deepEqual(started, [0, 1, 2]); paused = true; releases[0](); releases[1](); releases[2](); await delay(10);
  assert.deepEqual(started, [0, 1, 2]); paused = false; scheduler.wake(); assert.deepEqual(started, [0, 1, 2, 3, 4]);
  releases[3](); releases[4](); await Promise.all(jobs); paused = true;
  const waiting = scheduler.enqueue('6', async () => { assert.fail('must not start'); }); scheduler.close(); await waiting;
});

test('logs page bounded UTF-8 safely and reject symlinks; saved input secrets are removed', t => {
  const { directory, run } = fixture(t); const path = artifactDirectory(directory, run.id);
  const text = 'я'.repeat(40000); writeFileSync(join(path, 'events.jsonl'), text);
  const first = readLog(directory, run.id, 'events.jsonl', 0); assert.ok(first.next_offset <= 65536); assert.equal(first.more, true);
  const second = readLog(directory, run.id, 'events.jsonl', first.next_offset); assert.equal(first.text + second.text, text);
  assert.throws(() => readLog(directory, run.id, 'events.jsonl', 999999));
  unlinkSync(join(path, 'events.jsonl')); symlinkSync('/etc/passwd', join(path, 'events.jsonl')); assert.throws(() => readLog(directory, run.id, 'events.jsonl', 0));
  saveArtifact(path, 'stderr.log', 'token=abcdefghijklmnop'); assert.ok(!readLog(directory, run.id, 'stderr.log', 0).text.includes('abcdefghijklmnop'));
});

test('structured artifact redaction preserves JSON with escaped quoted config examples', t => {
  const { directory, run } = fixture(t); const path = artifactDirectory(directory, run.id);
  const value = { result: { summary: 'Use token="example" in the config', requirements: ['password="another example"'] }, config: { token: 'hidden-value' } };
  saveArtifact(path, 'result.json', JSON.stringify(value));
  const saved = readFileSync(join(path, 'result.json'), 'utf8');
  const parsed = JSON.parse(saved);
  assert.equal(parsed.result.summary, 'Use token="[REDACTED]" in the config');
  assert.equal(parsed.config.token, '[REDACTED]');
  assert.ok(!saved.includes('hidden-value')); assert.ok(!saved.includes('example'));
});
