export const stages = ['backlog', 'spec', 'build', 'review', 'approve', 'pr-created', 'needs-human'] as const;
export type Project = {
  id: string; checkout: string; common_dir: string; remote: string; remote_url: string;
  hosting: 'github' | 'gitlab'; host: string; repository: string; target_branch: string; state_version: number;
};
export type ProjectInput = Pick<Project, 'checkout' | 'remote' | 'hosting' | 'target_branch'>;
export type SpecMode = 'auto' | 'spec' | 'skip';
export type SpecDecision = { revision: number; mode: SpecMode; required: boolean | null; reason: string; missing: string[] };
export type Task = {
  legacy_execution_unknown?: number; execution_generation?: number; publication_generation?: number; execution_warning?: string | null; publication_run_id?: string | null;
  results_restart?: import('./resultsReset.js').ResultsRestart | null;
  has_results?: number; reset_pending?: number; reset_error?: string | null;
  spec_decision?: SpecDecision | null;
  issue_number?: number | null; issue_url?: string | null;
  id: string; project_id: string; description: string; title: string | null;
  stage: typeof stages[number]; run_state: 'idle' | 'queued' | 'running' | 'waiting' | 'interrupted' | 'completed';
  publication_status: 'pending' | 'confirmed' | 'unknown' | null; pr_url: string | null; pr_number: number | null;
  archived?: number; archive_source?: 'manual' | 'github-filter' | null; archive_reason?: string | null; execution_unverified?: number;
  deletion_state?: 'stopping' | 'failed' | 'deleted' | null; deletion_error?: string | null; stop_unverified?: number;
  state_version: number; revision: number;
  title_state: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
};
export function publicationBlocksLocal(task: Task) {
  return !!task.publication_status && (task.publication_generation ?? 0) === (task.execution_generation ?? 0);
}
export function resultsResetBlocker(task: Task): string | null {
  if (task.archived) return 'Для сброса архивной задачи необходимо восстановление карточки; для удаления карточки используйте полное удаление. Архив автоматически не снимается.';
  if (task.publication_status === 'pending' || task.publication_status === 'unknown') return 'Публикация не подтверждена. Сначала остановите исполнение и сверьте remote результат; сброс не снимает это ограничение.';
  if (task.stop_unverified) return 'Состояние прежнего исполнения неизвестно. Сброс результатов недоступен; диагностика — в технических подробностях.';
  if (task.deletion_state || task.execution_unverified) return 'Для сброса результатов требуется завершение известного исполнения. Используйте «Остановить».';
  if (['queued', 'running'].includes(task.run_state) || ['pending', 'running'].includes(task.title_state)) return 'Дождитесь завершения работы или используйте «Остановить».';
  return null;
}
export type Revision = { task_id: string; revision: number; description: string; created_at: string };
export type SavedEvent = { id: number; type: string; task_id: string | null; payload: string; created_at: string };
export type Snapshot = { issue_syncing?: string[]; issue_errors?: { project_id: string; message: string }[]; archived_tasks?: Task[]; execution_pause?: ExecutionPause; projects: Project[]; tasks: Task[]; runs: AgentRun[]; human_requests: HumanRequest[]; execution_error?: string | null; title_error?: string | null; cursor: number };

