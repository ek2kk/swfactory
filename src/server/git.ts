import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Project, ProjectInput } from '../shared.js';
import { Problem } from './store.js';

const exec = promisify(execFile);
export type Run = (file: string, args: string[], cwd: string) => Promise<string>;
export const run: Run = async (file, args, cwd) => {
  try {
    const result = await exec(file, args, {
      cwd, timeout: 15_000, maxBuffer: 512 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GLAB_PROMPT_DISABLED: '1' },
    });
    return result.stdout.trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Problem(422, `Не найден ${file} или checkout. Проверьте путь и установку CLI.`);
    // CLI output may contain credentials; expose an actionable context, not stderr.
    const operation = args[0] === 'auth' ? `Авторизация ${file} для ${args.at(-1)} не подтверждена. Выполните ${file} auth login для этого host.`
      : `Команда ${file} ${args[0]} не выполнена. Проверьте репозиторий, remote и целевую ветку.`;
    throw new Problem(422, operation);
  }
};

export function remoteIdentity(remote: string) {
  let host: string, repository: string;
  try {
    if (remote.includes('://')) {
      const url = new URL(remote);
      if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash || (url.protocol === 'https:' && url.username)) throw new Error();
      host = url.hostname;
      repository = url.pathname.slice(1);
    } else {
      const match = /^(?:[\w.-]+@)?([\w.-]+):([\w./-]+)$/.exec(remote);
      if (!match) throw new Error();
      [, host, repository] = match;
    }
    repository = repository.replace(/\.git$/, '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) || !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repository)
      || repository.split('/').some(part => part === '.' || part === '..')) throw new Error();
    return { host: host.toLowerCase(), repository };
  } catch {
    throw new Problem(422, 'Нужен HTTPS/SSH remote GitHub или GitLab без встроенного token. Используйте штатную авторизацию CLI.');
  }
}

export async function inspectProject(input: ProjectInput, command: Run = run): Promise<Omit<Project, 'id' | 'state_version'>> {
  if (!isAbsolute(input.checkout)) throw new Problem(422, 'Укажите абсолютный путь к checkout.');
  if (!/^[\w][\w.-]*$/.test(input.remote)) throw new Problem(422, 'Некорректное имя remote.');
  if (input.target_branch.startsWith('-')) throw new Problem(422, 'Некорректная целевая ветка.');
  let cwd: string;
  try { cwd = await realpath(input.checkout); }
  catch { throw new Problem(422, 'Checkout не найден. Укажите существующий локальный каталог.'); }
  const checkout = await realpath(await command('git', ['rev-parse', '--show-toplevel'], cwd));
  const common_dir = await realpath(await command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], checkout));
  await command('git', ['check-ref-format', `refs/heads/${input.target_branch}`], checkout);
  const remote_url = await command('git', ['remote', 'get-url', '--', input.remote], checkout);
  const identity = remoteIdentity(remote_url);
  if ((identity.host === 'github.com' && input.hosting !== 'github') || (identity.host === 'gitlab.com' && input.hosting !== 'gitlab')) {
    throw new Problem(422, 'Hosting не соответствует remote.');
  }
  await command('git', ['show-ref', '--verify', `refs/remotes/${input.remote}/${input.target_branch}`], checkout);
  await command(input.hosting === 'github' ? 'gh' : 'glab', ['auth', 'status', '--hostname', identity.host], checkout);
  return { ...input, checkout, common_dir, remote_url, ...identity };
}

export async function verifyRepository(project: Project, path: string, command: Run = run) {
  const checkout = await realpath(await command('git', ['rev-parse', '--show-toplevel'], path));
  const common = await realpath(await command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], checkout));
  if (checkout !== path || common !== project.common_dir
    || await command('git', ['remote', 'get-url', '--', project.remote], checkout) !== project.remote_url) {
    throw new Problem(422, 'Checkout или remote изменился. Подключите актуальный проект.');
  }
}

export async function preflight(project: Project, command: Run = run) {
  await verifyRepository(project, project.checkout, command);
  const checkout = project.checkout;
  const reasons: string[] = [];
  for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
    const path = await command('git', ['rev-parse', '--path-format=absolute', '--git-path', name], checkout);
    try { await realpath(path); reasons.push(`Незавершённый merge/rebase: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const status = await command('git', ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], checkout);
  if (status) reasons.push(`Изменения в checkout (staged / unstaged / untracked):\n${status}`);
  if (reasons.length) throw new Problem(422, reasons.join('\n'));
}

export async function fetchBase(project: Project, runId: string, command: Run = run) {
  const ref = `refs/swfactory/${runId}/base`;
  await command('git', ['fetch', '--no-tags', '--no-write-fetch-head', '--', project.remote, `refs/heads/${project.target_branch}:${ref}`], project.checkout);
  const sha = await command('git', ['rev-parse', '--verify', `${ref}^{commit}`], project.checkout);
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Problem(422, 'Fetch не вернул commit SHA.');
  return sha;
}
