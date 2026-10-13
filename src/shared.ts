export const stages = ['backlog', 'spec', 'build', 'review', 'approve', 'pr-created', 'needs-human'] as const;
export type Project = {
  id: string; checkout: string; common_dir: string; remote: string; remote_url: string;
  hosting: 'github' | 'gitlab'; host: string; repository: string; target_branch: string; state_version: number;
};
export type ProjectInput = Pick<Project, 'checkout' | 'remote' | 'hosting' | 'target_branch'>;
export type Task = {
  id: string; project_id: string; description: string; title: string | null;
  stage: typeof stages[number]; run_state: 'idle' | 'queued' | 'running' | 'waiting' | 'interrupted' | 'completed';
  publication_status: 'pending' | 'confirmed' | 'unknown' | null; pr_url: string | null; pr_number: number | null;
  deletion_state?: 'stopping' | 'failed' | 'deleted' | null; deletion_error?: string | null; stop_unverified?: number;
  state_version: number; revision: number;
  title_state: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
};
export type Revision = { task_id: string; revision: number; description: string; created_at: string };
export type SavedEvent = { id: number; type: string; task_id: string | null; payload: string; created_at: string };
export type Snapshot = { execution_pause?: ExecutionPause; projects: Project[]; tasks: Task[]; runs: AgentRun[]; human_requests: HumanRequest[]; execution_error?: string | null; title_error?: string | null; cursor: number };

export const roles = ['spec', 'build', 'review-code', 'review-security', 'review-ui', 'review-ux', 'approve'] as const;
export type Models = Record<typeof roles[number], string>;
export const defaultModels: Models = Object.fromEntries(roles.map(role => [role, 'gpt-6.1-sol'])) as Models;
export type Settings = { models: Models; instructions: string };
export type SpecResult = {
  outcome: 'READY' | 'NEEDS_INPUT'; title: string; summary: string; requirements: string[];
  acceptance_criteria: string[]; assumptions: string[]; out_of_scope: string[]; questions: Question[];
};
export type BuildResult = {
  outcome: 'READY' | 'NEEDS_INPUT' | 'BLOCKED'; summary: string; changed_paths: string[]; actions: string[]; checks: string[]; questions: Question[];
};
export const reviewRoles = ['review-code', 'review-security', 'review-ui', 'review-ux'] as const;
export type ReviewRole = typeof reviewRoles[number];
export type ReviewResult = {
  outcome: 'PASS' | 'CHANGES' | 'NEEDS_INPUT' | 'BLOCKED'; summary: string;
  findings: string[]; evidence: string[]; applicable: boolean; applicability: string; questions: Question[];
};
export type ApproveResult = {
  outcome: 'APPROVE' | 'ESCALATE' | 'NEEDS_INPUT'; summary: string; risks: string[]; affected_paths: string[]; questions: Question[];
};
export type FailureKind = 'authentication' | 'model_unavailable' | 'rate_limit' | 'protocol_error' | 'missing_artifact';
export type RunDiagnostic = { error_kind?: FailureKind; execution_finished?: boolean; reset_at?: string | null; cli_version?: string; session_id?: string; usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } };
export type ExecutionPause = { paused: number; reset_at: string | null; state_version: number };
export type AgentRun = {
  output_preview?: string | null; output_at?: string | null; output_version?: number | null;
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
