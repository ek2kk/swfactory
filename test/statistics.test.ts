import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { executeSpec } from '../src/server/codex.js';
import { subscribe } from '../src/server/sse.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { normalizeUsage, observedUsage, threadUsageSnapshot, type UsageAccounting } from '../src/usage.js';
import { formatDuration, periodBounds, statisticsRun, summarizeRuns, type StatisticsRun } from '../src/statistics.js';
import { RunStatistics, StatisticsWindow } from '../src/client/statistics.js';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { SpecController } from '../src/server/spec.js';
import type { RunDiagnostic, Snapshot } from '../src/shared.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/usage.json', import.meta.url), 'utf8'));
const start = '2026-10-15T10:00:00.000Z', finish = '2026-10-15T10:01:00.000Z';
function record(id: string, usage: StatisticsRun['usage'] = {}, patch: Partial<StatisticsRun> = {}): StatisticsRun {
  return { id, task_id: 'task', project_id: 'project', role: 'build', status: 'completed', started_at: start, finished_at: finish, usage, execution: 'observed', ...patch };
}
const count = (input_tokens: number, output_tokens: number, cached_input_tokens: number) => ({ input_tokens, output_tokens, cached_input_tokens });

test('all attempts/stages, failed/interrupted, cached subset, duplicate snapshots and parallel duration', () => {
  const runs = [record('1', count(100, 20, 40)), record('2', count(50, 10, 10), { role: 'review-code', status: 'failed', finished_at: '2026-10-15T10:00:30Z' }),
    record('3', {}, { role: 'spec', status: 'interrupted', finished_at: '2026-10-15T10:00:15Z' })];
  const summary = summarizeRuns([...runs, runs[0]]);
  assert.equal(summary.input.sum, 150n); assert.equal(summary.output.sum, 30n); assert.equal(summary.cached.sum, 50n);
  assert.deepEqual(summary.total, { sum: 180n, known: 2 }); assert.equal(summary.count, 3);
  assert.equal(formatDuration(summary.duration.sum), '1 мин 45 с');
  const stages = [...new Set(runs.map(run => run.role))].map(role => summarizeRuns(runs.filter(run => run.role === role)));
  assert.equal(stages.reduce((sum, stage) => sum + stage.total.sum, 0n), summary.total.sum);
  const parallel = summarizeRuns([record('a'), record('b')]);
  assert.equal(parallel.duration.sum, 120000n); assert.equal(parallel.calendar!.end - parallel.calendar!.start, 60000);
  const separated = summarizeRuns([record('a'), record('b', {}, { started_at: '2026-10-15T11:00:00Z', finished_at: '2026-10-15T11:01:00Z' })]);
  assert.equal(separated.duration.sum, 120000n); assert.equal(separated.calendar!.end - separated.calendar!.start, 3660000);
});