export const roles = ['spec', 'build', 'review-code', 'review-security', 'review-ui-ux', 'approve'] as const;
export const legacyReviewRoles = ['review-code', 'review-security', 'review-ui', 'review-ux'] as const;
export const allRoles = ['spec', 'build', 'review-code', 'review-security', 'review-ui-ux', 'review-ui', 'review-ux', 'approve'] as const;
export type Models = Record<'spec' | 'build' | 'review-code' | 'review-security' | 'approve', string> & Partial<Record<'review-ui-ux' | 'review-ui' | 'review-ux', string>>;
export const defaultModels: Models = Object.fromEntries(roles.map(role => [role, 'gpt-6.1-sol'])) as Models;
export type Settings = { models: Models; reasoning_efforts?: Partial<Models>; fast_modes?: Partial<Record<typeof allRoles[number], boolean>>; instructions: string };
export type SpecResult = {
  outcome: 'READY' | 'NEEDS_INPUT'; title: string; summary: string; requirements: string[];
  acceptance_criteria: string[]; assumptions: string[]; out_of_scope: string[]; questions: Question[];
};
export type BuildResult = {
  dependencies?: Dependency[];
  outcome: 'READY' | 'NEEDS_INPUT' | 'BLOCKED'; summary: string; changed_paths: string[]; actions: string[]; checks: string[]; questions: Question[];
};
export const reviewRoles = ['review-code', 'review-security', 'review-ui-ux'] as const;
// Saved run configs select their original pipeline; never migrate them in place.
export const reviewsFor = (config: Settings): readonly ReviewRole[] => config.models['review-ui-ux'] ? reviewRoles : legacyReviewRoles;
export type ReviewRole = typeof reviewRoles[number] | typeof legacyReviewRoles[number];
export type ReviewSection = { summary: string; findings: string[]; evidence: string[] };
export type ReviewResult = {
  dependencies?: Dependency[];
  ui?: ReviewSection; ux?: ReviewSection;
  outcome: 'PASS' | 'CHANGES' | 'NEEDS_INPUT' | 'BLOCKED'; summary: string;
  findings: string[]; evidence: string[]; applicable: boolean; applicability: string; questions: Question[];
};
export type ApproveResult = {
  outcome: 'APPROVE' | 'ESCALATE' | 'NEEDS_INPUT'; summary: string; risks: string[]; affected_paths: string[]; questions: Question[];
};
export type FailureKind = 'authentication' | 'model_unavailable' | 'rate_limit' | 'protocol_error' | 'missing_artifact' | 'interrupted';
export type Dependency = {
  kind: 'code' | 'condition'; issue_url: string | null; pr_url: string | null;
  issue_must_be_closed?: boolean;
  reason: string; condition: string;
};
export type DependencyState = {
  dependency: Dependency; state: 'blocked' | 'cleared' | 'unknown'; reason: string; evidence: string[];
};
export type DependencyCheck = {
  id: string; status: 'pending' | 'blocked' | 'cleared' | 'error' | 'stale' | 'interrupted';
  started_at: string; finished_at?: string; revision: number; task_version: number; project_version: number;
  head_sha?: string; source_hash?: string; target_sha?: string;
  results: DependencyState[]; reason: string; questions: Question[]; confirmation: string;
  continuation_run_id?: string; resume_role?: AgentRun['role'];
};
export type DependencyDiagnostic = {
  dependency_block?: { reason: string; dependencies: Dependency[] };
  dependency_checks?: DependencyCheck[];
  dependency_resume?: { blocked_run_id: string; check_id: string; target_sha: string; preserved_worktree: string | null; reason: string };
};
export function dependencyActionBlocker(task: Task): string | null {
  if (task.reset_pending || task.archived || task.deletion_state) return 'Карточка архивирована, удаляется или сбрасывается.';
  if (publicationBlocksLocal(task)) return 'Сначала остановите прежний цикл; снятие зависимости не повторяет публикацию.';
  if (task.execution_unverified || task.stop_unverified) return 'Сначала используйте «Остановить». Для удаления результатов требуется завершение известного исполнения.';
  if (!['interrupted', 'waiting', 'idle'].includes(task.run_state) || ['pending', 'running'].includes(task.title_state)) return 'Дождитесь завершения исполнения.';
  return null;
}
export type RunDiagnostic = DependencyDiagnostic & { last_activity_at?: string; stream_chars?: number; stream_updates?: number; can_interrupt?: boolean; interrupt_requested_at?: string; result_saved?: boolean; result_run_id?: string; error_kind?: FailureKind; execution_finished?: boolean; reset_at?: string | null; cli_version?: string; session_id?: string; turn_id?: string; usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } };
export type ExecutionPause = { paused: number; reset_at: string | null; state_version: number };
export type ReviewPlan = { policy_version?: 2; build_id: string; head_sha: string; source_hash: string; revision: number; diff_base: string; diff: string; requirements: string; checks: { role: ReviewRole; required: boolean; reason: string; reuse_run_id?: string }[] };
export const requiredReviews = (run: AgentRun): readonly ReviewRole[] => run.review_plan ? run.review_plan.checks.filter(c => c.required && !c.reuse_run_id).map(c => c.role) : reviewsFor(run.config);
export type AgentRun = {
  revoked?: number;
  review_plan?: Omit<ReviewPlan, 'diff' | 'requirements'>;
  output_preview?: string | null; output_at?: string | null; output_version?: number | null; output_length?: number | null;
  diagnostic?: RunDiagnostic; started_at?: string | null; finished_at?: string | null;
  repair_round_id: string | null; repair_attempt: number;
  spec_run_id: string | null; round_id: string | null; stale: number;
  role: 'spec' | 'build' | ReviewRole | 'approve'; head_sha: string | null; source_hash: string | null;
  id: string; task_id: string; project_id: string; description_revision: number;
  config: Settings; project_version: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  parent_run_id: string | null; branch: string; worktree: string; base_sha: string | null;
  outcome: BuildResult['outcome'] | ReviewResult['outcome'] | ApproveResult['outcome'] | null; error: string | null; report: number;
};

export type Question = { text: string; context: string; impact: string; options: string[]; required: boolean };
export type HumanRequest = {
  id: string; task_id: string; run_id: string; revision: number; role: 'spec' | 'build' | ReviewRole | 'approve';
  status: 'pending' | 'answered' | 'revoked'; result: SpecResult | BuildResult | ReviewResult | ApproveResult; answers: string[] | null;
};

export type ChatMessage = {
  id: string; task_id: string; revision: number; run_id: string | null; session_id: string | null;
  kind: 'guidance' | 'requirements'; text: string;
  status: 'queued' | 'sending' | 'delivered' | 'failed' | 'unknown' | 'applied' | 'revoked';
  created_at: string; delivered_at: string | null; error: string | null;
};
export type TranscriptEntry = { id: string; kind: 'agent' | 'tool' | 'event'; title: string; text: string; at: string; status?: string };

export type ModelOption = { id: string; name: string; reasoning_efforts?: { effort: string; description: string }[]; default_reasoning_effort?: string; fast?: { supported: boolean; reason: string; auth: 'chatgpt' | 'apiKey' | 'unknown' } };
export type ModelCatalog = { models: ModelOption[]; source: 'codex' | 'cache' | 'defaults'; updated_at: string | null; error?: string };
