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
async function fixture(t: { after: (fn: () => void) => void }, completedRepairs = 2, content = 'hello') {
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
  const controller = (execute: ExecuteBuild) => new SpecController(store, directory, () => {}, command, undefined, undefined, execute, undefined, approved);
  const build = queue();
  const builder = controller(async input => { writeFileSync(join(input.cwd, 'README.md'), content); return ready; });
  builder.enqueue(build); await builder.close();
  store.db.prepare('UPDATE runs SET repair_attempt = ? WHERE id = ?').run(completedRepairs, build.id);
  const reviewQueue = () => store.queueReview(project.id, task.id, store.task(project.id, task.id).state_version);
  const reviewer = (execute: ExecuteReview) => new SpecController(store, directory, () => {}, command, undefined, undefined, undefined, execute, approved);
  return { root, checkout, directory, store, project, task, initial, git, build, queue: reviewQueue, controller: reviewer };
}


const approved = async () => ({ outcome: 'APPROVE' as const, summary: 'Publish only', risks: [], affected_paths: ['README.md'], questions: [] });
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

for (const passAfterRepair of [false, true]) test(`Repair aggregates every reviewer, caps at two and reviews each version; pass=${passAfterRepair}`, async t => {
  const { store, project, task, directory, queue } = await fixture(t, 0);
  let builds = 0, reviews = 0;
  const runner = new SpecController(store, directory, () => {}, command, undefined, undefined, async input => {
    builds++;
    for (const role of ['review-code', 'review-security', 'review-ui', 'review-ux']) assert.ok(input.prompt.includes(`Finding ${role}`));
    writeFileSync(join(input.cwd, 'README.md'), `hello repair ${builds}`);
    return ready;
  }, async input => {
    reviews++;
    const role = /You are the ([\w-]+)/.exec(input.prompt)![1];
    return passAfterRepair && builds ? pass : { ...pass, outcome: 'CHANGES', findings: [`Finding ${role}`] };
  }, approved);
  runner.enqueue(queue());
  assert.equal((await settled(store, task.id)).stage, passAfterRepair ? 'approve' : 'needs-human');
  assert.equal(builds, passAfterRepair ? 1 : 2);
  assert.equal(reviews, (builds + 1) * 4);
  const history = store.runs();
  assert.equal(new Set(history.filter(r => r.role.startsWith('review-')).map(r => r.round_id)).size, builds + 1);
  assert.equal(history.at(-1)!.repair_attempt, builds);
  if (!passAfterRepair) {
    const version = store.task(project.id, task.id).state_version;
    assert.throws(() => store.queueRepair(project.id, task.id, version));
    assert.throws(() => store.queueRepair(project.id, task.id, version - 1, true));
    const next = store.mutate('manual-repair', 'repair', () => store.queueRepair(project.id, task.id, version, true));
    assert.deepEqual(store.mutate('manual-repair', 'repair', () => { throw new Error('duplicate'); }), next);
    assert.throws(() => store.queueRepair(project.id, task.id, version, true));
    runner.enqueue(next as ReturnType<Store['queueRepair']>);
    await settled(store, task.id);
    assert.equal(builds, 4);
    assert.equal(store.runs().at(-1)!.repair_attempt, 2);
    assert.ok(store.runs().length > history.length);
  }
  await runner.close();
  const expected = store.runs(); store.close();
  const restored = new Store(directory); assert.deepEqual(restored.runs(), expected); restored.close();
});
for (const failure of ['cli', 'invalid', 'question', 'save'] as const) test(`Repair ${failure} does not consume budget`, async t => {
  const { store, project, task, directory, queue } = await fixture(t, 0);
  let builds = 0;
  const runner = new SpecController(store, directory, () => {}, command, undefined, undefined, async input => {
    builds++;
    if (failure === 'cli') throw new Error('CLI failed');
    if (failure === 'invalid') return {} as BuildResult;
    if (failure === 'question' && builds === 1) return { ...ready, outcome: 'NEEDS_INPUT', questions: [{ text: 'Which?', context: 'Choice', impact: 'Implementation', options: [], required: true }] };
    writeFileSync(join(input.cwd, 'README.md'), `repaired ${builds}`);
    if (failure === 'save') store.db.exec("CREATE TRIGGER fail_repair BEFORE INSERT ON events WHEN NEW.type = 'build.completed' BEGIN SELECT RAISE(ABORT, 'disk'); END");
    return ready;
  }, async () => builds ? pass : { ...pass, outcome: 'CHANGES', findings: ['Fix it'] }, approved);
  runner.enqueue(queue()); await settled(store, task.id);
  assert.equal(store.runs().at(-1)!.repair_attempt, 0);
  if (failure === 'question') {
    const request = store.humanRequests().at(-1)!;
    const next = store.answer(project.id, task.id, request.id, store.task(project.id, task.id).state_version, ['Use hello']).run!;
    runner.enqueue(next); assert.equal((await settled(store, task.id)).stage, 'approve');
    assert.equal(store.runs().at(-1)!.repair_attempt, 1);
  }
  await runner.close();
});

