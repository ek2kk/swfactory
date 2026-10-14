import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
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

test('periodic import observes the cooldown, new and newly labelled issues, and unchanged revisions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, project } = fixture(t);
  let remote = [issue(1), issue(2, { labels: [] })], lists = 0, publications = 0;
  const importer = new GithubIssues(store, () => { publications++; }, async args => {
    if (args.at(-1)!.includes('?')) { lists++; return JSON.stringify(remote); }
    return JSON.stringify(remote.find(item => args.at(-1)!.endsWith(`/${item.number}`)));
  });
  try {
    importer.start(); importer.start(); importer.connect(project);
    await importer.settled();
    assert.equal(lists, 1); assert.equal(store.snapshot().tasks.length, 1);
    const before = store.snapshot(), task = before.tasks[0];
    t.mock.timers.tick(59_999); assert.equal(lists, 1);
    t.mock.timers.tick(1); await importer.settled();
    assert.equal(lists, 2); assert.deepEqual(store.snapshot(), before);
    assert.equal(store.revisions(project.id, task.id).length, 1); assert.equal(publications, 1);
    remote = [issue(1), issue(2), issue(3)];
    t.mock.timers.tick(60_000); await importer.settled();
    assert.equal(lists, 3);
    assert.deepEqual(store.snapshot().tasks.map(task => task.issue_number).sort(), [1, 2, 3]);
    assert.ok(store.snapshot().tasks.every(task => task.stage === 'backlog' && task.run_state === 'idle' && task.title_state === 'completed'));
    assert.deepEqual(store.runs(), []);
    const imported = store.snapshot();
    t.mock.timers.tick(60_000); await importer.settled();
    assert.deepEqual(store.snapshot(), imported); assert.equal(publications, 2);
  } finally { await importer.close(); }
});

test('slow imports never overlap or accumulate retries and other projects keep polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, project } = fixture(t);
  const second = store.addProject({ ...projectInput, common_dir: '/second/.git', repository: 'owner/second' });
  store.addProject({ ...projectInput, common_dir: '/lab/.git', hosting: 'gitlab', repository: 'owner/lab' });
  const gate = deferred(), fastRepeat = deferred();
  let slowCalls = 0, fastCalls = 0, slowActive = 0;
  const importer = new GithubIssues(store, () => {}, async args => {
    const endpoint = args.at(-1)!;
    if (endpoint.startsWith(`repos/${second.repository}/`)) {
      fastCalls++;
      if (fastCalls === 2) fastRepeat.resolve();
      return '[]';
    }
    assert.ok(endpoint.startsWith(`repos/${project.repository}/`));
    slowCalls++; slowActive++; assert.equal(slowActive, 1);
    await gate.promise; slowActive--; return '[]';
  });
  try {
    importer.start(); importer.start(); importer.connect(project);
    await nextTurn();
    t.mock.timers.tick(180_000); await fastRepeat.promise;
    assert.equal(slowCalls, 1); assert.equal(fastCalls, 2);
    gate.resolve(); await importer.settled();
    t.mock.timers.tick(59_999); assert.equal(slowCalls, 1);
    importer.connect(project); importer.start(); assert.equal(slowCalls, 1);
    t.mock.timers.tick(1); await importer.settled();
    assert.equal(slowCalls, 2); assert.equal(fastCalls, 3);
    t.mock.timers.tick(60_000); await importer.settled();
    assert.equal(slowCalls, 3); assert.equal(fastCalls, 4);
  } finally { gate.resolve(); await importer.close(); }
});

