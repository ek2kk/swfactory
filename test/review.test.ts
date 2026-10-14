import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/server/store.js';
import { SpecController } from '../src/server/spec.js';
import { publishGithub } from '../src/server/publication.js';
import { run as command } from '../src/server/git.js';
import { executeReview, validateReview, type ExecuteBuild, type ExecuteReview } from '../src/server/codex.js';
import type { BuildResult, SpecResult, ReviewResult } from '../src/shared.js';

const spec: SpecResult = { title: 'Hello', outcome: 'READY', summary: 'Implement hello', requirements: ['Say hello'], acceptance_criteria: ['README says hello'], assumptions: [], out_of_scope: [], questions: [] };
const ready: BuildResult = { outcome: 'READY', summary: 'Implemented', changed_paths: ['README.md'], actions: ['Edited README'], checks: ['Read README: hello'], questions: [] };
async function fixture(t: { after: (fn: () => void) => void }, completedRepairs = 2, content = 'hello', description = 'Say hello', specification = spec) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-review-'))), checkout = join(root, 'repo'), directory = join(root, 'data');
  mkdirSync(checkout);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(checkout, 'init', '-b', 'main'); git(checkout, 'config', 'user.name', 'Test'); git(checkout, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(checkout, 'README.md'), 'initial'); git(checkout, 'add', '--', 'README.md'); git(checkout, 'commit', '-m', 'initial');
  const remote = join(root, 'remote.git'); git(checkout, 'clone', '--bare', checkout, remote); git(checkout, 'remote', 'add', 'origin', remote);
  const store = new Store(directory);
  t.after(() => { if (store.db.open) store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = store.addProject({ checkout, common_dir: join(checkout, '.git'), remote: 'origin', remote_url: remote, hosting: 'github', host: 'github.com', repository: 'test/repo', target_branch: 'main' });
  const config = store.settings(project.id); config.models.build = 'selected-build'; config.reasoning_efforts = { 'review-code': 'low', 'review-security': 'medium', 'review-ui-ux': 'high', approve: 'max' }; config.instructions = 'Keep it simple';
  store.saveSettings(project.id, config, 1);
  const task = store.createTask(project.id, description, 2);
  const initial = store.queueSpec(project.id, task.id, 1, directory);
  const specRunner = new SpecController(store, directory, () => {}, command, async () => specification);
  specRunner.enqueue(initial); await specRunner.close();
  const queue = () => store.queueBuild(project.id, task.id, store.task(project.id, task.id).state_version);
  const controller = (execute: ExecuteBuild) => new SpecController(store, directory, () => {}, command, undefined, undefined, execute, undefined, approved);
  const build = queue();
  const builder = controller(async input => { writeFileSync(join(input.cwd, 'README.md'), content); return ready; });
  builder.enqueue(build); await builder.close();
  store.db.prepare('UPDATE runs SET repair_attempt = ? WHERE id = ?').run(completedRepairs, build.id);
  const reviewQueue = () => store.queueReview(project.id, task.id, store.task(project.id, task.id).state_version);
  const reviewer = (execute: ExecuteReview) => new SpecController(store, directory, () => {}, command, undefined, undefined, undefined, async input => visualResult(await execute(input), input.reviewRole), approved);
  return { root, checkout, directory, store, project, task, initial, git, build, queue: reviewQueue, controller: reviewer };
}


const approved = async () => ({ outcome: 'APPROVE' as const, summary: 'Publish only', risks: [], affected_paths: ['README.md'], questions: [] });
function visualResult(result: ReviewResult, role?: string): ReviewResult {
  return role === 'review-ui-ux' ? { ...result, ui: { summary: result.summary, findings: result.findings, evidence: result.evidence }, ux: { summary: 'UX checked', findings: [], evidence: result.evidence } } : result;
}
const pass: ReviewResult = { outcome: 'PASS', summary: 'Looks good', findings: [], evidence: ['Inspected change'], applicable: true, applicability: '', questions: [] };
test('interrupted Review preserves work and permits an explicit retry only after execution stops', async t => {
  const { store, project, task, queue, controller, root } = await fixture(t);
  const run = queue();
  const cli = join(root, 'codex');
  writeFileSync(cli, `#!${process.execPath}
if (process.argv[2] === '--version') { console.log('codex-cli 0.160.1'); process.exit(0); }
const send = x => console.log(JSON.stringify(x));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line);
 if(r.method==='initialize') send({id:r.id,result:{}});
 if(r.method==='thread/start') send({id:r.id,result:{thread:{id:'thread'}}});
 if(r.method==='turn/start') { send({id:r.id,result:{turn:{id:'turn'}}}); send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}}); }
 if(r.method==='turn/interrupt') { send({id:r.id,result:{}}); send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'interrupted'}}}); }
});`, { mode: 0o700 });
  const runner = controller(input => executeReview(input, cli));
  runner.enqueue(run);
  for (let i = 0; i < 200 && !runner.canInterrupt(run.id); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runner.canInterrupt(run.id), true);
  const requested = store.requestInterrupt(project.id, task.id, run.id, store.task(project.id, task.id).state_version);
  runner.interrupt(requested); await settled(store, task.id); await runner.close();
  const failed = store.specRun(project.id, task.id, run.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.diagnostic?.error_kind, 'interrupted');
  assert.equal(failed.diagnostic?.execution_finished, true); assert.equal(failed.diagnostic?.can_interrupt, false);
  assert.equal(store.task(project.id, task.id).execution_unverified, 0);
  store.db.prepare('UPDATE tasks SET execution_unverified=1 WHERE id=?').run(task.id);
  assert.throws(() => store.retryRun(project.id, task.id, store.task(project.id, task.id).state_version), /Повтор запрещён/);
  store.db.prepare('UPDATE tasks SET execution_unverified=0 WHERE id=?').run(task.id);
  const retry = store.retryRun(project.id, task.id, store.task(project.id, task.id).state_version);
  const continuation = controller(async () => pass);
  continuation.enqueue(retry); await continuation.close();
  assert.equal(store.specRun(project.id, task.id, retry.id).outcome, 'PASS');
});
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
for (const changes of [false, true]) test(`Three sequential independent reports; CHANGES=${changes} completes round without Build`, async t => {
  const { store, project, task, directory, queue, controller, build } = await fixture(t);
  const seen: string[] = [], directories = new Set<string>();
  let active = 0;
  const runner = controller(async input => {
    assert.equal(active++, 0);
    const role = /You are the ([\w-]+)/.exec(input.prompt)![1]; seen.push(role); directories.add(input.directory);
    assert.equal(input.reasoningEffort, build.config.reasoning_efforts?.[role as keyof typeof build.config.models]);
    assert.match(input.prompt, /README says hello/); assert.match(input.prompt, /Never run Build/);
    assert.equal(store.task(project.id, task.id).stage, 'review');
    assert.throws(() => store.queueBuild(project.id, task.id, store.task(project.id, task.id).state_version));
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return changes && seen.length === 1 ? { ...pass, outcome: 'CHANGES', findings: ['Fix it'] } : pass;
  });
  const first = queue(); assert.throws(queue); runner.enqueue(first);
  const finished = await settled(store, task.id); await runner.close();
  assert.deepEqual(seen, ['review-code', 'review-security', 'review-ui-ux']); assert.equal(directories.size, 3);
  assert.equal(finished.stage, changes ? 'needs-human' : 'approve');
  const reviews = store.runs().filter(r => r.role.startsWith('review-'));
  for (const r of reviews) {
    assert.equal(r.round_id, build.id); assert.equal(r.head_sha, store.specRun(project.id, task.id, build.id).head_sha);
    assert.equal(r.report, 1); assert.ok(readFileSync(join(directory, 'artifacts', r.id, 'report.md'), 'utf8').includes('Inspected change'));
    const envelope = JSON.parse(readFileSync(join(directory, 'artifacts', r.id, 'result.json'), 'utf8'));
    assert.equal(envelope.spec_revision, r.spec_run_id); assert.equal(envelope.run_id, r.id);
  }
  assert.equal(store.reviewPasses(reviews.at(-1)!), !changes);
  store.close(); const restored = new Store(directory); assert.equal(restored.runs().filter(r => r.report && r.role.startsWith('review-')).length, 3); restored.close();
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
  assert.deepEqual(seen, ['review-code', 'review-security', 'review-security', 'review-ui-ux']);
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
  if (scenario === 'artifact-failure' || scenario === 'event-failure') {
    if (scenario === 'event-failure') store.db.exec('DROP TRIGGER fail_review');
    const retry = store.retryRun(project.id, task.id, store.task(project.id, task.id).state_version);
    const continuation = controller(async () => { assert.fail('Reviewer must not run again'); });
    continuation.enqueue(retry); await continuation.close();
    assert.equal(store.specRun(project.id, task.id, retry.id).outcome, 'PASS');
    assert.equal(store.task(project.id, task.id).stage, 'review');
  }
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
test('Review question survives restart and the answer continues the same reviewer', async t => {
  const { store, project, task, directory, queue, controller } = await fixture(t);
  const runner = controller(async () => ({ ...pass, outcome: 'NEEDS_INPUT', questions: [{ text: 'Which browser?', context: 'Required UI check', impact: 'Cannot verify', options: [], required: true }] }));
  runner.enqueue(queue()); await settled(store, task.id); await runner.close();
  const request = store.humanRequests().at(-1)!; store.close();
  const restored = new Store(directory);
  try {
    const current = restored.task(project.id, task.id); assert.equal(current.run_state, 'waiting');
    const next = restored.answer(project.id, task.id, request.id, current.state_version, ['Configured browser']).run;
    assert.equal(next.role, request.role);
    const resumed = new SpecController(restored, directory, () => {}, command, undefined, undefined, undefined, async input => {
      assert.match(input.prompt, /Configured browser/); return { ...pass, outcome: 'BLOCKED' };
    });
    resumed.enqueue(next); await resumed.close();
    assert.equal(restored.specRun(project.id, task.id, next.id).outcome, 'BLOCKED');
    assert.equal(restored.runs().filter(r => r.role.startsWith('review-')).length, 2);
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
    assert.equal(reviews.length, scenario === 'changes' ? 3 : 2);
    assert.ok(reviews.every(r => r.stale === (drift ? 1 : 0)));
    assert.equal(runner.error, null);
    if (!drift) assert.deepEqual(store.snapshot(), before);
    const refreshed = store.snapshot();
    await runner.refreshReviewState();
    assert.deepEqual(store.snapshot(), refreshed);
    assert.equal(calls, scenario === 'changes' ? 3 : 2);
  });
}

for (const passAfterRepair of [false, true]) test(`Repair aggregates every reviewer, caps at two and reviews each version; pass=${passAfterRepair}`, async t => {
  const { store, project, task, directory, queue } = await fixture(t, 0);
  let builds = 0, reviews = 0;
  const runner = new SpecController(store, directory, () => {}, command, undefined, undefined, async input => {
    builds++;
    for (const role of ['review-code', 'review-security', 'review-ui-ux']) assert.ok(input.prompt.includes(`Finding ${role}`));
    writeFileSync(join(input.cwd, 'README.md'), `hello repair ${builds}`);
    return ready;
  }, async input => {
    reviews++;
    const role = /You are the ([\w-]+)/.exec(input.prompt)![1];
    return visualResult(passAfterRepair && builds ? pass : { ...pass, outcome: 'CHANGES', findings: [`Finding ${role}`] }, input.reviewRole);
  }, approved);
  runner.enqueue(queue());
  assert.equal((await settled(store, task.id)).stage, passAfterRepair ? 'approve' : 'needs-human');
  assert.equal(builds, passAfterRepair ? 1 : 2);
  assert.equal(reviews, (builds + 1) * 3);
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
  }, async input => visualResult(builds ? pass : { ...pass, outcome: 'CHANGES', findings: ['Fix it'] }, input.reviewRole), approved);
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
    async input => visualResult({ ...pass, outcome: 'CHANGES', findings: ['Fix it'] }, input.reviewRole));
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
  const runner = new SpecController(store, directory, () => {}, command, undefined, undefined, undefined, async input => visualResult(pass, input.reviewRole), async input => {
    calls++;
    assert.match(input.prompt, /README says hello/); assert.match(input.prompt, /Consult the changes only as needed.*immutable base_sha/);
    for (const role of ['review-code', 'review-security', 'review-ui-ux']) assert.ok(input.prompt.includes(role));
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
    assert.equal(store.publicationRun(project.id, task.id).id, request.run_id);
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
  const runner = new SpecController(store, directory, () => {}, command, undefined, undefined, undefined, async input => visualResult(pass, input.reviewRole), async input => {
    calls++; assert.equal(input.reasoningEffort, 'max');
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
  if (mode === 'save') {
    store.db.exec('DROP TRIGGER fail_approve');
    const retry = store.retryRun(project.id, task.id, store.task(project.id, task.id).state_version);
    const continuation = new SpecController(store, directory, () => {}, command, undefined, undefined, undefined, undefined, async () => { assert.fail('Approve must not run again'); });
    continuation.enqueue(retry); await continuation.close();
    assert.equal(store.specRun(project.id, task.id, retry.id).outcome, 'APPROVE');
    assert.equal(store.task(project.id, task.id).run_state, 'completed');
    assert.equal(store.task(project.id, task.id).publication_status, null);
  }
});


test('Approve starts for supported 2 MiB source even when diff exceeds coordinator buffer', async t => {
  const content = 'a\n'.repeat(1024 * 1024);
  const { store, task, directory, queue } = await fixture(t, 2, content);
  let calls = 0;
  const runner = new SpecController(store, directory, () => {}, command, undefined, undefined, undefined, async input => visualResult(pass, input.reviewRole), async input => {
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

for (const issueNumber of [42, null, undefined]) test(`GitHub PR body preserves content with issue_number=${issueNumber}`, async t => {
  const { store, project, task, directory, queue, controller } = await fixture(t);
  if (issueNumber != null) store.db.prepare('INSERT INTO github_issues VALUES (?, ?, ?, ?, ?)')
    .run(project.id, issueNumber, `https://github.com/test/repo/issues/${issueNumber}`, task.id, task.state_version);
  const reviewer = controller(async () => pass);
  reviewer.enqueue(queue()); await settled(store, task.id); await reviewer.close();
  const approval = store.runs().at(-1)!, reviews = store.reviewRound(approval).map(r => { assert.ok(r); return r; });
  const source = store.task(project.id, task.id);
  assert.equal(source.issue_number, issueNumber ?? null);
  if (issueNumber === undefined) delete source.issue_number;
  source.description = 'Issue #99\n\n```text\nKeep this description\n```';
  const pr = { number: 12, html_url: 'https://github.com/test/repo/pull/12', state: 'open', merged_at: null,
    head: { ref: approval.branch, sha: approval.head_sha, repo: { full_name: project.repository } },
    base: { ref: project.target_branch, repo: { full_name: project.repository } }, body: '' };
  let creates = 0;
  const cli: typeof command = async (file, args) => {
    if (file === 'git') return args[0] === 'remote' ? project.remote_url : '';
    if (args.includes('--slurp')) return '[[]]';
    if (args[0] === 'pr') {
      assert.deepEqual(args.slice(0, 2), ['pr', 'create']); creates++;
      const bodyPath = args[args.indexOf('--body-file') + 1];
      assert.equal(bodyPath, join(directory, 'artifacts', approval.id, 'pull-request.md'));
      pr.body = readFileSync(bodyPath, 'utf8');
      const paragraphs = [`<!-- swfactory-task:${task.id} -->`, ...(issueNumber == null ? [] : ['Closes #42']),
        source.description, '## Summary', ready.summary, '## Reviews',
        ...reviews.map(r => `${r.role}: PASS\n${pass.summary}`), '## Approval', (await approved()).summary,
        `Approved head: ${approval.head_sha}`, 'CI: not checked. Missing, pending or failed CI is not PASS. Merge remains a human action.'];
      assert.equal(pr.body, paragraphs.join('\n\n'));
      assert.doesNotMatch(pr.body, /^Closes #99$/m);
      return pr.html_url;
    }
    return JSON.stringify(pr);
  };
  assert.deepEqual(await publishGithub(project, source, approval, reviews, directory, cli, async () => {}),
    { number: pr.number, url: pr.html_url });
  assert.equal(creates, 1);
});

for (const mode of ['success', 'existing', 'existing-changed-during-fetch', 'unknown', 'changed', 'changed-after-push', 'push-url', 'wrong-marker', 'wrong-head', 'save', 'missing-pass'] as const) test(`GitHub publication ${mode}: guarded, confirmed and durable`, async t => {
  const { store, project, task, directory, queue, controller, build } = await fixture(t);
  if (mode === 'existing') store.db.prepare('INSERT INTO github_issues VALUES (?, ?, ?, ?, ?)')
    .run(project.id, 42, 'https://github.com/test/repo/issues/42', task.id, task.state_version);
  const reviewer = controller(async () => pass);
  reviewer.enqueue(queue()); await settled(store, task.id); await reviewer.close();
  const approval = store.runs().at(-1)!;
  if (mode === 'missing-pass') {
    store.db.prepare("UPDATE runs SET outcome = 'CHANGES' WHERE role = 'review-code'").run();
    assert.throws(() => store.beginPublication(project.id, task.id, store.task(project.id, task.id).state_version), /PASS/);
    return;
  }
  let creates = 0, pushes = 0;
  const pr = { number: 12, html_url: 'https://github.com/test/repo/pull/12', state: 'open', merged_at: null,
    head: { ref: approval.branch, sha: approval.head_sha, repo: { full_name: 'test/repo' } },
    base: { ref: 'main', repo: { full_name: 'test/repo' } }, body: `<!-- swfactory-task:${task.id} -->` };
  const cli: typeof command = async (file, args, cwd) => {
    if (file === 'git') {
      if (mode === 'push-url' && args.includes('--push')) return 'https://github.com/other/repo.git';
      if (args[0] === 'push') {
        pushes++;
        if (mode === 'changed-after-push') writeFileSync(join(cwd, 'README.md'), 'changed during push');
      }
      return command(file, args, cwd);
    }
    if (args.includes('--slurp')) return JSON.stringify([['existing', 'existing-changed-during-fetch', 'wrong-marker', 'wrong-head'].includes(mode) ? [pr] : []]);
    if (args[0] === 'pr') { assert.deepEqual(args.slice(0, 2), ['pr', 'create']); creates++; if (mode === 'unknown') throw new Error('Connection lost after create'); return pr.html_url; }
    if (mode === 'existing-changed-during-fetch') writeFileSync(join(cwd, 'README.md'), 'changed during PR detail fetch');
    return JSON.stringify(mode === 'wrong-marker' ? { ...pr, body: 'another task' } : mode === 'wrong-head' ? { ...pr, head: { ...pr.head, sha: 'bad' } } : pr);
  };
  const publisher = new SpecController(store, directory, () => {}, cli);
  const version = store.task(project.id, task.id).state_version;
  assert.throws(() => store.beginPublication(project.id, task.id, version - 1));
  store.db.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON events WHEN NEW.type = 'publication.started' BEGIN SELECT RAISE(ABORT, 'disk'); END");
  assert.throws(() => store.mutate('failed-publication', 'publish', () => store.beginPublication(project.id, task.id, version)));
  assert.equal(store.task(project.id, task.id).publication_status, null);
  store.db.exec('DROP TRIGGER fail_publication');
  if (mode === 'save') store.db.exec("CREATE TRIGGER fail_confirmation BEFORE INSERT ON events WHEN NEW.type = 'publication.confirmed' BEGIN SELECT RAISE(ABORT, 'disk'); END");
  const run = store.mutate('publication', 'publish', () => store.beginPublication(project.id, task.id, version)) as typeof approval;
  assert.equal((store.replay('publication', 'publish') as typeof approval).id, run.id);
  assert.throws(() => store.beginPublication(project.id, task.id, version));
  if (mode === 'changed') writeFileSync(join(build.worktree, 'README.md'), 'changed after approval');
  publisher.enqueuePublication(run); await settled(store, task.id); await publisher.close();
  const saved = store.task(project.id, task.id);
  const success = mode === 'success' || mode === 'existing';
  assert.equal(saved.publication_status, success ? 'confirmed' : 'unknown');
  assert.equal(saved.stage, success ? 'pr-created' : 'needs-human');
  assert.equal(saved.pr_url, success || mode === 'save' ? pr.html_url : null);
  assert.equal(creates, ['success', 'unknown', 'save'].includes(mode) ? 1 : 0);
  assert.equal(pushes, ['success', 'unknown', 'save', 'changed-after-push'].includes(mode) ? 1 : 0);
  assert.throws(() => store.beginPublication(project.id, task.id, saved.state_version));
  store.close(); const restored = new Store(directory);
  assert.equal(restored.task(project.id, task.id).publication_status, saved.publication_status);
  assert.equal(restored.task(project.id, task.id).pr_url, saved.pr_url); restored.close();
});

test('Pending publication becomes unknown on restart without executing a retry', async t => {
  const { store, project, task, directory } = await fixture(t);
  store.db.prepare("UPDATE tasks SET publication_status = 'pending', run_state = 'queued' WHERE id = ?").run(task.id);
  store.close(); const restored = new Store(directory);
  assert.equal(restored.task(project.id, task.id).publication_status, 'unknown');
  assert.equal(restored.task(project.id, task.id).stage, 'needs-human');
  assert.ok(restored.events(0).some(e => e.type === 'publication.unknown')); restored.close();
});

test('blocked browser check pauses Review and continues with attributed human evidence for the same HEAD', async t => {
  const { store, project, task, queue, controller, directory } = await fixture(t);
  const seen: string[] = [];
  let answered = false;
  const review: ExecuteReview = async input => {
    const role = /You are the ([\w-]+)/.exec(input.prompt)![1]; seen.push(role);
    if (role === 'review-ui-ux') assert.match(input.prompt, /Perform required rendered UI\/UX checks yourself using available browser\/computer tools before asking the human/);
    else assert.doesNotMatch(input.prompt, /Perform required rendered/);
    assert.match(input.prompt, /report the concrete blocker and checks attempted/);
    assert.doesNotMatch(input.prompt, /checks are performed by the human/);
    if (role === 'review-ui-ux' && !answered) return { ...pass, outcome: 'NEEDS_INPUT', evidence: [], questions: [
      { text: 'Open the page at 375px: is Save visible without horizontal scrolling?', context: 'Browser tools are unavailable in this session; responsive layout could not be checked', impact: 'Cannot complete UI Review', options: [], required: true },
    ] };
    if (role === 'review-ui-ux') {
      assert.match(input.prompt, /Checked at 375px: Save is visible/);
      return { ...pass, evidence: ['Human confirmed at 375px: Save is visible without horizontal scrolling'] };
    }
    return pass;
  };
  const first = controller(review); first.enqueue(queue()); await settled(store, task.id); await first.close();
  assert.deepEqual(seen, ['review-code', 'review-security', 'review-ui-ux']);
  const request = store.humanRequests().at(-1)!;
  assert.equal(request.role, 'review-ui-ux');
  const waiting = store.task(project.id, task.id); assert.equal(waiting.run_state, 'waiting');
  const head = store.runs().at(-1)!.head_sha;
  const next = store.answer(project.id, task.id, request.id, waiting.state_version, ['Checked at 375px: Save is visible without horizontal scrolling']).run!;
  answered = true;
  const second = controller(review); second.enqueue(next); await settled(store, task.id); await second.close();
  assert.deepEqual(seen, ['review-code', 'review-security', 'review-ui-ux', 'review-ui-ux']);
  assert.equal(store.task(project.id, task.id).stage, 'approve');
  assert.equal(store.specRun(project.id, task.id, next.id).head_sha, head);
  assert.match(readFileSync(join(directory, 'artifacts', next.id, 'report.md'), 'utf8'), /Human confirmed/);
});

test('UI/UX schema requires both sections and rejects PASS hiding a finding in either area', () => {
  const visual = visualResult(pass, 'review-ui-ux');
  assert.doesNotThrow(() => validateReview(visual, 'review-ui-ux'));
  assert.throws(() => validateReview(pass, 'review-ui-ux'));
  for (const area of ['ui', 'ux'] as const) {
    assert.throws(() => validateReview({ ...visual, [area]: { ...visual[area], findings: ['Broken'] } }, 'review-ui-ux'));
    assert.throws(() => validateReview({ ...visual, [area]: { ...visual[area], evidence: [] } }, 'review-ui-ux'));
    assert.doesNotThrow(() => validateReview({ ...visual, outcome: 'CHANGES', findings: ['Broken'], [area]: { ...visual[area], findings: ['Broken'] } }, 'review-ui-ux'));
  }
  assert.doesNotThrow(() => validateReview(visualResult({ ...pass, applicable: false, applicability: 'No interface changed', evidence: [] }, 'review-ui-ux'), 'review-ui-ux'));
});

for (const outcome of ['CHANGES', 'BLOCKED'] as const) test(`UI/UX ${outcome} blocks approval and publication`, async t => {
  const { store, project, task, queue, controller } = await fixture(t);
  const runner = controller(async input => input.reviewRole === 'review-ui-ux'
    ? { ...pass, outcome, findings: outcome === 'CHANGES' ? ['Keyboard trap'] : [], evidence: [] } : pass);
  runner.enqueue(queue()); await settled(store, task.id); await runner.close();
  const last = store.runs().at(-1)!;
  assert.equal(last.role, 'review-ui-ux'); assert.equal(last.outcome, outcome);
  assert.equal(store.reviewPasses(last), false);
  assert.throws(() => store.queueApprove(project.id, task.id, store.task(project.id, task.id).state_version));
  assert.throws(() => store.publicationRun(project.id, task.id));
});

test('saved UI task prompts keep visual acceptance in UI/UX and preserve all report sections', async t => {
  const example = JSON.parse(readFileSync(new URL('./fixtures/ui-review-task.json', import.meta.url), 'utf8'));
  const { store, task, directory, queue, controller, initial, build } = await fixture(t, 2, 'hello', example.description, example.specification);
  const runner = controller(async () => pass);
  runner.enqueue(queue()); await settled(store, task.id); await runner.close();
  const prompt = (id: string) => JSON.parse(readFileSync(join(directory, 'artifacts', id, 'input.json'), 'utf8')).prompt as string;
  assert.match(prompt(initial.id), /do not implement or perform full acceptance testing/);
  assert.match(prompt(build.id), /short smoke check.*leave independent Code, Security and UI\/UX acceptance audits/);
  for (const review of store.reviewRound(store.runs().at(-1)!)) {
    assert.ok(review);
    const saved = prompt(review.id);
    assert.match(saved, /Make Save responsive at 375px/);
    assert.match(saved, /mandatory repository instructions and security checks/);
    if (review.role === 'review-ui-ux') {
      assert.match(saved, /one shared browser pass/);
      const report = readFileSync(join(directory, 'artifacts', review.id, 'report.md'), 'utf8');
      assert.match(report, /## UI\n/); assert.match(report, /## UX\n/);
    } else {
      assert.doesNotMatch(saved, /Perform required rendered|viewport\/states/);
      assert.match(saved, /No mandatory/);
    }
  }
  assert.match(prompt(store.runs().at(-1)!.id), /Do not repeat Code, Security or UI\/UX audits/);
});

for (const changes of [false, true]) test(`legacy frozen configs survive restart and finish original review pipeline; changes=${changes}`, async t => {
  const { store, project, task, directory, build } = await fixture(t);
  const legacy = structuredClone(build.config);
  delete legacy.models['review-ui-ux']; delete legacy.reasoning_efforts!['review-ui-ux'];
  legacy.models['review-ui'] = 'legacy-ui'; legacy.models['review-ux'] = 'legacy-ux';
  legacy.reasoning_efforts!['review-ui'] = 'high'; legacy.reasoning_efforts!['review-ux'] = 'low';
  store.db.prepare('UPDATE runs SET config = ? WHERE task_id = ?').run(JSON.stringify(legacy), task.id);
  store.db.prepare('UPDATE project_settings SET config = ? WHERE project_id = ?').run(JSON.stringify(legacy), project.id);
  const migrated = store.settings(project.id);
  assert.equal(migrated.models['review-ui-ux'], 'legacy-ui');
  assert.equal(migrated.reasoning_efforts?.['review-ui-ux'], 'high');
  assert.equal(migrated.models['review-ux'], 'legacy-ux');
  assert.equal(migrated.reasoning_efforts?.['review-ux'], 'low');
  const updated = structuredClone(migrated);
  delete updated.models['review-ui']; delete updated.models['review-ux'];
  delete updated.reasoning_efforts!['review-ui']; delete updated.reasoning_efforts!['review-ux'];
  store.saveSettings(project.id, updated, store.project(project.id).state_version);
  assert.deepEqual(store.settings(project.id), migrated);
  const freshTask = store.createTask(project.id, 'New pipeline', store.project(project.id).state_version);
  const fresh = store.queueSpec(project.id, freshTask.id, freshTask.state_version, directory);
  assert.equal(fresh.config.models['review-ui-ux'], 'legacy-ui');
  assert.equal(fresh.config.reasoning_efforts?.['review-ui-ux'], 'high');
  assert.deepEqual(store.specRun(project.id, task.id, build.id).config, legacy);
  const first = store.queueReview(project.id, task.id, store.task(project.id, task.id).state_version);
  const beforeRestart = new SpecController(store, directory, () => {}, command, undefined, undefined, undefined, async () => pass);
  beforeRestart.enqueue(first); await beforeRestart.close();
  store.close();
  const restored = new Store(directory);
  try {
    const seen: string[] = [];
    const runner = new SpecController(restored, directory, () => {}, command, undefined, undefined, undefined, async input => {
      seen.push(input.reviewRole!);
      if (input.reviewRole === 'review-ui') { assert.equal(input.model, 'legacy-ui'); assert.equal(input.reasoningEffort, 'high'); }
      if (input.reviewRole === 'review-ux') { assert.equal(input.model, 'legacy-ux'); assert.equal(input.reasoningEffort, 'low'); }
      return changes && input.reviewRole === 'review-ux' ? { ...pass, outcome: 'CHANGES', findings: ['Fix keyboard'] } : pass;
    }, approved);
    runner.enqueue(restored.queueReview(project.id, task.id, restored.task(project.id, task.id).state_version));
    await settled(restored, task.id); await runner.close();
    assert.deepEqual(seen, ['review-security', 'review-ui', 'review-ux']);
    const last = restored.runs().at(-1)!;
    assert.deepEqual(last.config, legacy);
    assert.equal(restored.reviewRound(last).length, 4);
    if (changes) {
      const repair = restored.queueRepair(project.id, task.id, restored.task(project.id, task.id).state_version, true);
      assert.deepEqual(repair.config, legacy);
    } else assert.equal(restored.publicationRun(project.id, task.id).role, 'approve');
  } finally { restored.close(); }
});
