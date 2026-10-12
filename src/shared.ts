export const stages = ['backlog', 'spec', 'build', 'review', 'approve', 'pr-created', 'needs-human'] as const;
export type Project = {
  id: string; checkout: string; common_dir: string; remote: string; remote_url: string;
  hosting: 'github' | 'gitlab'; host: string; repository: string; target_branch: string; state_version: number;
};
export type ProjectInput = Pick<Project, 'checkout' | 'remote' | 'hosting' | 'target_branch'>;
export type Task = {
  id: string; project_id: string; description: string; title: string | null;
  stage: typeof stages[number]; run_state: 'idle' | 'queued' | 'running' | 'waiting' | 'interrupted' | 'completed';
  state_version: number; revision: number;
};
export type Revision = { task_id: string; revision: number; description: string; created_at: string };
export type SavedEvent = { id: number; type: string; task_id: string | null; payload: string; created_at: string };
export type Snapshot = { projects: Project[]; tasks: Task[]; runs: SpecRun[]; execution_error?: string | null; cursor: number };

export const roles = ['spec', 'build', 'review-code', 'review-security', 'review-ui', 'review-ux', 'approve'] as const;
export type Models = Record<typeof roles[number], string>;
export const defaultModels: Models = Object.fromEntries(roles.map(role => [role, 'gpt-6.1-sol'])) as Models;
export type Settings = { models: Models; instructions: string };
export type SpecResult = {
  outcome: 'READY' | 'NEEDS_INPUT'; summary: string; requirements: string[];
  acceptance_criteria: string[]; assumptions: string[]; out_of_scope: string[]; questions: string[];
};
export type SpecRun = {
  id: string; task_id: string; project_id: string; description_revision: number;
  config: Settings; project_version: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  branch: string; worktree: string; base_sha: string | null;
  outcome: SpecResult['outcome'] | null; error: string | null; report: number;
};
