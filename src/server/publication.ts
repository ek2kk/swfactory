import { checkExecution } from './processes.js';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRun, Project, Task } from '../shared.js';
import { saveArtifact } from './artifacts.js';
import { type Run } from './git.js';
import { Problem } from './store.js';

export async function publishGithub(project: Project, task: Task, run: AgentRun, reviews: AgentRun[], directory: string,
  command: Run, verify: () => Promise<void>, observe: (operation: string, result?: string) => void = () => {}) {
  const marker = `<!-- swfactory-task:${task.id} -->`;
  const repo = `${project.host}/${project.repository}`;
  const api = `repos/${project.repository}/pulls`;
  const read = (id: string) => {
    const path = join(directory, 'artifacts', id, 'result.json');
    if (realpathSync(path) !== path) throw new Problem(422, 'Небезопасный путь отчёта.');
    return JSON.parse(readFileSync(path, 'utf8')).result;
  };
  const confirm = (pr: any) => {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || pr.html_url !== `https://${project.host}/${project.repository}/pull/${pr.number}`
      || pr.state !== 'open' || pr.merged_at || pr.head?.ref !== run.branch || pr.head?.sha !== run.head_sha
      || pr.head?.repo?.full_name !== project.repository || pr.base?.ref !== project.target_branch
      || pr.base?.repo?.full_name !== project.repository || typeof pr.body !== 'string' || !pr.body.includes(marker)) {
      throw new Problem(422, 'GitHub PR не соответствует одобренной версии. Нужна ручная сверка.');
    }
    return { number: pr.number as number, url: pr.html_url as string };
  };
  await verify();
  // Query every state: a closed PR must not silently become a duplicate.
  const pages = JSON.parse(await command('gh', ['api', '--hostname', project.host, '--paginate', '--slurp',
    `${api}?state=all&head=${encodeURIComponent(project.repository.split('/')[0] + ':' + run.branch)}&base=${encodeURIComponent(project.target_branch)}&per_page=100`], run.worktree));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Problem(422, 'Не удалось подтвердить поиск PR.');
  const existing = pages.flat();
  if (existing.length) {
    if (existing.length !== 1) throw new Problem(422, 'Найдено несколько PR; нужна ручная сверка.');
    await verify();
    const result = confirm(JSON.parse(await command('gh', ['api', '--hostname', project.host, `${api}/${existing[0].number}`], run.worktree)));
    await verify();
    return result;
  }
  const body = [marker, task.description, '## Summary', read(run.round_id!).summary, '## Reviews',
    ...reviews.map(r => `${r.role}: ${r.outcome}\n${read(r.id).summary}`), '## Approval', read(run.id).summary,
    `Approved head: ${run.head_sha}`, 'CI: not checked. Missing, pending or failed CI is not PASS. Merge remains a human action.'].join('\n\n');
  const artifacts = join(directory, 'artifacts', run.id);
  if (realpathSync(artifacts) !== artifacts) throw new Problem(422, 'Небезопасный путь отчёта.');
  saveArtifact(artifacts, 'pull-request.md', body);
  await verify();
  // Push the approved immutable SHA; no force-push and no target synchronization.
  if (await command('git', ['remote', 'get-url', '--push', '--all', '--', project.remote], run.worktree) !== project.remote_url) {
    throw new Problem(422, 'Push remote отличается от подтверждённого remote. Нужна ручная сверка.');
  }
  checkExecution(); observe('push');
  await command('git', ['push', '--', project.remote, `${run.head_sha}:refs/heads/${run.branch}`], run.worktree);
  observe('push', 'confirmed');
  await verify();
  checkExecution(); observe('pr-create');
  const url = await command('gh', ['pr', 'create', '--repo', repo, '--head', run.branch, '--base', project.target_branch,
    '--title', task.title ?? `Task ${task.id}`, '--body-file', join(artifacts, 'pull-request.md')], run.worktree);
  const prefix = `https://${project.host}/${project.repository}/pull/`;
  if (!url.startsWith(prefix) || !/^[1-9]\d*$/.test(url.slice(prefix.length))) throw new Problem(422, 'GitHub не подтвердил URL PR.');
  observe('pr-url', url);
  const result = confirm(JSON.parse(await command('gh', ['api', '--hostname', project.host, `${api}/${url.slice(prefix.length)}`], run.worktree)));
  await verify();
  return result;
}
