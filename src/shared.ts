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
  title_state: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
};
export type Revision = { task_id: string; revision: number; description: string; created_at: string };
export type SavedEvent = { id: number; type: string; task_id: string | null; payload: string; created_at: string };
export type Snapshot = { projects: Project[]; tasks: Task[]; cursor: number; title_error?: string | null };
