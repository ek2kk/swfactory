import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/server/store.js';
import { SpecController } from '../src/server/spec.js';
import { run as command } from '../src/server/git.js';
import { validateReview, type ExecuteBuild, type ExecuteReview } from '../src/server/codex.js';
import type { BuildResult, SpecResult, ReviewResult } from '../src/shared.js';

const spec: SpecResult = { title: 'Hello', outcome: 'READY', summary: 'Implement hello', requirements: ['Say hello'], acceptance_criteria: ['README says hello'], assumptions: [], out_of_scope: [], questions: [] };
const ready: BuildResult = { outcome: 'READY', summary: 'Implemented', changed_paths: ['README.md'], actions: ['Edited README'], checks: ['Read README: hello'], questions: [] };
async function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-review-'))), checkout = join(root, 'repo'), directory = join(root, 'data');
  mkdirSync(checkout);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(checkout, 'init', '-b', 'main'); git(checkout, 'config', 'user.name', 'Test'); git(checkout, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(checkout, 'README.md'), 'initial'); git(checkout, 'add', '--', 'README.md'); git(checkout, 'commit', '-m', 'initial');
  const remote = join(root, 'remote.git'); git(checkout, 'clone', '--bare', checkout, remote); git(checkout, 'remote', 'add', 'origin', remote);
  const store = new Store(directory);
  t.after(() => { if (store.db.open) store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = store.addProject({ checkout, common_dir: join(checkout, '.git'), remote: 'origin', remote_url: remote, hosting: 'github', host: 'github.com', repository: 'test/repo', target_branch: 'main' });
  const config = store.settings(project.id); config.models.build = 'selected-build'; config.instructions = 'Keep it simple';
  store.saveSettings(project.id, config, 1);
  const task = store.createTask(project.id, 'Say hello', 2);
  const initial = store.queueSpec(project.id, task.id, 1, directory);
  const specRunner = new SpecController(store, directory, () => {}, command, async () => spec);
  specRunner.enqueue(initial); await specRunner.close();
  const queue = () => store.queueBuild(project.id, task.id, store.task(project.id, task.id).state_version);
  const controller = (execute: ExecuteBuild) => new SpecController(store, directory, () => {}, command, undefined, undefined, execute);
  const build = queue();
  const builder = controller(async input => { writeFileSync(join(input.cwd, 'README.md'), 'hello'); return ready; });
  builder.enqueue(build); await builder.close();
  const reviewQueue = () => store.queueReview(project.id, task.id, store.task(project.id, task.id).state_version);
  const reviewer = (execute: ExecuteReview) => new SpecController(store, directory, () => {}, command, undefined, undefined, undefined, execute);
  return { root, checkout, directory, store, project, task, initial, git, build, queue: reviewQueue, controller: reviewer };
}


const pass: ReviewResult = { outcome: 'PASS', summary: 'Looks good', findings: [], evidence: ['Inspected change'], applicable: true, applicability: '', questions: [] };
async function settled(store: Store, taskId: string) {
  for (let i = 0; i < 1000; i++) {
    const task = store.snapshot().tasks.find(t => t.id === taskId)!;
    if (!['queued', 'running'].includes(task.run_state)) return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Review did not settle');
}
test('Review schema: evidence, findings, applicability, question and extra-field guards', () => {
  assert.deepEqual(validateReview(pass, 'review-code'), pass);
  assert.doesNotThrow(() => validateReview({ ...pass, applicable: false, applicability: 'CLI only', evidence: [] }, 'review-ui'));
  for (const result of [null, {}, { ...pass, extra: true }, { ...pass, evidence: [] }, { ...pass, applicable: false },
    { ...pass, outcome: 'CHANGES' }, { ...pass, outcome: 'NEEDS_INPUT' }, { ...pass, findings: ['bug'] }]) assert.throws(() => validateReview(result, 'review-ui'));
  assert.throws(() => validateReview({ ...pass, applicable: false, applicability: 'No code' }, 'review-code'));
});
for (const changes of [false, true]) test(`Four sequential independent reports; CHANGES=${changes} completes round without Build`, async t => {
  const { store, project, task, directory, queue, controller, build } = await fixture(t);
  const seen: string[] = [], directories = new Set<string>();
  let active = 0;
  const runner = controller(async input => {
    assert.equal(active++, 0);
    const role = /You are the ([\w-]+)/.exec(input.prompt)![1]; seen.push(role); directories.add(input.directory);
    assert.match(input.prompt, /README says hello/); assert.match(input.prompt, /Never run Build/);
    assert.equal(store.task(project.id, task.id).stage, 'review');
    assert.throws(() => store.queueBuild(project.id, task.id, store.task(project.id, task.id).state_version));
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return changes && seen.length === 1 ? { ...pass, outcome: 'CHANGES', findings: ['Fix it'] } : pass;
  });
  const first = queue(); assert.throws(queue); runner.enqueue(first);
  const finished = await settled(store, task.id); await runner.close();
  assert.deepEqual(seen, ['review-code', 'review-security', 'review-ui', 'review-ux']); assert.equal(directories.size, 4);
  assert.equal(finished.stage, changes ? 'needs-human' : 'approve');
  const reviews = store.runs().filter(r => r.role.startsWith('review-'));
  for (const r of reviews) {
    assert.equal(r.round_id, build.id); assert.equal(r.head_sha, store.specRun(project.id, task.id, build.id).head_sha);
    assert.equal(r.report, 1); assert.ok(readFileSync(join(directory, 'artifacts', r.id, 'report.md'), 'utf8').includes('Inspected change'));
    const envelope = JSON.parse(readFileSync(join(directory, 'artifacts', r.id, 'result.json'), 'utf8'));
    assert.equal(envelope.spec_revision, r.spec_run_id); assert.equal(envelope.run_id, r.id);
  }
  assert.equal(store.reviewPasses(reviews.at(-1)!), !changes);
  store.close(); const restored = new Store(directory); assert.equal(restored.runs().filter(r => r.report && r.role.startsWith('review-')).length, 4); restored.close();
});
test('Reviewer question pauses next role; answer resumes same role and preserves earlier PASS', async t => {
  const { store, project, task, queue, controller } = await fixture(t);
  const seen: string[] = [];
  const runner = controller(async input => {
    const role = /You are the ([\w-]+)/.exec(input.prompt)![1]; seen.push(role);
    if (seen.length === 2) return { ...pass, outcome: 'NEEDS_INPUT', questions: [{ text: 'Policy?', context: 'Security requirement', impact: 'Verdict', options: ['yes'], required: true }] };
    if (seen.length === 3) assert.match(input.prompt, /approved policy/);
    return pass;
  });
  runner.enqueue(queue()); assert.equal((await settled(store, task.id)).run_state, 'waiting');
  assert.deepEqual(seen, ['review-code', 'review-security']);
  const request = store.humanRequests().at(-1)!;
  assert.throws(() => store.answer(project.id, task.id, request.id, store.task(project.id, task.id).state_version, ['']));
  const next = store.answer(project.id, task.id, request.id, store.task(project.id, task.id).state_version, ['approved policy']).run!;
  assert.equal(next.role, 'review-security');
  assert.throws(() => store.answer(project.id, task.id, request.id, store.task(project.id, task.id).state_version, ['again']));
  runner.enqueue(next); assert.equal((await settled(store, task.id)).stage, 'approve'); await runner.close();
  assert.deepEqual(seen, ['review-code', 'review-security', 'review-security', 'review-ui', 'review-ux']);
});
for (const scenario of ['source-before', 'source-during', 'branch', 'blocked', 'invalid', 'artifact-failure', 'event-failure']) test(`Review ${scenario} blocks continuation and preserves work`, async t => {
  const { store, project, task, queue, controller, git } = await fixture(t);
  const first = queue(); let calls = 0;
  if (scenario === 'source-before') writeFileSync(join(first.worktree, 'README.md'), 'external');
  const runner = controller(async input => {
    calls++;
    if (scenario === 'source-during') writeFileSync(join(input.cwd, 'README.md'), 'keep changes');
    if (scenario === 'branch') git(input.cwd, 'checkout', '-b', 'wrong');
    if (scenario === 'blocked') return { ...pass, outcome: 'BLOCKED', summary: 'Required browser unavailable' };
    if (scenario === 'invalid') return { ...pass, evidence: [] };
    if (scenario === 'artifact-failure') writeFileSync(join(input.directory, 'report.md.tmp'), 'partial');
    if (scenario === 'event-failure') store.db.exec("CREATE TRIGGER fail_review BEFORE INSERT ON events WHEN NEW.type = 'review-code.completed' BEGIN SELECT RAISE(ABORT, 'disk'); END");
    return pass;
  });
  runner.enqueue(first); const finished = await settled(store, task.id); await runner.close();
  assert.equal(finished.stage, 'needs-human'); assert.equal(finished.run_state, 'interrupted'); assert.equal(calls, scenario === 'source-before' ? 0 : 1);
  assert.equal(store.runs().filter(r => r.role.startsWith('review-')).length, 1);
  if (scenario.startsWith('source') || scenario === 'branch') assert.equal(store.specRun(project.id, task.id, first.id).stale, 1);
  if (scenario === 'source-during') assert.equal(readFileSync(join(first.worktree, 'README.md'), 'utf8'), 'keep changes');
});
test('Saved PASS becomes stale when source changes before Approve verification', async t => {
  const { store, task, queue, controller } = await fixture(t);
  const runner = controller(async () => pass); runner.enqueue(queue()); await settled(store, task.id); await runner.close();
  const last = store.runs().at(-1)!; assert.equal(store.reviewPasses(last), true);
  writeFileSync(join(last.worktree, 'README.md'), 'changed');
  await runner.refreshReviewState();
  assert.equal(store.reviewPasses(last), false);
  assert.equal(store.snapshot().tasks.find(t => t.id === task.id)!.stage, 'needs-human');
});
test('Review question survives restart; saved answer does not restart execution', async t => {
  const { store, project, task, directory, queue, controller } = await fixture(t);
  const runner = controller(async () => ({ ...pass, outcome: 'NEEDS_INPUT', questions: [{ text: 'Which browser?', context: 'Required UI check', impact: 'Cannot verify', options: [], required: true }] }));
  runner.enqueue(queue()); await settled(store, task.id); await runner.close();
  const request = store.humanRequests().at(-1)!; store.close();
  const restored = new Store(directory);
  try {
    const current = restored.task(project.id, task.id); assert.equal(current.run_state, 'interrupted');
    assert.equal(restored.answer(project.id, task.id, request.id, current.state_version, ['Configured browser']).run, null);
    assert.equal(restored.runs().filter(r => r.role.startsWith('review-')).length, 1);
  } finally { restored.close(); }
});
test('Failure saving next reviewer rolls back completion and never executes a second role', async t => {
  const { store, task, queue, controller } = await fixture(t);
  let calls = 0; const first = queue();
  store.db.exec("CREATE TRIGGER fail_next BEFORE INSERT ON events WHEN NEW.type = 'review.queued' BEGIN SELECT RAISE(ABORT, 'disk'); END");
  const runner = controller(async () => { calls++; return pass; }); runner.enqueue(first);
  assert.equal((await settled(store, task.id)).run_state, 'interrupted'); await runner.close();
  assert.equal(calls, 1); assert.equal(store.runs().at(-1)!.status, 'failed');
});
test('Review refuses a foreign Spec binding before launching Codex', async t => {
  const { store, project, task, queue, controller } = await fixture(t);
  const first = queue(); first.spec_run_id = first.round_id;
  let calls = 0; const runner = controller(async () => { calls++; return pass; }); runner.enqueue(first);
  await settled(store, task.id); await runner.close();
  assert.equal(calls, 0); assert.equal(store.task(project.id, task.id).stage, 'needs-human');
});

for (const scenario of ['changes', 'cli-error', 'question'] as const) for (const drift of [false, true]) {
  test(`Snapshot rechecks stopped Review: ${scenario}, source drift=${drift}`, async t => {
    const { store, project, task, queue, controller } = await fixture(t);
    let calls = 0;
    const runner = controller(async input => {
      calls++;
      if (scenario === 'changes' && calls === 1) return { ...pass, outcome: 'CHANGES', findings: ['Fix it'] };
      if (scenario === 'cli-error' && calls === 2) {
        if (drift) writeFileSync(join(input.cwd, 'README.md'), 'CLI partial changes');
        throw new Error('CLI failed');
      }
      if (scenario === 'question' && calls === 2) return { ...pass, outcome: 'NEEDS_INPUT', questions: [{ text: 'Policy?', context: 'Review', impact: 'Verdict', options: [], required: true }] };
      return pass;
    });
    runner.enqueue(queue()); await settled(store, task.id); await runner.close();
    assert.equal(store.task(project.id, task.id).stage, 'needs-human');
    const last = store.runs().at(-1)!;
    if (drift && scenario !== 'cli-error') writeFileSync(join(last.worktree, 'README.md'), 'External changes');
    const before = store.snapshot();
    await runner.refreshReviewState();
    const reviews = store.runs().filter(r => r.role.startsWith('review-'));
    assert.equal(reviews.length, scenario === 'changes' ? 4 : 2);
    assert.ok(reviews.every(r => r.stale === (drift ? 1 : 0)));
    assert.equal(runner.error, null);
    if (!drift) assert.deepEqual(store.snapshot(), before);
    const refreshed = store.snapshot();
    await runner.refreshReviewState();
    assert.deepEqual(store.snapshot(), refreshed);
    assert.equal(calls, scenario === 'changes' ? 4 : 2);
  });
}