test('errors retry after cooldown and clear only after a fully successful project pass', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, project } = fixture(t);
  const second = store.addProject({ ...projectInput, common_dir: '/second/.git', repository: 'owner/second' });
  seed(store, project);
  let listingFails = true, closureFails = false, lists = 0;
  const published: NonNullable<Snapshot['issue_errors']>[] = [];
  const importer = new GithubIssues(store, () => { published.push([...importer.errors]); }, async args => {
    if (args.at(-1)!.startsWith(`repos/${second.repository}/`)) throw new Error('token=secret');
    if (args.at(-1)!.includes('?')) {
      lists++;
      if (listingFails) throw new Error('token=secret');
      return '[]';
    }
    if (closureFails) throw new Error('token=secret');
    return JSON.stringify(issue(1));
  });
  try {
    importer.start(); await importer.settled();
    assert.equal(importer.errors.length, 2); assert.ok(!JSON.stringify(importer.errors).includes('secret'));
    listingFails = false; closureFails = true;
    t.mock.timers.tick(59_999); assert.equal(lists, 1);
    t.mock.timers.tick(1); await importer.settled();
    assert.equal(lists, 2); assert.equal(importer.errors.length, 2);
    closureFails = false;
    t.mock.timers.tick(60_000); await importer.settled();
    assert.equal(lists, 3); assert.deepEqual(importer.errors.map(item => item.project_id), [second.id]);
    assert.ok(published.some(errors => errors.length === 1 && errors[0].project_id === second.id));
    assert.equal(store.snapshot().tasks.length, 1);
  } finally { await importer.close(); }
});

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
  assert.throws(() => store.reconcileGithubIssue(project.id, 1, false, 'Исходная GitHub issue закрыта.'), /write failed/);
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
  test(`${protection} blocks remote edits but confirmed closure archives across periodic imports`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
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
    const importer = new GithubIssues(store, () => {}, async args => JSON.stringify(args.at(-1)!.includes('?') ? [issue(1, { body: 'Remote change' })] : issue(1, { state: 'closed' })));
    try {
      importer.start(); await importer.settled();
      for (let pass = 0; pass < 2; pass++) {
        t.mock.timers.tick(60_000); await importer.settled();
        const after = store.rawTask(project.id, task.id);
        assert.equal(after.description, before.description); assert.equal(after.title, before.title);
        assert.equal(after.archived, 1);
        assert.equal(after.archive_source, ['archive', 'delete'].includes(protection) ? before.archive_source : 'github-filter');
        assert.equal(store.events(0).filter(e => e.type === 'task.archived').length, protection === 'delete' ? 0 : 1);
        assert.deepEqual(store.revisions(project.id, task.id), revisions);
        assert.equal((store.db.prepare('SELECT count(*) AS n FROM github_issues').get() as { n: number }).n, 1);
        assert.equal(store.snapshot().tasks.length + store.snapshot().archived_tasks!.length, 1);
      }
    } finally { await importer.close(); }
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
    const after = store.rawTask(project.id, task.id);
    assert.equal(after.description, before.description); assert.equal(after.revision, before.revision);
    assert.equal(after.archived, 1); assert.equal(after.archive_source, action === 'archive' ? 'manual' : 'github-filter');
    assert.equal(after.deletion_state, 'stopping');
  });
}

for (const mismatch of [{ labels: [] }, { state: 'closed' }, { state: 'closed', labels: [] }]) {
  test(`confirmed mismatch archives and restores the same history (${JSON.stringify(mismatch)})`, async t => {
    const { store, project } = fixture(t);
    const task = seed(store, project);
    const failed = await load(store, async args => { if (args.at(-1)!.includes('?')) return '[]'; throw new Error('HTTP 404 secret-token'); });
    assert.equal(failed.errors.length, 1); assert.equal(store.task(project.id, task.id).archived, 0);
    assert.ok(!JSON.stringify(failed.errors).includes('secret-token'));
    await load(store, async args => JSON.stringify(args.at(-1)!.includes('?') ? [] : issue(1, mismatch)));
    assert.equal(store.snapshot().tasks.length, 0);
    assert.equal(store.snapshot().archived_tasks![0].id, task.id);
    assert.equal(store.snapshot().archived_tasks![0].issue_url, task.issue_url);
    assert.equal(store.rawTask(project.id, task.id).archive_source, 'github-filter');
    assert.equal(store.revisions(project.id, task.id).length, 1);
    const cursor = store.snapshot().cursor;
    await load(store, async args => JSON.stringify(args.at(-1)!.includes('?') ? [] : issue(1, mismatch)));
    assert.equal(store.snapshot().cursor, cursor, 'unchanged responses are idempotent');
    await load(store, async args => JSON.stringify(args.at(-1)!.includes('?') ? [issue(1)] : issue(1)));
    assert.equal(store.snapshot().tasks.length, 1); assert.equal(store.snapshot().archived_tasks!.length, 0);
    assert.equal(store.snapshot().tasks[0].id, task.id); assert.equal(store.snapshot().tasks[0].description, task.description);
    assert.equal(store.snapshot().tasks[0].deletion_state, 'stopping', 'visibility does not unblock execution');
    assert.equal(store.runs().length, 0);
  });
}

