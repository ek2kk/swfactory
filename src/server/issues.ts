import { execFile } from 'node:child_process';
import type { Project, Snapshot } from '../shared.js';
import { Store, type GithubIssue } from './store.js';

export type IssueCommand = (args: string[], signal: AbortSignal) => Promise<string>;
class ImportFailure extends Error {}

export const githubIssueCommand: IssueCommand = (args, signal) => new Promise((resolve, reject) => {
  execFile('gh', args, { signal, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' }, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (!error) { resolve(stdout); return; }
    const message = error.code === 'ENOENT' ? 'Не найден gh. Установите GitHub CLI.'
      : error.killed || error.name === 'AbortError' ? 'Истекло время ожидания GitHub.'
      : /rate limit|HTTP 429/i.test(stderr) ? 'GitHub rate limit. Повторите запуск после восстановления лимита.'
      : /HTTP 40[13]|auth login|not logged/i.test(stderr) ? 'Авторизация GitHub не подтверждена. Выполните gh auth login для host проекта.'
      : 'Запрос GitHub не выполнен. Проверьте сеть, доступ к репозиторию и авторизацию gh.';
    reject(new ImportFailure(message));
  });
});

function parseIssue(value: unknown, project: Project): GithubIssue & { state: 'open' | 'closed'; ready: boolean; pullRequest: boolean } {
  const invalid = () => new ImportFailure('GitHub вернул некорректные данные issue. Импорт этих данных пропущен.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const issue = value as Record<string, unknown>;
  if (!Number.isSafeInteger(issue.number) || (issue.number as number) < 1 || !['open', 'closed'].includes(String(issue.state))
    || typeof issue.title !== 'string' || !issue.title.trim() || /[\x00-\x1f\x7f]/.test(issue.title)
    || (issue.body !== null && typeof issue.body !== 'string') || !Array.isArray(issue.labels)
    || typeof issue.html_url !== 'string') throw invalid();
  const pullRequest = Object.hasOwn(issue, 'pull_request');
  let url: URL;
  try { url = new URL(issue.html_url); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== project.host || url.port || url.username || url.password || url.search || url.hash
    || url.pathname.toLowerCase() !== `/${project.repository}/${pullRequest ? 'pull' : 'issues'}/${issue.number}`.toLowerCase()) throw invalid();
  const labels = issue.labels.map(label => {
    if (typeof label === 'string') return label;
    if (!label || typeof label !== 'object' || typeof label.name !== 'string') throw invalid();
    return label.name as string;
  });
  const description = typeof issue.body === 'string' && issue.body.trim() ? issue.body : issue.title;
  if (issue.title.length > 4096 || description.length > 100_000 || description.includes('\0')) {
    throw new ImportFailure('Заголовок или описание issue превышает допустимый размер либо содержит NUL. Данные не обрезаны; импорт пропущен.');
  }
  return { number: issue.number as number, url: issue.html_url, title: issue.title, description,
    state: issue.state as 'open' | 'closed', ready: labels.includes('ready-for-agent'), pullRequest };
}

export class GithubIssues {
  errors: NonNullable<Snapshot['issue_errors']> = [];
  private controller = new AbortController();
  private job: Promise<void> = Promise.resolve();
  constructor(private store: Store, private publish: () => void, private command: IssueCommand = githubIssueCommand) {}
  start() {
    const projects = this.store.snapshot().projects.filter(project => project.hosting === 'github');
    this.job = Promise.all(projects.map(project => this.load(project))).then(() => {});
  }
  async settled() { await this.job; }
  async close() { this.controller.abort(); await this.job; }
  private fail(project: Project, error: unknown) {
    if (this.controller.signal.aborted) return;
    const message = error instanceof ImportFailure ? error.message : 'Не удалось загрузить или сохранить GitHub Issues. Проверьте сеть, авторизацию gh и data directory.';
    if (!this.errors.some(item => item.project_id === project.id && item.message === message)) this.errors.push({ project_id: project.id, message });
    this.publish();
  }
  private async request(project: Project, endpoint: string) {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    const response = await this.command(['api', '--hostname', project.host, '--method', 'GET', endpoint], signal);
    signal.throwIfAborted();
    try { return JSON.parse(response) as unknown; }
    catch { throw new ImportFailure('GitHub вернул некорректный JSON. Импорт этих данных пропущен.'); }
  }
  private async load(project: Project) {
    const retained = this.store.activeGithubIssues(project.id);
    try {
      // Do not depend on the selected UI project, a checkout, or gh issue list's total limit.
      for (let page = 1; ; page++) {
        const response = await this.request(project, `repos/${project.repository}/issues?state=open&labels=ready-for-agent&per_page=100&page=${page}`);
        if (!Array.isArray(response) || response.length > 100) throw new ImportFailure('GitHub вернул некорректную страницу issues. Загрузка остановлена.');
        const issues = response.map(value => parseIssue(value, project));
        let changed = false;
        for (const issue of issues) if (issue.state === 'open' && issue.ready && !issue.pullRequest) {
          if (this.store.importGithubIssue(project.id, issue)) changed = true;
        }
        if (changed) this.publish();
        if (response.length < 100) break;
      }
    } catch (error) { this.fail(project, error); }
    if (this.controller.signal.aborted) return;
    // Missing labels/pages/404 never prove closure; fetch each retained active link explicitly.
    for (const { issue_number } of retained) {
      try {
        const issue = parseIssue(await this.request(project, `repos/${project.repository}/issues/${issue_number}`), project);
        if (issue.number !== issue_number || issue.pullRequest) throw new ImportFailure('Ответ GitHub не соответствует исходной issue. Карточка сохранена.');
        if (issue.state === 'closed' && this.store.importGithubIssue(project.id, { number: issue_number, closed: true })) this.publish();
      } catch (error) { this.fail(project, error); }
      if (this.controller.signal.aborted) return;
    }
  }
}