test('unknown and invalid fields preserve other fields; exact zero and safe aggregate overflow', () => {
  for (const invalid of [undefined, -1, '100', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const usage = normalizeUsage({ input_tokens: invalid, output_tokens: 2, cached_input_tokens: 0 });
    assert.deepEqual(usage, { output_tokens: 2, cached_input_tokens: 0 });
    const summary = summarizeRuns([record('a', usage)]);
    assert.deepEqual(summary.input, { sum: 0n, known: 0 }); assert.equal(summary.output.sum, 2n); assert.equal(summary.usageKnown, 0); assert.equal(summary.total.sum, 2n);
  }
  assert.equal(summarizeRuns([record('a', count(0, 0, 0))]).usageKnown, 1);
  const huge = summarizeRuns([record('a', count(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0))]);
  assert.equal(huge.total.sum, 2n * BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(summarizeRuns([record('a', {}, { finished_at: 'invalid' })]).duration.known, 0);
  assert.equal(summarizeRuns([record('a', {}, { finished_at: '2026-10-15T09:00:00Z' })]).duration.known, 0);
});

test('CLI fixture: exec includes cache; cumulative resumed session replaces snapshots, persists baseline, detects resets', () => {
  assert.deepEqual(observedUsage({ usage: fixture.exec.usage, usage_accounting: { version: 1, source: 'exec-turn' } }), count(100, 20, 40));
  const captured = fixture.captured;
  assert.deepEqual(observedUsage({ usage: captured.exec.usage, usage_accounting: { version: 1, source: 'exec-turn' } }), count(17246, 5, 7168));
  const first = captured.appServer[0].params.tokenUsage.total, last = captured.appServer[1].params.tokenUsage.total;
  for (const snapshot of [first, last]) assert.equal(snapshot.totalTokens, snapshot.inputTokens + snapshot.outputTokens, 'real CLI total includes cache only once');
  const capturedAccounting = threadUsageSnapshot({ version: 1, source: 'thread-total', baseline: { session_id: 'captured-session', usage: count(first.inputTokens, first.outputTokens, first.cachedInputTokens) } },
    'captured-session', count(last.inputTokens, last.outputTokens, last.cachedInputTokens));
  assert.deepEqual(observedUsage({ usage_accounting: capturedAccounting }), count(21212, 7, 20992));
  let accounting: Extract<UsageAccounting, { source: 'thread-total' }> = { version: 1, source: 'thread-total', baseline: fixture.baseline };
  for (const event of fixture.appServer) {
    const p = event.params, usage = p.tokenUsage.total;
    accounting = threadUsageSnapshot(accounting, p.threadId, { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cached_input_tokens: usage.cachedInputTokens });
  }
  assert.deepEqual(observedUsage({ usage_accounting: JSON.parse(JSON.stringify(accounting)) }), count(300, 50, 100));
  assert.deepEqual(observedUsage({ usage: fixture.exec.usage }), {}, 'historical unproven snapshots stay unknown');
  assert.deepEqual(observedUsage({ usage_accounting: { ...accounting, baseline: undefined } }), {});
  assert.deepEqual(observedUsage({ usage_accounting: threadUsageSnapshot(accounting, 'other-session', count(1400, 250, 500)) }), {});
  const partial = threadUsageSnapshot(accounting, 'session', { output_tokens: 250, cached_input_tokens: 500 });
  assert.deepEqual(observedUsage({ usage_accounting: threadUsageSnapshot(partial, 'session', count(1200, 250, 500)) }), {}, 'missing intermediate field cannot erase the previous high-water mark');
  const reset = threadUsageSnapshot(accounting, 'session', count(1200, 250, 500));
  assert.deepEqual(observedUsage({ usage_accounting: reset }), {});
  assert.deepEqual(observedUsage({ usage_accounting: threadUsageSnapshot(reset, 'session', count(1400, 270, 550)) }), {}, 'reset stays unknown even if later counters recover');
});

test('physical run identity, saved result aliases, queued/running and terminal unknown completion', () => {
  const base = { ...record('a'), diagnostic: { model_started_at: start, usage: count(100, 20, 40), usage_accounting: { version: 1 as const, source: 'exec-turn' as const } } };
  assert.equal(statisticsRun({ ...base, diagnostic: { ...base.diagnostic, result_run_id: 'original' } }), null);
  assert.equal(statisticsRun({ ...base, status: 'queued' }), null);
  const running = statisticsRun({ ...base, status: 'running', finished_at: null })!;
  const terminal = statisticsRun({ ...base, id: 'terminal', status: 'interrupted', finished_at: null })!;
  const all = summarizeRuns([running, terminal]);
  assert.equal(all.count, 1); assert.equal(all.unknownTime, 1); assert.equal(all.duration.known, 0); assert.equal(all.running.length, 1);
  const limited = summarizeRuns([terminal], { start: 0, end: Date.now() });
  assert.equal(limited.count, 0); assert.equal(limited.excludedUnknownTime, 1);
  const afterRestart = summarizeRuns([terminal], { start: null, end: Date.now() + 999999 });
  assert.equal(afterRestart.calendar, null); assert.equal(afterRestart.running.length, 0);
});

test('browser-local half-open periods, lower/upper boundary, finish attribution, midnight and DST', () => {
  const previous = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    const now = new Date('2026-03-09T16:00:00Z');
    const today = periodBounds('today', now), week = periodBounds('week', now);
    assert.equal(today.start, Date.parse('2026-03-09T04:00:00Z'));
    assert.equal(week.start, Date.parse('2026-03-03T05:00:00Z'));
    assert.equal(periodBounds('today', new Date('2026-03-09T04:00:00Z')).start, today.start);
    const lower = new Date(today.start!).toISOString(), upper = now.toISOString();
    const runs = [record('lower', {}, { finished_at: lower, started_at: '2026-03-01T00:00:00Z' }),
      record('before', {}, { finished_at: new Date(today.start! - 1).toISOString() }), record('upper', {}, { finished_at: upper })];
    assert.deepEqual(summarizeRuns(runs, today).completed.map(run => run.id), ['lower']);
    assert.equal(periodBounds('all', now).start, null);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

const projectInput = { checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github' as const, host: 'github.com', repository: 'owner/repo', target_branch: 'main' };
function seed(store: Store, projectId: string, directory: string) {
  const task = store.createTask(projectId, 'Usage fixture', 1);
  const run = store.queueSpec(projectId, task.id, 1, directory);
  run.status = 'running'; store.updateRun(run, 'spec', 'running');
  run.diagnostic = { model_started_at: start, session_id: 'session', usage: count(100, 20, 40), usage_accounting: { version: 1, source: 'exec-turn' }, execution_finished: true };
  run.status = 'completed'; run.outcome = 'READY'; store.updateRun(run, 'spec', 'completed');
  store.db.prepare('UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?').run(start, finish, run.id);
  store.db.prepare("UPDATE tasks SET run_state = 'idle', title_state = 'completed' WHERE id = ?").run(task.id);
  return { task: store.task(projectId, task.id), run };
}

test('SQLite snapshots include archive, persist across restart, stage/full reset remove only deleted rows; late metadata cannot resurrect', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-statistics-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput);
  const { task, run } = seed(store, project.id, directory);
  const buildId = randomUUID();
  store.db.prepare(`INSERT INTO runs(id, task_id, project_id, description_revision, config, project_version, status, branch, worktree, base_sha, role, diagnostic, started_at, finished_at, spec_run_id)
    SELECT ?, task_id, project_id, description_revision, config, project_version, status, branch, worktree, base_sha, 'build', diagnostic, started_at, finished_at, id FROM runs WHERE id = ?`).run(buildId, run.id);
  const before = store.snapshot().statistics_runs!;
  assert.equal(summarizeRuns(before).total.sum, 240n);
  store.db.prepare('UPDATE tasks SET archived = 1 WHERE id = ?').run(task.id);
  assert.equal(store.snapshot().runs.length, 0); assert.deepEqual(store.snapshot().statistics_runs, before);
  store.close(); store = new Store(directory);
  assert.deepEqual(store.snapshot().statistics_runs, before);
  store.db.prepare('UPDATE tasks SET archived = 0 WHERE id = ?').run(task.id);
  let saved = store.task(project.id, task.id);
  const resetId = randomUUID(); store.beginResultsReset(project.id, task.id, saved.state_version, resetId, 'build'); store.finishResultsReset(task.id, resetId);
  assert.equal(summarizeRuns(store.snapshot().statistics_runs!).total.sum, 120n);
  saved = store.task(project.id, task.id);
  const allReset = randomUUID(); store.beginResultsReset(project.id, task.id, saved.state_version, allReset); store.finishResultsReset(task.id, allReset);
  assert.deepEqual(store.snapshot().statistics_runs, []);
  const controller = new SpecController(store, directory, () => {});
  await (controller as any).recordMetadata(run, { usage: count(999, 999, 999) });
  assert.deepEqual(store.snapshot().statistics_runs, []);
  store.close(); store = new Store(directory); assert.deepEqual(store.snapshot().statistics_runs, []);
});

test('restart keeps interrupted unknown end; stop stamps completion only after process stop is confirmed', t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-statistics-stop-'));
  let store = new Store(directory); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput);
  const { task, run } = seed(store, project.id, directory);
  store.db.prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE id = ?").run(run.id);
  store.db.prepare("UPDATE tasks SET run_state = 'running' WHERE id = ?").run(task.id);
  store.close(); store = new Store(directory);
  const interrupted = store.snapshot().statistics_runs![0];
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.finished_at, null);
  assert.equal(summarizeRuns([interrupted]).unknownTime, 1);
  store.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(run.id);
  store.db.prepare("UPDATE tasks SET run_state = 'running' WHERE id = ?").run(task.id);
  store.beginDeletion(project.id, task.id, store.task(project.id, task.id).state_version);
  const controller = new SpecController(store, directory, () => {});
  (controller as any).recordMetadata(run, { usage: count(150, 30, 50), usage_accounting: { version: 1, source: 'exec-turn' }, result_saved: true, execution_finished: true });
  const stopped = store.readRun(project.id, task.id, run.id);
  assert.equal(stopped.revoked, 1); assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.diagnostic?.result_saved, undefined);
  assert.equal(stopped.diagnostic?.stop_pending, true); assert.equal(stopped.finished_at, null);
  assert.deepEqual(stopped.diagnostic?.usage, count(150, 30, 50));
  store.finishDeletion(task.id, 'Process termination unknown', true);
  assert.equal(store.snapshot().statistics_runs![0].finished_at, null);
  store.finishDeletion(task.id, undefined, true);
  assert.ok(store.snapshot().statistics_runs![0].finished_at);
  store.db.prepare("UPDATE runs SET finished_at = NULL, diagnostic = json_set(diagnostic, '$.stop_pending', json('true')) WHERE id = ?").run(run.id);
  store.close(); store = new Store(directory);
  store.finishDeletion(task.id, undefined, true);
  assert.equal(store.snapshot().statistics_runs![0].finished_at, null, 'a restarted stop cannot invent a historical completion time');
});

