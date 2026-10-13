import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { GithubIssues, githubIssueCommand, type IssueCommand } from '../src/server/issues.js';
import { createApp } from '../src/server/app.js';
import type { Project, Snapshot } from '../src/shared.js';

const projectInput = { checkout: '/test', common_dir: '/test/.git', remote: 'origin', remote_url: 'git@github.com:owner/repo.git', hosting: 'github' as const, host: 'github.com', repository: 'owner/repo', target_branch: 'main' };
const origin = 'http://127.0.0.1:4317';
function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-issues-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput);
  return { store, project, directory };
}
function issue(number: number, overrides: Record<string, unknown> = {}, project: Pick<Project, 'host' | 'repository'> = projectInput) {
  return { number, title: `Issue ${number}`, body: `Markdown **${number}**\n\nBody`, state: 'open', labels: [{ name: 'ready-for-agent' }], html_url: `https://${project.host}/${project.repository}/issues/${number}`, ...overrides };
}
function seed(store: Store, project: Project, number = 1) {
  const data = issue(number, {}, project);
  store.importGithubIssue(project.id, { number, title: data.title, description: data.body, url: data.html_url });
  return store.snapshot().tasks.find(task => task.project_id === project.id && task.issue_number === number)!;
}
async function load(store: Store, command: IssueCommand, publish = () => {}) {
  const importer = new GithubIssues(store, publish, command);
  importer.start(); await importer.settled(); await importer.close(); return importer;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('startup imports all saved GitHub projects with pagination and filtering, without titles/runs or GitLab', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-startup-issues-'));
  const old = new Store(directory);
  const a = old.addProject(projectInput);
  const b = old.addProject({ ...projectInput, checkout: '/two', common_dir: '/two/.git', host: 'github.example.com', repository: 'team/two' });
  old.addProject({ ...projectInput, checkout: '/lab', common_dir: '/lab/.git', hosting: 'gitlab' });
  const local = old.createTask(a.id, 'Local task', 1);
  old.close();
  const calls: string[][] = [];
  let titles = 0;
  const result = await createApp({ directory, origin, generateTitle: async () => { titles++; return 'Unexpected'; }, issueCommand: async args => {
    calls.push(args);
    assert.deepEqual(args.slice(0, 6), ['api', '--hostname', args[2], '--method', 'GET', args[5]]);
    const endpoint = args.at(-1)!;
    assert.ok(endpoint.includes('state=open&labels=ready-for-agent&per_page=100&page='));
    if (args[2] === b.host) return JSON.stringify([issue(1, { body: null }, b)]);
    if (endpoint.endsWith('page=1')) return JSON.stringify(Array.from({ length: 100 }, (_, index) => issue(index + 1)));
    assert.ok(endpoint.endsWith('page=2'));
    return JSON.stringify([issue(101, { body: ' \n\t ' }), issue(102, { labels: [] }), issue(103, { state: 'closed' }),
      issue(104, { pull_request: {}, html_url: 'https://github.com/owner/repo/pull/104' })]);
  } });
  t.after(async () => { await result.app.close(); rmSync(directory, { recursive: true, force: true }); });
  await result.issues.settled();
  const snapshot = result.store.snapshot();
  assert.equal(snapshot.tasks.filter(task => task.project_id === a.id).length, 102);
  assert.equal(snapshot.tasks.filter(task => task.project_id === b.id).length, 1);
  assert.equal(snapshot.tasks.find(task => task.id === local.id)?.description, 'Local task');
  const imported = snapshot.tasks.filter(task => task.issue_number);
  assert.ok(imported.every(task => task.stage === 'backlog' && task.run_state === 'idle' && task.title_state === 'completed'));
  assert.equal(imported.find(task => task.issue_number === 101)?.description, 'Issue 101');
  assert.equal(imported.find(task => task.project_id === b.id)?.description, 'Issue 1');
  assert.equal(imported.find(task => task.issue_number === 1 && task.project_id === a.id)?.description, 'Markdown **1**\n\nBody');
  assert.equal(titles, 0); assert.deepEqual(snapshot.runs, []); assert.equal(calls.length, 3);
});

