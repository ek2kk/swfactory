import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewImpact, makeReviewPlan } from '../src/server/reviewPlan.js';
import { Store } from '../src/server/store.js';
import type { AgentRun } from '../src/shared.js';

for (const [paths, diff, expected] of [
  [['src/server/math.ts'], '+return a + b', { code: true, security: true, ui: false }],
  [['src/client/style.css'], '+color: red', { code: false, security: false, ui: true }],
  [['src/client/Login.tsx'], '+fetch(url, { token })', { code: true, security: true, ui: true }],
  [['src/server/api.ts', 'src/client/style.css'], '+response.status = 400', { code: true, security: true, ui: true }],
  [['src/server/api.ts'], '+response.status = 400', { code: true, security: true, ui: true }],
  [['unknown.blob'], '+opaque', { code: true, security: true, ui: true }],
  [['README.md'], '+hello', { code: false, security: false, ui: false }],
] as const) test(`review impact ${paths.join(',')}`, () => assert.deepEqual(reviewImpact([...paths], diff), expected));

async function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'review-plan-'));
  let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject({ checkout: directory, common_dir: directory, remote: 'origin', remote_url: 'https://github.com/a/b', hosting: 'github', host: 'github.com', repository: 'a/b', target_branch: 'main' });
  const task = store.createTask(project.id, 'Update UI', 1);
  const build = store.queueSpec(project.id, task.id, 1, directory, 'skip');
  Object.assign(build, { status: 'completed', outcome: 'READY', base_sha: 'base', head_sha: 'head', source_hash: 'hash' });
  store.updateRun(build, 'review', 'idle');
  return { get store() { return store; }, project, task, build, restart() { store.close(); store = new Store(directory); } };
}
test('CSS plan survives restart, skips code/security, blocks missing required result and permits approval', async t => {
  const f = await fixture(t);
  const plan = await makeReviewPlan(f.build, async (_file, args) => args.includes('-z') ? 'src/client/style.css\0' : '+color: red', []);
  f.store.saveReviewPlan(f.build, plan); f.restart();
  assert.deepEqual(f.store.reviewPlan(f.build.id), plan);
  const { diff, requirements, ...metadata } = plan;
  assert.deepEqual(f.store.specRun(f.project.id, f.task.id, f.build.id).review_plan, metadata);
  const review = f.store.queueReview(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version);
  assert.equal(review.role, 'review-ui-ux'); assert.equal(f.store.reviewPasses(review), false);
  review.status = 'completed'; review.outcome = 'PASS'; f.store.updateRun(review, 'approve', 'idle');
  assert.equal(f.store.reviewPasses(review), true);
  const approval = f.store.queueApprove(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version);
  assert.equal(approval.role, 'approve');
  approval.head_sha = 'other'; assert.equal(f.store.reviewPasses(approval), false);
});
test('text-only plan queues Approve directly without fabricated PASS', async t => {
  const f = await fixture(t);
  f.store.saveReviewPlan(f.build, await makeReviewPlan(f.build, async (_file, args) => args.includes('-z') ? 'README.md\0' : '+hello', []));
  const next = f.store.queueReview(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version);
  assert.equal(next.role, 'approve'); assert.deepEqual(f.store.reviewRound(next), []);
  assert.equal(f.store.reviewPasses({ ...next, config: { ...next.config, instructions: 'different' } }), false);
});
test('repair rechecks findings and touched areas; requirements/config changes prevent reuse', async t => {
  const f = await fixture(t);
  const prior = ['review-code', 'review-security', 'review-ui-ux'].map(role => ({ ...f.build, id: role, role, round_id: 'old-build', head_sha: 'old-head', outcome: role === 'review-ui-ux' ? 'CHANGES' : 'PASS' })) as AgentRun[];
  const repaired = { ...f.build, repair_round_id: 'old-build' };
  const command = async (_file: string, args: string[]) => args.includes('-z') ? (args.includes('base') ? 'src/client/view.tsx\0' : 'src/client/style.css\0') : args.includes('base') ? '+fetch(url)' : '+color: red';
  const plan = await makeReviewPlan(repaired, command, prior);
  assert.deepEqual(plan.checks.map(c => c.reuse_run_id), ['review-code', 'review-security', undefined]);
  assert.equal(plan.diff_base, 'old-head'); assert.match(plan.checks[2].reason, /замечаний/);
  const tokenPlan = await makeReviewPlan(repaired, async (_file, args) => args.includes('-z') ? 'src/client/view.tsx\0' : '+token = newToken', prior);
  assert.ok(tokenPlan.checks.every(c => !c.reuse_run_id));
  for (const change of [{ description_revision: 2 }, { project_version: 2 }, { config: { ...repaired.config, instructions: 'new' } }]) {
    const changed = await makeReviewPlan({ ...repaired, ...change }, command, prior);
    assert.ok(changed.checks.every(c => !c.reuse_run_id)); assert.equal(changed.diff_base, 'base');
  }
});
test('persisted reuse authorizes current head while preserving original PASS and findings', async t => {
  const f = await fixture(t);
  f.store.saveReviewPlan(f.build, await makeReviewPlan(f.build, async (_file, args) => args.includes('-z') ? 'src/client/view.tsx\0' : '+fetch(url)', []));
  let last!: AgentRun;
  for (let i = 0; i < 3; i++) {
    last = f.store.queueReview(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version);
    last.status = 'completed'; last.outcome = i === 2 ? 'CHANGES' : 'PASS';
    f.store.updateRun(last, i === 2 ? 'needs-human' : 'review', i === 2 ? 'interrupted' : 'idle');
  }
  const old = f.store.reviewRound(last).filter((r): r is AgentRun => !!r);
  const repair = f.store.queueRepair(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version);
  Object.assign(repair, { head_sha: 'fixed-head', source_hash: 'fixed-hash', status: 'completed', outcome: 'READY' });
  const command = async (_file: string, args: string[]) => args.includes('-z') ? (args.includes('base') ? 'src/client/view.tsx\0' : 'src/client/style.css\0') : args.includes('base') ? '+fetch(url)' : '+color: red';
  f.store.saveReviewPlan(repair, await makeReviewPlan(repair, command, old));
  f.store.updateRun(repair, 'review', 'idle');
  const review = f.store.queueReview(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version);
  assert.equal(review.role, 'review-ui-ux'); assert.equal(f.store.reviewPasses(review), false);
  review.status = 'completed'; review.outcome = 'PASS'; f.store.updateRun(review, 'approve', 'idle');
  assert.equal(f.store.reviewPasses(review), true);
  assert.equal(f.store.specRun(f.project.id, f.task.id, old[0].id).head_sha, 'head');
  assert.equal(f.store.specRun(f.project.id, f.task.id, old[0].id).outcome, 'PASS');
  f.restart(); assert.equal(f.store.reviewPasses(f.store.specRun(f.project.id, f.task.id, review.id)), true);
  f.store.db.prepare('UPDATE runs SET stale = 1 WHERE id = ?').run(old[0].id);
  assert.equal(f.store.reviewPasses(review), false);
});
test('unavailable diff never skips reviews or reuses a PASS', async t => {
  const f = await fixture(t);
  const plan = await makeReviewPlan(f.build, async (_file, args) => {
    if (args.includes('-z')) return 'README.md\0';
    throw new Error('maxBuffer');
  }, []);
  assert.ok(plan.checks.every(c => c.required && !c.reuse_run_id));
});
test('partial failed round can repair after restart but cannot approve with missing evidence', async t => {
  const f = await fixture(t);
  f.store.saveReviewPlan(f.build, await makeReviewPlan(f.build, async (_file, args) => args.includes('-z') ? 'unknown.config\0' : '+opaque', []));
  const first = f.store.queueReview(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version);
  first.status = 'completed'; first.outcome = 'CHANGES'; f.store.updateRun(first, 'review', 'idle');
  assert.equal(f.store.reviewPasses(first), false);
  assert.throws(() => f.store.queueReview(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version));
  f.store.db.prepare("UPDATE tasks SET stage = 'needs-human', run_state = 'interrupted' WHERE id = ?").run(f.task.id);
  f.restart();
  assert.throws(() => f.store.queueReview(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version));
  f.store.db.prepare("UPDATE tasks SET stage = 'approve', run_state = 'idle' WHERE id = ?").run(f.task.id);
  assert.throws(() => f.store.queueApprove(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version));
  f.store.db.prepare("UPDATE tasks SET stage = 'needs-human', run_state = 'interrupted' WHERE id = ?").run(f.task.id);
  const version = f.store.task(f.project.id, f.task.id).state_version;
  const repair = f.store.queueRepair(f.project.id, f.task.id, version);
  assert.equal(repair.role, 'build');
  assert.equal(repair.repair_round_id, first.round_id);
  assert.throws(() => f.store.queueRepair(f.project.id, f.task.id, version));
});