test('snapshot API preserves auth/Origin/Host safeguards; mismatched ownership is not exposed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-statistics-api-'));
  const { app, store, token } = await createApp({ directory, origin: 'http://127.0.0.1:4317', issueCommand: async () => '[]', generateTitle: async () => 'Title' });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const p1 = store.addProject(projectInput), p2 = store.addProject({ ...projectInput, checkout: '/other', common_dir: '/other/.git', repository: 'owner/other' });
  const first = seed(store, p1.id, directory); seed(store, p2.id, directory);
  const session = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' }, payload: { token } });
  const headers = { host: '127.0.0.1:4317', cookie: String(session.headers['set-cookie']).split(';')[0] };
  for (const [bad, status] of [[{ host: headers.host }, 401], [{ ...headers, origin: 'https://evil.test' }, 403], [{ ...headers, host: 'evil.test' }, 403]] as const) {
    assert.equal((await app.inject({ url: '/api/snapshot', headers: bad })).statusCode, status);
  }
  const state = (await app.inject({ url: '/api/snapshot', headers })).json<Snapshot>();
  assert.equal(state.statistics_runs!.length, 2);
  assert.equal(summarizeRuns(state.statistics_runs!.filter(run => run.project_id === p1.id)).total.sum, 120n);
  assert.equal(summarizeRuns(state.statistics_runs!).total.sum, 240n);
  assert.equal((await app.inject({ url: `/api/projects/${p2.id}/tasks/${first.task.id}/runs/${first.run.id}/output`, headers })).statusCode, 404);
  store.db.prepare('UPDATE runs SET project_id = ? WHERE id = ?').run(p2.id, first.run.id);
  assert.equal(store.statisticsRuns().length, 1, 'inconsistent task/project ownership is excluded');
});