test('repeat imports persist links, update one description revision, and ignore unchanged/title-only data', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-issue-restart-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput);
  let remote = issue(1);
  const command: IssueCommand = async args => JSON.stringify(args.at(-1)!.includes('?') ? [remote] : remote);
  await load(store, command);
  const task = store.snapshot().tasks[0];
  store.close(); store = new Store(directory);
  await load(store, command);
  assert.equal(store.snapshot().tasks.length, 1); assert.equal(store.task(project.id, task.id).state_version, 1);
  remote = issue(1, { title: 'New title', body: 'Changed **Markdown**' });
  await load(store, command);
  assert.equal(store.task(project.id, task.id).description, 'Changed **Markdown**');
  assert.equal(store.task(project.id, task.id).title, 'New title');
  assert.equal(store.task(project.id, task.id).revision, 2); assert.equal(store.task(project.id, task.id).state_version, 2);
  await load(store, command);
  assert.equal(store.revisions(project.id, task.id).length, 2); assert.equal(store.task(project.id, task.id).state_version, 2);
  remote = issue(1, { title: 'Title only', body: 'Changed **Markdown**' });
  await load(store, command);
  assert.equal(store.task(project.id, task.id).revision, 2); assert.equal(store.task(project.id, task.id).state_version, 3);
  assert.equal(store.revisions(project.id, task.id).length, 2);
  assert.equal(store.events(0).filter(event => event.type === 'task.issue-updated').length, 2);
});

test('failed persistence rolls back new links, description revisions and the import baseline', t => {
  const { store, project } = fixture(t);
  const task = seed(store, project), before = store.rawTask(project.id, task.id);
  store.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'write failed'); END");
  assert.throws(() => store.importGithubIssue(project.id, { number: 2, url: issue(2).html_url, title: 'New', description: 'New' }), /write failed/);
  assert.throws(() => store.importGithubIssue(project.id, { number: 1, url: task.issue_url!, title: 'Changed', description: 'Changed' }), /write failed/);
  assert.throws(() => store.importGithubIssue(project.id, { number: 1, closed: true }), /write failed/);
  assert.deepEqual(store.rawTask(project.id, task.id), before);
  assert.equal(store.revisions(project.id, task.id).length, 1);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM github_issues').get() as { n: number }).n, 1);
  assert.equal((store.db.prepare('SELECT imported_version FROM github_issues').get() as { imported_version: number }).imported_version, 1);
});

test('canonical GitHub URL casing is retained without trusting a different repository or host', async t => {
  const { store } = fixture(t);
  const importer = await load(store, async () => JSON.stringify([issue(1, { html_url: 'https://github.com/Owner/Repo/issues/1' })]));
  assert.deepEqual(importer.errors, []);
  assert.equal(store.snapshot().tasks[0].issue_url, 'https://github.com/Owner/Repo/issues/1');
});

for (const protection of ['local-edit', 'reverted-edit', 'stage', 'queued', 'any-run', 'archive', 'delete'] as const) {
  test(`${protection} blocks remote changes and closure`, async t => {
    const { store, project, directory } = fixture(t);
    const task = seed(store, project);
    if (protection === 'local-edit' || protection === 'reverted-edit') {
      store.editTask(project.id, task.id, 'Local edit', 1);
      if (protection === 'reverted-edit') {
        store.editTask(project.id, task.id, task.description, 2);
        store.claimTitle(store.task(project.id, task.id));
        store.finishTitle(store.task(project.id, task.id), task.title);
      }
    } else if (protection === 'stage') store.db.prepare("UPDATE tasks SET stage = 'build' WHERE id = ?").run(task.id);
    else if (protection === 'queued') store.db.prepare("UPDATE tasks SET run_state = 'queued' WHERE id = ?").run(task.id);
    else if (protection === 'any-run') {
      const run = store.queueSpec(project.id, task.id, 1, directory);
      store.db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(run.id);
      store.db.prepare("UPDATE tasks SET stage = 'backlog', run_state = 'idle', state_version = 1 WHERE id = ?").run(task.id);
    } else if (protection === 'archive') store.archiveTask(project.id, task.id, 1);
    else { store.beginDeletion(project.id, task.id, 1); store.finishDeletion(task.id); }
    const before = store.rawTask(project.id, task.id);
    const revisions = store.revisions(project.id, task.id);
    await load(store, async args => JSON.stringify(args.at(-1)!.includes('?') ? [issue(1, { body: 'Remote change' })] : issue(1, { state: 'closed' })));
    assert.deepEqual(store.rawTask(project.id, task.id), before);
    assert.deepEqual(store.revisions(project.id, task.id), revisions);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM github_issues').get() as { n: number }).n, 1);
    assert.equal(store.snapshot().tasks.length + store.snapshot().archived_tasks!.length, 1);
  });
}

