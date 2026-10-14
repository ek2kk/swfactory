import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewImpact, makeReviewPlan } from '../src/server/reviewPlan.js';
import { Store } from '../src/server/store.js';
import type { AgentRun } from '../src/shared.js';

for (const [paths, diff, expected] of [
  [['src/server/math.ts'], '+return a + b', { code: true, security: false, ui: false }],
  [['src/client/style.css'], '+color: red', { code: false, security: false, ui: true }],
  [['src/client/Login.tsx'], '+fetch(url, { token })', { code: true, security: true, ui: true }],
  [['src/server/api.ts', 'src/client/style.css'], '+response.status = 400', { code: true, security: false, ui: true }],
  [['src/server/api.ts'], '+response.status = 400', { code: true, security: false, ui: true }],
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
  assert.deepEqual(f.store.specRun(f.project.id, f.task.id, f.build.id).review_plan, plan);
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
test('partial failed round cannot approve or repair while required evidence is missing', async t => {
  const f = await fixture(t);
  f.store.saveReviewPlan(f.build, await makeReviewPlan(f.build, async (_file, args) => args.includes('-z') ? 'unknown.config\0' : '+opaque', []));
  const first = f.store.queueReview(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version);
  first.status = 'completed'; first.outcome = 'CHANGES'; f.store.updateRun(first, 'needs-human', 'interrupted');
  assert.equal(f.store.reviewPasses(first), false);
  assert.throws(() => f.store.queueRepair(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version));
  f.store.db.prepare("UPDATE tasks SET stage = 'approve', run_state = 'idle' WHERE id = ?").run(f.task.id);
  assert.throws(() => f.store.queueApprove(f.project.id, f.task.id, f.store.task(f.project.id, f.task.id).state_version));
});
