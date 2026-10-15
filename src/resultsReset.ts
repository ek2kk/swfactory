import { reviewsFor, type AgentRun, type Task } from './shared.js';

export type ResultsRestart = { role: AgentRun['role']; spec_run_id?: string; build_id?: string; reason: string };
export type ResultsResetPlan = { state_version: number; role: AgentRun['role']; runs: { id: string; role: AgentRun['role'] }[]; restart: ResultsRestart };

export function applicableReview(review: AgentRun, build: AgentRun) {
  return !review.revoked && !build.revoked && review.task_id === build.task_id && review.status === 'completed' && review.outcome === 'PASS' && !review.stale
    && review.description_revision === build.description_revision && review.spec_run_id === build.spec_run_id
    && review.head_sha === build.head_sha && review.source_hash === build.source_hash && review.base_sha === build.base_sha
    && review.project_version === build.project_version && JSON.stringify(review.config) === JSON.stringify(build.config);
}

// Review parents encode execution order; only Build/repair inputs depend on other reviewers.
export function planResultsReset(task: Task, runs: AgentRun[], role: AgentRun['role'], projectVersion: number): ResultsResetPlan {
  runs = runs.filter(run => run.task_id === task.id);
  const selected = (candidate: AgentRun['role']) => candidate === role
    || role === 'review-ui-ux' && ['review-ui', 'review-ux'].includes(candidate)
    || candidate === 'review-ui-ux' && ['review-ui', 'review-ux'].includes(role);
  const removed = new Set(runs.filter(run => role === 'spec' || role === 'build' && run.role !== 'spec'
    || selected(run.role) || role.startsWith('review-') && run.role === 'approve').map(run => run.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of runs) {
      const repairInputs = run.role === 'build' && run.repair_round_id
        ? runs.filter(r => r.round_id === run.repair_round_id || runs.find(b => b.id === run.repair_round_id)?.review_plan?.checks.some(c => c.reuse_run_id === r.id)) : [];
      if (!removed.has(run.id) && ([run.spec_run_id, run.round_id, run.repair_round_id, run.diagnostic?.result_run_id,
        run.diagnostic?.dependency_resume?.blocked_run_id].some(id => id && removed.has(id))
        || run.role === 'build' && !!run.parent_run_id && removed.has(run.parent_run_id)
        || repairInputs.some(input => removed.has(input.id)))) {
        removed.add(run.id); changed = true;
      }
    }
  }
  const kept = runs.filter(run => !removed.has(run.id));
  const specs = kept.filter(run => run.role === 'spec' && !run.revoked && !run.stale && run.status === 'completed' && run.outcome === 'READY'
    && run.description_revision === task.revision && run.project_version === projectVersion);
  const spec = specs.at(-1);
  const build = kept.findLast(run => run.role === 'build' && !run.revoked && !run.stale && run.status === 'completed' && run.outcome === 'READY'
    && run.description_revision === task.revision && run.project_version === projectVersion && run.head_sha && run.source_hash
    && (!run.review_plan || run.review_plan.policy_version === 2 && run.review_plan.head_sha === run.head_sha
      && run.review_plan.source_hash === run.source_hash && run.review_plan.revision === run.description_revision)
    && (run.spec_run_id ? specs.some(spec => spec.id === run.spec_run_id) : task.spec_decision?.revision === task.revision && task.spec_decision.required === false));
  let restart: ResultsRestart = spec ? { role: 'build', spec_run_id: spec.id, reason: 'Сохранена пригодная Spec. Build начнётся от актуальной target branch в новом worktree.' }
    : { role: 'spec', reason: 'Сначала требуется новая Spec: пригодного результата для текущей revision и настроек проекта нет.' };
  if (build) {
    const checks = build.review_plan?.checks ?? reviewsFor(build.config).map(role => ({ role, required: true, reuse_run_id: undefined }));
    const missing = checks.find(check => check.required && !kept.some(review => review.role === check.role
      && (check.reuse_run_id ? review.id === check.reuse_run_id : review.round_id === build.id) && applicableReview(review, build)));
    restart = { role: missing?.role ?? 'approve', build_id: build.id,
      reason: missing ? `Сначала требуется ${missing.role}. Сохранённый Build будет проверен по HEAD/source_hash и чистоте worktree.`
        : 'Обязательные Review сохранены. Перед новым Approve будет проверен HEAD/source_hash и чистота worktree.' };
  }
  return { state_version: task.state_version, role, runs: runs.filter(run => removed.has(run.id)).map(({ id, role }) => ({ id, role })), restart };
}