for (const action of ['edit', 'queue', 'archive'] as const) for (const boundary of ['list', 'closure'] as const) {
  test(`concurrent ${action} during ${boundary} request is preserved atomically`, async t => {
    const { store, project, directory } = fixture(t);
    const task = seed(store, project), entered = deferred(), release = deferred();
    const importer = new GithubIssues(store, () => {}, async args => {
      const listing = args.at(-1)!.includes('?');
      if (listing === (boundary === 'list')) { entered.resolve(); await release.promise; }
      return JSON.stringify(listing ? (boundary === 'list' ? [issue(1, { body: 'Remote edit' })] : []) : issue(1, { state: 'closed' }));
    });
    importer.start(); await entered.promise;
    if (action === 'edit') store.editTask(project.id, task.id, 'Concurrent local edit', 1);
    else if (action === 'queue') store.queueSpec(project.id, task.id, 1, directory);
    else store.archiveTask(project.id, task.id, 1);
    const before = store.rawTask(project.id, task.id);
    release.resolve(); await importer.settled(); await importer.close();
    assert.deepEqual(store.rawTask(project.id, task.id), before);
  });
}

test('explicit closure without label archives history permanently; open without label and 404 do not', async t => {
  const { store, project } = fixture(t);
  const task = seed(store, project);
  await load(store, async args => JSON.stringify(args.at(-1)!.includes('?') ? [] : issue(1, { labels: [], body: 'Unlabelled edit' })));
  assert.equal(store.task(project.id, task.id).description, task.description);
  const failed = await load(store, async args => { if (args.at(-1)!.includes('?')) return '[]'; throw new Error('HTTP 404 secret-token'); });
  assert.equal(failed.errors.length, 1); assert.equal(store.task(project.id, task.id).archived, 0);
  assert.ok(!JSON.stringify(failed.errors).includes('secret-token'));
  await load(store, async args => JSON.stringify(args.at(-1)!.includes('?') ? [] : issue(1, { state: 'closed', labels: [] })));
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.snapshot().archived_tasks![0].id, task.id);
  assert.equal(store.snapshot().archived_tasks![0].issue_url, task.issue_url);
  assert.equal(store.revisions(project.id, task.id).length, 1);
  await load(store, async () => JSON.stringify([issue(1)]));
  assert.equal(store.snapshot().tasks.length, 0); assert.equal(store.snapshot().archived_tasks!.length, 1);
});

test('failed later page does not imply closure of missing issues or prevent another project', async t => {
  const { store, project } = fixture(t);
  const task = seed(store, project, 999);
  const second = store.addProject({ ...projectInput, common_dir: '/second/.git', repository: 'owner/second' });
  const importer = await load(store, async args => {
    const endpoint = args.at(-1)!;
    if (endpoint.startsWith('repos/owner/second/')) return JSON.stringify([issue(1, {}, second)]);
    if (endpoint.endsWith('page=1')) return JSON.stringify(Array.from({ length: 100 }, (_, n) => issue(n + 1)));
    if (endpoint.endsWith('page=2')) throw new Error('credential raw stderr');
    assert.ok(endpoint.endsWith('/999')); return JSON.stringify(issue(999, { labels: [] }));
  });
  assert.equal(store.task(project.id, task.id).archived, 0);
  assert.equal(store.snapshot().tasks.filter(task => task.project_id === second.id).length, 1);
  assert.equal(importer.errors.length, 1); assert.ok(!JSON.stringify(importer.errors).includes('credential'));
});