test('review plan diff is persisted unmodified and excluded from browser metadata', async t => {
  const f = await fixture(t);
  const credential = 'ghp_' + 'x'.repeat(24);
  const plan = await makeReviewPlan(f.build, async (_file, args) => args.includes('-z') ? 'README.md\0' : `-const credential = "${credential}";`, []);
  assert.equal(plan.checks.find(c => c.role === 'review-security')?.required, true, 'classification must see the original diff');
  f.store.saveReviewPlan(f.build, plan);
  const stored = (f.store.db.prepare('SELECT plan FROM review_plans').get() as { plan: string }).plan;
  assert.ok(stored.includes(credential), 'SQLite must retain the original diff');
  assert.ok(!JSON.stringify(f.store.events(0)).includes(credential), 'events must not retain credential');
  const browserPlan = f.store.snapshot().runs[0].review_plan!;
  assert.ok(!('diff' in browserPlan)); assert.ok(!('requirements' in browserPlan));
  const event = JSON.parse(f.store.events(0).find(e => e.type === 'review.plan')!.payload);
  assert.ok(!('diff' in event.plan)); assert.ok(!('requirements' in event.plan));
  f.restart(); assert.ok(!JSON.stringify(f.store.snapshot()).includes(credential));
});
test('removing an ownership guard reruns Security instead of reusing PASS', async t => {
  const f = await fixture(t);
  const prior = ['review-code', 'review-security', 'review-ui-ux'].map(role => ({ ...f.build, id: role, role, round_id: 'old-build', head_sha: 'old-head', outcome: role === 'review-code' ? 'CHANGES' : 'PASS' })) as AgentRun[];
  const plan = await makeReviewPlan({ ...f.build, repair_round_id: 'old-build' }, async (_file, args) => args.includes('-z') ? 'src/server/handler.ts\0'
    : args.includes('base') ? '+fetch(url)' : '-if (!isOwner) throw new Error();', prior);
  const security = plan.checks.find(c => c.role === 'review-security')!;
  assert.equal(security.required, true); assert.equal(security.reuse_run_id, undefined);
});
for (const path of ['vite.config.ts', 'eslint.config.js', 'src/config.ts', 'src/config/runtime.ts']) test(`config ${path} requires all roles`, () => {
  assert.deepEqual(reviewImpact([path], '+defineConfig({ plugins: [] })'), { code: true, security: true, ui: true });
});
test('restart preserves raw plan, trims event metadata and blocks the old selection policy', async t => {
  const f = await fixture(t);
  const secret = 'ghp_' + 'z'.repeat(24);
  const plan = await makeReviewPlan(f.build, async (_file, args) => args.includes('-z') ? 'README.md\0' : '+hello', []);
  delete plan.policy_version;
  plan.diff = `-token="${secret}"`;
  f.store.db.prepare('INSERT INTO review_plans VALUES (?, ?)').run(f.build.id, JSON.stringify(plan));
  f.store.event('review.plan', f.task.id, { run_id: f.build.id, plan });
  f.restart();
  assert.ok(!JSON.stringify(f.store.events(0)).includes(secret));
  assert.ok(JSON.stringify(f.store.reviewPlan(f.build.id)).includes(secret));
  assert.ok(!JSON.stringify(f.store.snapshot()).includes(secret));
  assert.equal(f.store.specRun(f.project.id, f.task.id, f.build.id).stale, 1);
  assert.equal(f.store.task(f.project.id, f.task.id).stage, 'needs-human');
  assert.equal(f.store.reviewPasses({ ...f.build, round_id: f.build.id }), false);
});

for (const outcome of ['NEEDS_INPUT', 'BLOCKED', null] as const) test(`partial ${outcome} is not repairable CHANGES`, async t => {
  const f = await fixture(t);
  const first = f.store.queueReview(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version);
  Object.assign(first, { status: outcome ? 'completed' : 'failed', outcome });
  f.store.updateRun(first, 'needs-human', 'interrupted', undefined, outcome === 'NEEDS_INPUT' ? {
    outcome, summary: 'Policy needed', findings: [], evidence: [], applicable: true, applicability: '',
    questions: [{ text: 'Policy?', context: 'Review', impact: 'Verdict', options: [], required: true }],
  } : undefined);
  for (const manual of [false, true]) assert.throws(() => f.store.queueRepair(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version, manual));
});