test('failed later page still applies an individually confirmed mismatch and does not prevent another project', async t => {
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
  assert.equal(store.rawTask(project.id, task.id).archived, 1);
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
  assert.equal(store.db.pragma('user_version', { simple: true }), 16);
  assert.deepEqual(store.task(project.id, task.id), before); assert.deepEqual(store.revisions(project.id, task.id), revisions);
  assert.deepEqual(store.runs(), runs);
  const imported = seed(store, project);
  store.archiveTask(project.id, imported.id, 1); store.finishDeletion(imported.id);
  store.close(); store = new Store(directory);
  seed(store, project);
  assert.equal(store.snapshot().tasks.length, 1); assert.equal(store.snapshot().archived_tasks!.length, 1);
});

test('startup remains available with a hung project; shutdown aborts imports before closing SQLite', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'factory-issues-stop-'));
  const saved = new Store(directory);
  const hung = saved.addProject(projectInput);
  const good = saved.addProject({ ...projectInput, common_dir: '/good/.git', repository: 'owner/good' });
  saved.close();
  let stopped = false, goodLists = 0, calls = 0;
  const aborted = deferred(), finish = deferred();
  const result = await createApp({ directory, origin, issueCommand: async (args, signal) => {
    calls++;
    if (args.at(-1)!.startsWith('repos/owner/good/')) {
      if (args.at(-1)!.includes('?')) { goodLists++; return JSON.stringify([issue(1, {}, good)]); }
      return JSON.stringify(issue(1, {}, good));
    }
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { stopped = true; aborted.resolve(); resolve(); }, { once: true }));
    await finish.promise;
    assert.equal(result.store.db.open, true);
    return JSON.stringify([issue(99)]);
  } });
  t.after(async () => { finish.resolve(); await result.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await result.app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token: result.token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const response = await result.app.inject({ url: '/api/snapshot', headers });
  assert.equal(response.statusCode, 200); assert.equal(response.json<Snapshot>().tasks[0].project_id, good.id);
  const local = await result.app.inject({ method: 'POST', url: `/api/projects/${hung.id}/tasks`, headers,
    payload: { request_id: 'e2448ee4-a06f-4694-9709-4a812cf7d662', state_version: 1, description: 'Local while importing' } });
  assert.equal(local.statusCode, 200);
  t.mock.timers.tick(60_000); await nextTurn(); assert.equal(goodLists, 2);
  const closing = result.app.close(); await aborted.promise;
  assert.equal(stopped, true); assert.equal(result.store.db.open, true);
  const before = result.store.snapshot(), callsBefore = calls;
  result.issues.start(); result.issues.connect(hung);
  assert.equal(calls, callsBefore);
  finish.resolve(); await closing;
  assert.equal(result.store.db.open, false);
  t.mock.timers.tick(180_000); result.issues.start(); assert.equal(calls, callsBefore);
  const restored = new Store(directory);
  try {
    assert.equal(restored.snapshot().tasks.length, before.tasks.length);
    assert.deepEqual(restored.snapshot().tasks.filter(task => task.issue_number), before.tasks.filter(task => task.issue_number));
  }
  finally { restored.close(); }
});

test('closing during cooldown cancels timers and never launches another import', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'factory-issues-cooldown-stop-'));
  const saved = new Store(directory), project = saved.addProject(projectInput);
  saved.close();
  let calls = 0;
  const result = await createApp({ directory, origin, issueCommand: async () => { calls++; return '[]'; } });
  t.after(async () => { await result.app.close(); rmSync(directory, { recursive: true, force: true }); });
  await result.issues.settled(); assert.equal(calls, 1);
  await result.app.close(); assert.equal(result.store.db.open, false);
  t.mock.timers.tick(180_000); result.issues.start(); result.issues.connect(project);
  await result.issues.settled(); assert.equal(calls, 1);
});