for (const bad of ['not json', '{}', '[null]', JSON.stringify([issue(1, { number: -1 })]), JSON.stringify([issue(1, { body: 42 })]),
  JSON.stringify([issue(1, { body: 'x'.repeat(100_001) })]), JSON.stringify([issue(1, { html_url: 'javascript:alert(1)' })]),
  JSON.stringify([issue(1, { labels: [null] })])]) {
  test(`invalid external data is rejected without truncation (${bad.slice(0, 40)})`, async t => {
    const { store } = fixture(t);
    const importer = await load(store, async () => bad);
    assert.equal(store.snapshot().tasks.length, 0); assert.equal(importer.errors.length, 1);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM task_revisions').get() as { n: number }).n, 0);
    assert.equal(store.runs().length, 0);
  });
}

test('v14 migration keeps local tasks, revisions and run history and adds persistent tombstones', t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-issue-migration-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput), task = store.createTask(project.id, 'Keep revision', 1);
  const run = store.queueSpec(project.id, task.id, 1, directory); run.status = 'completed'; run.outcome = 'READY';
  store.updateRun(run, 'build', 'idle', 'Keep title');
  const before = store.task(project.id, task.id), revisions = store.revisions(project.id, task.id), runs = store.runs();
  store.db.exec('DROP TABLE github_issues; PRAGMA user_version = 14');
  store.close(); store = new Store(directory);
  assert.equal(store.db.pragma('user_version', { simple: true }), 15);
  assert.deepEqual(store.task(project.id, task.id), before); assert.deepEqual(store.revisions(project.id, task.id), revisions);
  assert.deepEqual(store.runs(), runs);
  const imported = seed(store, project);
  store.archiveTask(project.id, imported.id, 1); store.finishDeletion(imported.id);
  store.close(); store = new Store(directory);
  seed(store, project);
  assert.equal(store.snapshot().tasks.length, 1); assert.equal(store.snapshot().archived_tasks!.length, 1);
});