test('UI distinguishes empty/unknown/zero/partial, preliminary usage and archive; no raw logs required', () => {
  const render = (records?: StatisticsRun[]) => renderToStaticMarkup(createElement(RunStatistics, { records, calendar: true, breakdown: true }));
  assert.match(render(undefined), /Статистика недоступна/); assert.match(render([]), /нет завершённых/);
  assert.match(render([record('unknown')]), /неизвестно/);
  assert.match(render([record('zero', count(0, 0, 0))]), /<dd>0<\/dd>/);
  assert.match(render([record('known', count(100, 20, 40)), record('unknown')]), /частично/);
  assert.match(render([record('running', count(1, 2, 0), { status: 'running', finished_at: null })]), /Предварительно/);
  const snapshot = { projects: [{ ...projectInput, id: 'project', state_version: 1 }], tasks: [], archived_tasks: [{ id: 'task', project_id: 'project', title: 'Archived fixture', archived: 1 }], runs: [], statistics_runs: [record('a', count(100, 20, 40), { finished_at: new Date(Date.now() - 1000).toISOString() })], human_requests: [], cursor: 1 } as unknown as Snapshot;
  const html = renderToStaticMarkup(createElement(StatisticsWindow, { snapshot, initialProject: 'project' }));
  assert.match(html, /Archived fixture/); assert.match(html, /архив/); assert.match(html, /Timezone:/); assert.match(html, /неизменяемый/);
});