test('import creation, updates, archives and safe errors reach an open SSE board', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'factory-issues-sse-'));
  const saved = new Store(directory), project = saved.addProject(projectInput);
  const changed = seed(saved, project, 1), closed = seed(saved, project, 2);
  saved.close();
  const release = deferred();
  let periodic = false;
  const result = await createApp({ directory, origin, issueCommand: async args => {
    const endpoint = args.at(-1)!;
    if (!periodic) return JSON.stringify(endpoint.includes('?') ? [] : issue(endpoint.endsWith('/1') ? 1 : 2));
    await release.promise;
    if (endpoint.includes('?')) return JSON.stringify([issue(1, { body: 'SSE update' }), issue(3)]);
    if (endpoint.endsWith('/1')) throw new Error('HTTP 429 token=do-not-expose');
    return JSON.stringify(issue(2, { state: 'closed', labels: [] }));
  } });
  t.after(async () => { release.resolve(); await result.app.close(); rmSync(directory, { recursive: true, force: true }); });
  await result.issues.settled();
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
            if (!periodic) { periodic = true; t.mock.timers.tick(60_000); }
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

test('connecting a project starts asynchronous import once and publishes the result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'factory-connect-issues-'));
  const gate = deferred(); let calls = 0;
  const result = await createApp({ directory, origin, inspect: async () => projectInput, issueCommand: async args => {
    calls++; await gate.promise; return JSON.stringify(args.at(-1)!.includes('?') ? [issue(42)] : issue(42));
  } });
  t.after(async () => { gate.resolve(); await result.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await result.app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token: result.token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const payload = { checkout: '/test', remote: 'origin', hosting: 'github', target_branch: 'main', state_version: 0, request_id: 'ab3c6ff7-7bb0-4e16-967c-526811d54bb5' };
  const responses = await Promise.all([1, 2].map(() => result.app.inject({ method: 'POST', url: '/api/projects', headers, payload })));
  assert.ok(responses.every(response => response.statusCode === 200)); assert.equal(calls, 1); assert.equal(result.store.snapshot().tasks.length, 0);
  const replay = await result.app.inject({ method: 'POST', url: '/api/projects', headers, payload });
  assert.equal(replay.statusCode, 200); assert.equal(calls, 1);
  result.issues.connect(result.store.snapshot().projects[0]); result.issues.start();
  assert.equal(calls, 1);
  gate.resolve(); await result.issues.settled();
  assert.equal(result.store.snapshot().tasks[0].issue_number, 42);
  assert.ok(result.store.events(0).some(event => event.type === 'task.created'));
  const before = result.store.snapshot();
  t.mock.timers.tick(59_999); assert.equal(calls, 1);
  t.mock.timers.tick(1); await result.issues.settled();
  assert.equal(calls, 3); assert.deepEqual(result.store.snapshot(), before);
});

for (const response of ['not json', 'null', '[]', '{}',
  JSON.stringify(issue(2, { labels: [] })),
  JSON.stringify(issue(1, { labels: [], html_url: 'https://github.com/other/repo/issues/1' })),
  JSON.stringify(issue(1, { labels: [], html_url: 'https://other.host/owner/repo/issues/1' })),
  JSON.stringify(issue(1, { labels: [], pull_request: {}, html_url: 'https://github.com/owner/repo/pull/1' })),
  JSON.stringify(issue(1, { labels: [null], state: 'closed' })),
  JSON.stringify(issue(1, { labels: [], state: ['open'] })),
  JSON.stringify(issue(1, { labels: [], state: ['closed'] })), '404', 'timeout']) {
  test(`individual unconfirmed response preserves an imported card (${response.slice(0, 60)})`, async t => {
    const { store, project } = fixture(t);
    const task = seed(store, project), before = store.rawTask(project.id, task.id);
    const importer = await load(store, async args => {
      if (args.at(-1)!.includes('?')) return '[]';
      if (response === '404' || response === 'timeout') throw new Error(response);
      return response;
    });
    assert.deepEqual(store.rawTask(project.id, task.id), before);
    assert.equal(importer.errors.length, 1);
  });
}

test('manual archive wins a concurrent matching response and can take ownership of an automatic archive', async t => {
  const { store, project } = fixture(t);
  const task = seed(store, project);
  store.reconcileGithubIssue(project.id, 1, false, 'Removed label');
  const entered = deferred(), release = deferred();
  const importer = new GithubIssues(store, () => {}, async args => {
    if (args.at(-1)!.includes('?')) return '[]';
    entered.resolve(); await release.promise; return JSON.stringify(issue(1));
  });
  importer.start(); await entered.promise;
  store.archiveTask(project.id, task.id, store.rawTask(project.id, task.id).state_version);
  release.resolve(); await importer.settled(); await importer.close();
  assert.equal(store.rawTask(project.id, task.id).archive_source, 'manual');
  assert.equal(store.rawTask(project.id, task.id).archived, 1);
  await load(store, async args => JSON.stringify(args.at(-1)!.includes('?') ? [issue(1)] : issue(1)));
  assert.equal(store.rawTask(project.id, task.id).archived, 1);
});

test('v15 migration restores only proven automatic archives and retains visibility and blockers on restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-filter-migration-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput);
  const automatic = seed(store, project, 1), ambiguous = seed(store, project, 2), manual = seed(store, project, 3);
  for (const task of [automatic, ambiguous, manual]) {
    store.db.prepare("UPDATE tasks SET archived = 1, deletion_state = 'deleted' WHERE id = ?").run(task.id);
    store.event('task.archived', task.id, { reason: 'Исходная GitHub issue закрыта.', issue_number: task.issue_number });
  }
  store.event('task.archived', ambiguous.id, {});
  store.event('task.deletion-requested', manual.id, {});
  store.db.exec('ALTER TABLE tasks DROP COLUMN archive_source; ALTER TABLE tasks DROP COLUMN archive_reason; PRAGMA user_version = 15');
  store.close(); store = new Store(directory);
  assert.equal(store.rawTask(project.id, automatic.id).archive_source, 'github-filter');
  assert.equal(store.rawTask(project.id, ambiguous.id).archive_source, 'manual');
  assert.equal(store.rawTask(project.id, manual.id).archive_source, 'manual');
  await load(store, async args => {
    const endpoint = args.at(-1)!;
    return JSON.stringify(endpoint.includes('?') ? [] : issue(Number(endpoint.split('/').at(-1))));
  });
  assert.deepEqual(store.snapshot().tasks.map(task => task.id), [automatic.id]);
  assert.equal(store.snapshot().archived_tasks!.length, 2);
  assert.equal(store.rawTask(project.id, automatic.id).deletion_state, 'deleted');
  store.close(); store = new Store(directory);
  assert.equal(store.snapshot().tasks[0].id, automatic.id);
  assert.equal(store.rawTask(project.id, automatic.id).deletion_state, 'deleted');
  assert.equal(store.runs().length, 0);
  assert.equal(store.revisions(project.id, automatic.id).length, 1);
});