test('startup remains available with a hung project; shutdown aborts imports before closing SQLite', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-issues-stop-'));
  const saved = new Store(directory);
  const hung = saved.addProject(projectInput);
  const good = saved.addProject({ ...projectInput, common_dir: '/good/.git', repository: 'owner/good' });
  saved.close();
  let stopped = false;
  const result = await createApp({ directory, origin, issueCommand: async (args, signal) => {
    if (args.at(-1)!.startsWith('repos/owner/good/')) return JSON.stringify([issue(1, {}, good)]);
    return new Promise((_, reject) => signal.addEventListener('abort', () => { stopped = true; reject(new Error('stopped')); }, { once: true }));
  } });
  t.after(async () => { await result.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await result.app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token: result.token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const response = await result.app.inject({ url: '/api/snapshot', headers });
  assert.equal(response.statusCode, 200); assert.equal(response.json<Snapshot>().tasks[0].project_id, good.id);
  const local = await result.app.inject({ method: 'POST', url: `/api/projects/${hung.id}/tasks`, headers,
    payload: { request_id: 'e2448ee4-a06f-4694-9709-4a812cf7d662', state_version: 1, description: 'Local while importing' } });
  assert.equal(local.statusCode, 200);
  await result.app.close(); assert.equal(stopped, true); assert.equal(result.store.db.open, false);
  await delay(10);
});

test('import creation, updates, archives and safe errors reach an open SSE board', { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-issues-sse-'));
  const saved = new Store(directory), project = saved.addProject(projectInput);
  const changed = seed(saved, project, 1), closed = seed(saved, project, 2);
  saved.close();
  const release = deferred();
  const result = await createApp({ directory, origin, issueCommand: async args => {
    await release.promise;
    const endpoint = args.at(-1)!;
    if (endpoint.includes('?')) return JSON.stringify([issue(1, { body: 'SSE update' }), issue(3)]);
    if (endpoint.endsWith('/1')) throw new Error('HTTP 429 token=do-not-expose');
    return JSON.stringify(issue(2, { state: 'closed', labels: [] }));
  } });
  t.after(async () => { release.resolve(); await result.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await result.app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token: result.token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  await result.app.listen({ host: '127.0.0.1', port: 0 });
  const address = result.app.server.address(); assert.ok(address && typeof address !== 'string');
  const events = new Set<string>();
  const completed = new Promise<Snapshot>((resolve, reject) => {
    let buffer = '';
    const request = get(`http://127.0.0.1:${address.port}/api/events`, { headers }, response => {
      response.on('data', chunk => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const entry = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = entry.match(/data: ([^\n]+)/)?.[1]; if (!data) continue;
          if (entry.includes('event: change')) events.add(JSON.parse(data).type);
          if (entry.includes('event: snapshot')) {
            const snapshot = JSON.parse(data) as Snapshot;
            release.resolve();
            if (snapshot.archived_tasks?.some(task => task.id === closed.id) && snapshot.issue_errors?.length) {
              request.destroy(); resolve(snapshot);
            }
          }
        }
      });
    });
    request.on('error', reject); request.setTimeout(3000, () => { request.destroy(); reject(new Error('SSE timeout')); });
  });
  const snapshot = await completed;
  assert.equal(snapshot.tasks.find(task => task.id === changed.id)?.description, 'SSE update');
  assert.equal(snapshot.tasks.find(task => task.issue_number === 3)?.issue_url, 'https://github.com/owner/repo/issues/3');
  assert.ok(events.has('task.created') && events.has('task.issue-updated') && events.has('task.archived'));
  assert.ok(!JSON.stringify(snapshot.issue_errors).includes('do-not-expose'));
  await result.issues.settled();
  assert.deepEqual((await result.app.inject({ url: '/api/snapshot', headers })).json<Snapshot>().issue_errors, snapshot.issue_errors);
});

test('gh adapter uses bounded noninteractive read-only commands and safe errors, and kills on abort/timeout', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-fake-gh-'));
  const bin = join(directory, 'bin'); mkdirSync(bin);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; rmSync(directory, { recursive: true, force: true }); });
  const executable = join(bin, 'gh');
  writeFileSync(executable, '#!/bin/sh\n[ "$GH_PROMPT_DISABLED" = 1 ] || exit 9\nprintf \'[]\'\n', { mode: 0o700 });
  assert.equal(await githubIssueCommand(['api', '--hostname', 'github.com', '--method', 'GET', 'repos/owner/repo/issues'], new AbortController().signal), '[]');
  writeFileSync(executable, '#!/bin/sh\nprintf \'HTTP 401 token=do-not-expose\' >&2\nexit 1\n');
  await assert.rejects(githubIssueCommand(['api'], new AbortController().signal), error => {
    assert.ok(error instanceof Error); assert.ok(error.message.includes('Авторизация')); assert.ok(!error.message.includes('do-not-expose')); return true;
  });
  writeFileSync(executable, '#!/bin/sh\nprintf \'HTTP 429 token=do-not-expose\' >&2\nexit 1\n');
  await assert.rejects(githubIssueCommand(['api'], new AbortController().signal), /rate limit/);
  writeFileSync(executable, '#!/bin/sh\nexec sleep 30\n');
  const controller = new AbortController(), pending = githubIssueCommand(['api'], controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /время ожидания/);
  const started = Date.now();
  await assert.rejects(githubIssueCommand(['api'], new AbortController().signal), /время ожидания/);
  assert.ok(Date.now() - started < 18000);
});