for (const scenario of ['exec', 'completed', 'failed', 'interrupted'] as const) test(`wire fixture through ${scenario} adapter saves one physical usage snapshot`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-wire-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = join(directory, 'codex');
  const ready = { outcome: 'READY', title: 'Usage', summary: 'Usage', requirements: ['Usage'], acceptance_criteria: ['Usage'], assumptions: [], out_of_scope: [], questions: [] };
  writeFileSync(cli, `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0); }
const send = value => console.log(JSON.stringify(value));
if(process.argv[2] === 'exec') {
 process.stdin.resume(); process.stdin.on('end', () => {
 send({type:'thread.started',thread_id:'exec-session'}); send({type:'turn.started'});
 send({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify(ready)})}});
 send(${JSON.stringify(fixture.exec)});
 });
} else require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line);
 if(r.method === 'initialize') send({id:r.id,result:{}});
 if(r.method === 'thread/start') send({id:r.id,result:{thread:{id:'session'}}});
 if(r.method === 'turn/start') {
  send({id:r.id,result:{turn:{id:'turn'}}}); send({method:'turn/started',params:{threadId:'session',turn:{id:'turn'}}});
  for(const event of ${JSON.stringify(fixture.appServer)}) send(event);
  send({method:'thread/tokenUsage/updated',params:{threadId:'foreign',turnId:'turn',tokenUsage:{total:{inputTokens:999999}}}});
  send({method:'thread/tokenUsage/updated',params:{threadId:'session',turnId:'other-turn',tokenUsage:{total:{inputTokens:999999}}}});
  send({method:'item/completed',params:{threadId:'session',item:{type:'agentMessage',text:JSON.stringify(${JSON.stringify(ready)})}}});
  send({method:'turn/completed',params:{threadId:'session',turn:{id:'turn',status:${JSON.stringify(scenario)},error:{message:'failed'}}}});
 }
});`, { mode: 0o700 });
  let diagnostic: RunDiagnostic = {};
  const result = executeSpec({ cwd: directory, directory, model: 'fake', prompt: 'usage', ...(scenario === 'exec' ? {} : { control() {} }),
    metadata: value => { diagnostic = { ...diagnostic, ...value }; } }, cli);
  if (scenario === 'exec' || scenario === 'completed') assert.deepEqual(await result, ready); else await assert.rejects(result);
  assert.ok(diagnostic.model_started_at);
  assert.deepEqual(observedUsage(diagnostic), scenario === 'exec' ? count(100, 20, 40) : count(1300, 250, 500));
  assert.deepEqual(observedUsage(JSON.parse(JSON.stringify(diagnostic))), observedUsage(diagnostic));
});

test('metadata snapshots, SSE replay, completion and reset replace statistics instead of adding usage', t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-stats-sse-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput);
  const { task, run } = seed(store, project.id, directory);
  store.db.prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE id = ?").run(run.id);
  store.db.prepare("UPDATE tasks SET run_state = 'running' WHERE id = ?").run(task.id);
  class Response extends EventEmitter {
    chunks: string[] = []; destroyed = false; writableEnded = false;
    write(value: string) { this.chunks.push(value); return true; }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  const response = new Response();
  const subscription = subscribe(response as unknown as ServerResponse, 0, store, () => store.snapshot(), () => {});
  t.after(() => subscription.close());
  const controller = new SpecController(store, directory, () => subscription.update());
  const metadata = { usage: count(100, 20, 40), usage_accounting: { version: 1 as const, source: 'exec-turn' as const } };
  (controller as any).recordMetadata(run, metadata); (controller as any).recordMetadata(run, metadata);
  const snapshots = () => response.chunks.filter(chunk => chunk.includes('event: snapshot')).map(chunk => JSON.parse(chunk.split('data: ')[1]) as Snapshot);
  assert.equal(summarizeRuns(snapshots().at(-1)!.statistics_runs!).count, 0);
  run.status = 'completed'; store.updateRun(run, 'spec', 'completed');
  store.db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(finish, run.id);
  subscription.update(); subscription.update();
  for (const state of snapshots().slice(-2)) assert.equal(summarizeRuns(state.statistics_runs!).total.sum, 120n);
  store.db.prepare("UPDATE tasks SET run_state = 'idle' WHERE id = ?").run(task.id);
  const reset = randomUUID(); store.beginResultsReset(project.id, task.id, store.task(project.id, task.id).state_version, reset); store.finishResultsReset(task.id, reset);
  subscription.update(); (controller as any).recordMetadata(run, metadata); subscription.update();
  assert.deepEqual(snapshots().at(-1)!.statistics_runs, []);
});