test('Repair queue failure rolls back round completion and never starts Build', async t => {
  const { store, task, directory, queue } = await fixture(t, 0);
  let builds = 0;
  store.db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON events WHEN NEW.type = 'repair.queued' BEGIN SELECT RAISE(ABORT, 'disk'); END");
  const runner = new SpecController(store, directory, () => {}, command, undefined, undefined, async () => { builds++; return ready; },
    async () => ({ ...pass, outcome: 'CHANGES', findings: ['Fix it'] }));
  runner.enqueue(queue()); await settled(store, task.id); await runner.close();
  assert.equal(builds, 0); assert.equal(store.runs().at(-1)!.status, 'failed');
  assert.equal(store.runs().at(-1)!.repair_attempt, 0);
});

test('Approve structured schema rejects prose and incomplete decisions', async () => {
  const { validateApprove } = await import('../src/server/codex.js');
  assert.deepEqual(validateApprove(await approved()), await approved());
  for (const value of ['готово', {}, { ...await approved(), outcome: 'PASS' }, { ...await approved(), outcome: 'ESCALATE' }, { ...await approved(), outcome: 'NEEDS_INPUT' }, { ...await approved(), extra: true }]) assert.throws(() => validateApprove(value));
});
for (const decision of ['publish', 'repair'] as const) test(`Escalation ${decision} binds request/version and invalidates dependent decisions`, async t => {
  const { store, project, task, directory, queue } = await fixture(t);
  let calls = 0;
  const runner = new SpecController(store, directory, () => {}, command, undefined, undefined, undefined, async () => pass, async input => {
    calls++;
    assert.match(input.prompt, /README says hello/); assert.match(input.prompt, /Inspect the complete changes.*immutable base_sha/);
    for (const role of ['review-code', 'review-security', 'review-ui', 'review-ux']) assert.ok(input.prompt.includes(role));
    return { ...await approved(), outcome: 'ESCALATE', risks: ['Check rollout'] };
  });
  runner.enqueue(queue()); await settled(store, task.id); await runner.close();
  assert.equal(calls, 1);
  const request = store.humanRequests().at(-1)!, version = store.task(project.id, task.id).state_version;
  assert.throws(() => store.decide(project.id, task.id, request.id, version - 1, decision, 'fix rollout'));
  assert.throws(() => store.decide(project.id, 'foreign', request.id, version, decision, 'fix rollout'));
  store.db.exec("CREATE TRIGGER fail_decision BEFORE INSERT ON events WHEN NEW.type = 'approve.decided' BEGIN SELECT RAISE(ABORT, 'disk'); END");
  assert.throws(() => store.decide(project.id, task.id, request.id, version, decision, 'fix rollout'));
  assert.equal(store.humanRequests().at(-1)!.status, 'pending');
  assert.equal(store.task(project.id, task.id).state_version, version);
  store.db.exec('DROP TRIGGER fail_decision');
  const result = store.mutate('decision', decision, () => store.decide(project.id, task.id, request.id, version, decision, 'fix rollout')) as { run: import('../src/shared.js').AgentRun | null };
  assert.deepEqual(store.mutate('decision', decision, () => { throw new Error('duplicate'); }), result);
  assert.throws(() => store.decide(project.id, task.id, request.id, version, decision, 'again'));
  if (decision === 'publish') {
    assert.equal(result.run, null); assert.equal(store.task(project.id, task.id).run_state, 'completed');
    writeFileSync(join(store.runs().at(-1)!.worktree, 'README.md'), 'external');
    await runner.refreshReviewState();
    assert.equal(store.task(project.id, task.id).stage, 'needs-human');
    assert.equal(store.humanRequests().at(-1)!.status, 'revoked');
  } else {
    assert.equal(result.run!.role, 'build');
    assert.ok(store.runs().filter(r => r.role.startsWith('review-') || r.role === 'approve').every(r => r.stale));
    assert.equal(store.humanRequests().at(-1)!.status, 'answered');
    const repair = new SpecController(store, directory, () => {}, command, undefined, undefined, async input => {
      assert.match(input.prompt, /fix rollout/); writeFileSync(join(input.cwd, 'README.md'), 'repaired'); return ready;
    });
    repair.enqueue(result.run!); await repair.close();
    assert.equal(store.runs().at(-1)!.outcome, 'READY');
  }
  const history = store.humanRequests(); store.close(); const restored = new Store(directory);
  assert.deepEqual(restored.humanRequests(), history); restored.close();
});
for (const mode of ['question', 'drift', 'invalid', 'save'] as const) test(`Approve ${mode} blocks unauthorized continuation`, async t => {
  const { store, project, task, directory, queue } = await fixture(t);
  let calls = 0;
  const runner = new SpecController(store, directory, () => {}, command, undefined, undefined, undefined, async () => pass, async input => {
    calls++;
    if (mode === 'question' && calls === 1) return { ...await approved(), outcome: 'NEEDS_INPUT', questions: [{ text: 'Rollout?', context: 'Policy', impact: 'Risk', options: [], required: true }] };
    if (mode === 'question') assert.match(input.prompt, /Canary/);
    if (mode === 'drift') writeFileSync(join(input.cwd, 'README.md'), 'external');
    if (mode === 'invalid') return 'готово' as never;
    if (mode === 'save') store.db.exec("CREATE TRIGGER fail_approve BEFORE INSERT ON events WHEN NEW.type = 'approve.completed' BEGIN SELECT RAISE(ABORT, 'disk'); END");
    return approved();
  });
  runner.enqueue(queue()); await settled(store, task.id);
  if (mode === 'question') {
    const request = store.humanRequests().at(-1)!;
    const next = store.answer(project.id, task.id, request.id, store.task(project.id, task.id).state_version, ['Canary']).run!;
    assert.equal(next.role, 'approve'); runner.enqueue(next); await settled(store, task.id);
    assert.equal(store.task(project.id, task.id).run_state, 'completed');
  } else {
    assert.equal(store.task(project.id, task.id).run_state, 'interrupted');
    assert.equal(store.runs().at(-1)!.outcome, null);
  }
  await runner.close();
});


test('Approve starts for supported 2 MiB source even when diff exceeds coordinator buffer', async t => {
  const content = 'a\n'.repeat(1024 * 1024);
  const { store, task, directory, queue } = await fixture(t, 2, content);
  let calls = 0;
  const runner = new SpecController(store, directory, () => {}, command, undefined, undefined, undefined, async () => pass, async input => {
    calls++;
    const run = store.runs().at(-1)!;
    assert.match(input.prompt, new RegExp(`base_sha ${run.base_sha} and head_sha ${run.head_sha}`));
    assert.equal(readFileSync(join(input.cwd, 'README.md'), 'utf8'), content);
    const diff = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', run.base_sha!, run.head_sha!, '--'], { cwd: input.cwd, maxBuffer: 4 * 1024 * 1024 });
    assert.ok(diff.length > 2 * 1024 * 1024);
    return approved();
  });
  runner.enqueue(queue());
  assert.equal((await settled(store, task.id)).run_state, 'completed');
  await runner.close(); assert.equal(calls, 1);
  assert.equal(store.runs().at(-1)!.outcome, 'APPROVE');
});