for (const mismatch of [{ labels: [] }, { state: 'closed' }]) test(`two SSE clients receive automatic archive and restore (${JSON.stringify(mismatch)})`, { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'factory-filter-sse-'));
  const saved = new Store(directory), project = saved.addProject(projectInput), task = seed(saved, project);
  const local = saved.createTask(project.id, 'Local card', 1); saved.close();
  let remote = issue(1);
  const result = await createApp({ directory, origin, generateTitle: async () => 'Local card', issueCommand: async args =>
    JSON.stringify(args.at(-1)!.includes('?') ? [] : remote) });
  t.after(async () => { await result.app.close(); rmSync(directory, { recursive: true, force: true }); });
  await result.issues.settled();
  const session = await result.app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token: result.token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  await result.app.listen({ host: '127.0.0.1', port: 0 });
  const address = result.app.server.address(); assert.ok(address && typeof address !== 'string');
  const subscribe = () => {
    let snapshot: Snapshot | undefined;
    const events = new Set<string>();
    const pending: { predicate: (value: Snapshot) => boolean; resolve: (value: Snapshot) => void }[] = [];
    let buffer = '';
    const request = get(`http://127.0.0.1:${address.port}/api/events`, { headers }, response => {
      response.on('data', chunk => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const entry = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = entry.match(/data: ([^\n]+)/)?.[1]; if (!data) continue;
          if (entry.includes('event: change')) events.add(JSON.parse(data).type);
          if (!entry.includes('event: snapshot')) continue;
          snapshot = JSON.parse(data);
          for (let n = pending.length - 1; n >= 0; n--) if (pending[n].predicate(snapshot!)) pending.splice(n, 1)[0].resolve(snapshot!);
        }
      });
    });
    t.after(() => request.destroy());
    const next = (predicate: (value: Snapshot) => boolean) => snapshot && predicate(snapshot)
      ? Promise.resolve(snapshot) : new Promise<Snapshot>(resolve => pending.push({ predicate, resolve }));
    return { next, events };
  };
  const clients = [subscribe(), subscribe()];
  await Promise.all(clients.map(client => client.next(value => value.tasks.some(t => t.id === task.id))));
  remote = issue(1, mismatch); t.mock.timers.tick(60_000); await result.issues.settled();
  const archived = await Promise.all(clients.map(client => client.next(value => !!value.archived_tasks?.some(t => t.id === task.id))));
  for (const snapshot of archived) {
    assert.equal(snapshot.tasks.some(t => t.id === task.id), false);
    assert.equal(snapshot.tasks.some(t => t.id === local.id), true);
    assert.equal(snapshot.archived_tasks![0].archive_source, 'github-filter');
    assert.ok(snapshot.archived_tasks![0].archive_reason);
  }
  remote = issue(1); t.mock.timers.tick(60_000); await result.issues.settled();
  const restored = await Promise.all(clients.map(client => client.next(value => value.tasks.some(t => t.id === task.id))));
  for (const snapshot of restored) {
    assert.equal(snapshot.archived_tasks?.length, 0);
    assert.equal(snapshot.tasks.find(t => t.id === task.id)!.description, task.description);
    assert.equal(snapshot.runs.length, 0);
  }
  for (const client of clients) assert.ok(client.events.has('task.archived') && client.events.has('task.restored'));
});

