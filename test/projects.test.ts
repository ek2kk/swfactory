import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { SpecController } from '../src/server/spec.js';
import { run as command, inspectProject } from '../src/server/git.js';
import { createApp } from '../src/server/app.js';
import { artifactDirectory, saveArtifact } from '../src/server/artifacts.js';
import type { Task, Project } from '../src/shared.js';

test('two repositories execute their own target and frozen settings; linked worktrees are duplicates; restart preserves both', { timeout: 15000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-projects-')));
  const directory = join(root, 'data');
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const projects: Project[] = [];
  const bases: string[] = [];
  for (const [name, remote, target] of [['one', 'origin', 'main'], ['two', 'upstream', 'develop']]) {
    const checkout = join(root, name), bare = join(root, `${name}.git`);
    mkdirSync(checkout);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', target);
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    writeFileSync(join(checkout, 'README.md'), name);
    git('add', '.'); git('commit', '-m', name); git('init', '--bare', bare);
    const remoteUrl = `git@github.com:test/${name}.git`;
    git('remote', 'add', remote, remoteUrl);
    // Keep real fetch/worktree operations local while inspecting a valid hosting URL.
    git('config', `url.${bare}.insteadOf`, remoteUrl);
    git('push', remote, target);
    const inspect = async (path: string) => inspectProject({ checkout: path, remote, target_branch: target, hosting: 'github' }, async (file, args, cwd) => {
      if (file === 'gh') return '';
      // get-url expands insteadOf; inspect the configured hosted identity.
      if (args[0] === 'remote' && args[1] === 'get-url') return remoteUrl;
      return command(file, args, cwd);
    });
    const project = store.addProject(await inspect(checkout));
    projects.push(project); bases.push(git('rev-parse', 'HEAD'));
    const linked = join(root, `${name}-linked`);
    git('worktree', 'add', '-b', 'linked', linked);
    assert.throws(() => store.addProject({ ...project, checkout: linked }), /уже подключён/);
    assert.equal((await inspect(linked)).common_dir, project.common_dir);
    store.saveSettings(project.id, { models: { ...store.settings(project.id).models, spec: `${name}-model` }, instructions: `${name}-instructions` }, 1);
  }
  const runs = projects.map(project => {
    const task = store.createTask(project.id, project.repository, 2);
    return store.queueSpec(project.id, task.id, task.state_version, directory);
  });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const finish = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  const runner = new SpecController(store, directory, () => {}, async (file, args, cwd) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return (await command('git', ['config', '--get', `remote.${args.at(-1)}.url`], cwd));
    }
    return command(file, args, cwd);
  }, async input => {
    const index = runs.findIndex(run => run.worktree === input.cwd);
    assert.ok(index >= 0);
    const name = index === 0 ? 'one' : 'two';
    assert.equal(input.model, `${name}-model`);
    assert.ok(input.prompt.includes(`${name}-instructions`));
    assert.equal(await command('git', ['rev-parse', 'HEAD'], input.cwd), bases[index]);
    seen.push(name);
    if (seen.length === 2) entered();
    await finish;
    return { outcome: 'NEEDS_INPUT', title: name, summary: name, requirements: [], acceptance_criteria: [], assumptions: [], out_of_scope: [],
      questions: [{ text: 'Confirm?', context: name, impact: 'Scope', options: [], required: true }] };
  });
  runs.forEach(run => runner.enqueue(run));
  await started;
  store.saveSettings(projects[0].id, { models: { ...store.settings(projects[0].id).models, spec: 'changed' }, instructions: 'changed' }, 2);
  assert.equal(store.settings(projects[1].id).instructions, 'two-instructions');
  release(); await runner.close();
  assert.equal(seen.length, 2);
  for (const [index, run] of runs.entries()) {
    const saved = store.specRun(run.project_id, run.task_id, run.id);
    assert.equal(saved.status, 'completed');
    assert.equal(saved.base_sha, bases[index]);
    assert.equal(saved.config.instructions, `${index === 0 ? 'one' : 'two'}-instructions`);
  }
  store.close(); store = new Store(directory);
  assert.equal(store.snapshot().projects.length, 2);
  assert.equal(store.snapshot().tasks.length, 2);
  assert.ok(store.snapshot().tasks.every(task => task.run_state === 'interrupted'));
  assert.equal(store.humanRequests().length, 2);
  assert.equal(store.runs()[0].config.instructions, 'one-instructions');
});

test('shared snapshot, project-scoped creation, actions and saved report ownership', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-project-api-')));
  const origin = 'http://127.0.0.1:4317';
  const { app, store, token } = await createApp({ directory, origin, generateTitle: async () => 'Title', inspect: async input => ({
    ...input, common_dir: `${input.checkout}/.git`, remote_url: `git@github.com:test${input.checkout}.git`, host: 'github.com', repository: `test${input.checkout}`,
  }) });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const projects: Project[] = [], tasks: Task[] = [];
  for (const name of ['one', 'two']) {
    const connected = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: {
      request_id: randomUUID(), state_version: 0, checkout: `/${name}`, remote: 'origin', target_branch: 'main', hosting: 'github',
    } });
    assert.equal(connected.statusCode, 200);
    const project = connected.json<Project>(); projects.push(project);
    const created = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks`, headers, payload: { request_id: randomUUID(), state_version: 1, description: name } });
    assert.equal(created.statusCode, 200); tasks.push(created.json<Task>());
  }
  const snapshot = (await app.inject({ url: '/api/snapshot', headers })).json();
  assert.deepEqual(snapshot.tasks.map((task: Task) => task.project_id), projects.map(project => project.id));
  const run = store.queueSpec(projects[0].id, tasks[0].id, 1, directory);
  run.status = 'completed'; run.outcome = 'READY'; run.report = 1;
  store.updateRun(run, 'build', 'idle');
  saveArtifact(artifactDirectory(directory, run.id), 'report.md', 'Project one report');
  const path = `/api/projects/${projects[0].id}/tasks/${tasks[0].id}`;
  assert.equal((await app.inject({ url: `${path}/runs/${run.id}/report`, headers })).json().text, 'Project one report');
  for (const wrong of [path.replace(projects[0].id, projects[1].id), `/api/projects/${projects[1].id}/tasks/${tasks[1].id}`]) {
    for (const suffix of ['/revisions', `/runs/${run.id}/report`]) {
      if (suffix === '/revisions' && wrong.includes(tasks[1].id)) continue;
      assert.equal((await app.inject({ url: wrong + suffix, headers })).statusCode, 404);
    }
  }
  const wrong = path.replace(projects[0].id, projects[1].id);
  for (const action of ['start', 'build']) {
    assert.equal((await app.inject({ method: 'POST', url: `${wrong}/${action}`, headers, payload: { request_id: randomUUID(), state_version: 3 } })).statusCode, 404);
  }
  assert.equal((await app.inject({ method: 'PATCH', url: wrong, headers, payload: { request_id: randomUUID(), state_version: 3, description: 'wrong project' } })).statusCode, 404);
  assert.equal(store.runs().length, 1);
  assert.equal(store.task(projects[1].id, tasks[1].id).description, 'two');
});