test('repeated filter cycles and restart retain ID, local edits and unverified stop without new work', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-filter-restart-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject(projectInput), task = seed(store, project);
  store.editTask(project.id, task.id, 'Local description retained', 1);
  await load(store, async args => JSON.stringify(args.at(-1)!.includes('?') ? [] : issue(1, { labels: [] })));
  store.close(); store = new Store(directory);
  assert.equal(store.rawTask(project.id, task.id).archive_source, 'github-filter');
  assert.equal(store.rawTask(project.id, task.id).deletion_state, 'failed');
  assert.equal(store.rawTask(project.id, task.id).stop_unverified, 1);
  for (let cycle = 0; cycle < 3; cycle++) {
    await load(store, async args => JSON.stringify(args.at(-1)!.includes('?') ? [issue(1)] : issue(1)));
    assert.equal(store.snapshot().tasks[0].id, task.id);
    assert.equal(store.snapshot().tasks[0].description, 'Local description retained');
    assert.equal(store.snapshot().tasks[0].stop_unverified, 1);
    const cursor = store.snapshot().cursor;
    await load(store, async args => JSON.stringify(args.at(-1)!.includes('?') ? [issue(1)] : issue(1)));
    assert.equal(store.snapshot().cursor, cursor);
    await load(store, async args => JSON.stringify(args.at(-1)!.includes('?') ? [] : issue(1, { labels: [] })));
    assert.equal(store.snapshot().archived_tasks![0].id, task.id);
    assert.equal(store.snapshot().tasks.length, 0);
  }
  assert.equal(store.runs().length, 0);
  assert.equal(store.revisions(project.id, task.id).length, 2);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 1);
  assert.equal(store.events(0).filter(e => e.type === 'task.archived').length, 4);
  assert.equal(store.events(0).filter(e => e.type === 'task.restored').length, 3);
});
