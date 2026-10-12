import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultModels, reviewRoles, type ApproveResult, type ReviewResult, type BuildResult, type HumanRequest, type SpecResult, type Settings, type AgentRun, type Project, type Task, type Snapshot, type SavedEvent, type Revision } from '../shared.js';

export class Problem extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export class Store {
  readonly db!: Database.Database;
  private owner: Database.Database;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    directory = realpathSync(directory);
    chmodSync(directory, 0o700);
    this.owner = new Database(join(directory, 'owner.sqlite'), { timeout: 0 });
    chmodSync(join(directory, 'owner.sqlite'), 0o600);
    try {
      // A separate exclusive SQLite transaction is an OS-released lifetime lock.
      this.owner.exec('BEGIN EXCLUSIVE');
    } catch {
      this.owner.close();
      throw new Error('Этот data directory уже принадлежит другому backend.');
    }
    try {
      this.db = new Database(join(directory, 'state.sqlite'));
      chmodSync(join(directory, 'state.sqlite'), 0o600);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      const version = this.db.pragma('user_version', { simple: true });
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7) throw new Error('Версия базы новее приложения. Обновите приложение.');
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY, checkout TEXT NOT NULL, common_dir TEXT NOT NULL UNIQUE,
            remote TEXT NOT NULL, remote_url TEXT NOT NULL, hosting TEXT NOT NULL,
            host TEXT NOT NULL, repository TEXT NOT NULL, target_branch TEXT NOT NULL,
            state_version INTEGER NOT NULL DEFAULT 1
          );
          CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
            description TEXT NOT NULL, title TEXT, stage TEXT NOT NULL DEFAULT 'backlog',
            run_state TEXT NOT NULL DEFAULT 'idle', state_version INTEGER NOT NULL DEFAULT 1,
            revision INTEGER NOT NULL DEFAULT 1
          );
          CREATE TABLE IF NOT EXISTS task_revisions (
            task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
            description TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            PRIMARY KEY(task_id, revision)
          );
          CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, task_id TEXT REFERENCES tasks(id),
            payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          );
          CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS project_settings (
            project_id TEXT PRIMARY KEY REFERENCES projects(id), config TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), project_id TEXT NOT NULL REFERENCES projects(id),
            description_revision INTEGER NOT NULL, config TEXT NOT NULL, project_version INTEGER NOT NULL,
            status TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL, base_sha TEXT,
            outcome TEXT, error TEXT, report INTEGER NOT NULL DEFAULT 0);
        `);
        this.db.exec(`CREATE TABLE IF NOT EXISTS human_requests (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
          revision INTEGER NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL, answers TEXT);
        `);
        const runColumns = this.db.pragma('table_info(runs)') as { name: string }[];
        if (!runColumns.some(column => column.name === 'parent_run_id')) this.db.exec('ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id)');
        this.db.prepare("UPDATE runs SET status = 'interrupted', error = 'Backend перезапущен. Нужна ручная сверка.' WHERE status IN ('queued','running')").run();
        if (version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7) {
          // Both pre-integration branches used v2; inspect the column before upgrading either shape.
          const columns = this.db.pragma('table_info(tasks)') as { name: string }[];
          if (!columns.some(column => column.name === 'title_state')) {
            this.db.exec("ALTER TABLE tasks ADD COLUMN title_state TEXT NOT NULL DEFAULT 'interrupted';");
            this.db.exec("UPDATE tasks SET title_state = 'completed' WHERE title IS NOT NULL;");
          }
        }
        for (const [name, definition] of [['role', "TEXT NOT NULL DEFAULT 'spec'"], ['head_sha', 'TEXT'], ['source_hash', 'TEXT'], ['spec_run_id', 'TEXT'], ['round_id', 'TEXT'], ['stale', 'INTEGER NOT NULL DEFAULT 0'], ['repair_round_id', 'TEXT'], ['repair_attempt', 'INTEGER NOT NULL DEFAULT 0']]) {
          if (!runColumns.some(column => column.name === name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
        }
        if (Number(version) < 6) {
          // Recover the immutable Spec binding for existing Build continuations.
          for (const run of this.db.prepare("SELECT id, parent_run_id FROM runs WHERE role = 'build' ORDER BY rowid").all() as { id: string; parent_run_id: string }[]) {
            this.db.prepare("UPDATE runs SET spec_run_id = (SELECT CASE WHEN role = 'spec' THEN id ELSE spec_run_id END FROM runs WHERE id = ?) WHERE id = ?")
              .run(run.parent_run_id, run.id);
          }
        }
        this.db.pragma('user_version = 7');
        for (const task of this.db.prepare("SELECT * FROM tasks WHERE title_state IN ('pending','running')").all() as Task[]) {
          this.db.prepare("UPDATE tasks SET title_state = 'interrupted' WHERE id = ?").run(task.id);
          this.event('title.interrupted', task.id, { revision: task.revision });
        }
        for (const task of this.db.prepare("SELECT * FROM tasks WHERE run_state IN ('running','queued','waiting')").all() as Task[]) {
          this.db.prepare("UPDATE tasks SET run_state = 'interrupted', state_version = state_version + 1 WHERE id = ?").run(task.id);
          this.event('task.interrupted', task.id, { reason: 'Backend перезапущен. Нужна ручная проверка; работа не возобновлена.' });
        }
      })();
    } catch (error) {
      this.db?.close();
      this.owner.close();
      throw error;
    }
  }

  close() { this.db.close(); this.owner.close(); }
  snapshot(): Snapshot {
    return {
      projects: this.db.prepare('SELECT * FROM projects ORDER BY rowid').all() as Project[],
      tasks: this.db.prepare('SELECT * FROM tasks ORDER BY rowid').all() as Task[],
      runs: this.runs(),
      human_requests: this.humanRequests(),
      cursor: (this.db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id,
    };
  }
  events(after: number): SavedEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500').all(after) as SavedEvent[];
  }
  event(type: string, taskId: string | null, payload: unknown) {
    this.db.prepare('INSERT INTO events(type, task_id, payload) VALUES (?, ?, ?)').run(type, taskId, JSON.stringify(payload));
  }
  replay(id: string, fingerprint: string): unknown | undefined {
    const prior = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as { fingerprint: string; response: string } | undefined;
    if (!prior) return undefined;
    if (prior.fingerprint !== fingerprint) throw new Problem(409, 'Этот request ID уже использован для другого действия.');
    return JSON.parse(prior.response);
  }
  mutate(id: string, fingerprint: string, action: () => unknown) {
    return this.db.transaction(() => {
      const prior = this.replay(id, fingerprint);
      if (prior !== undefined) return prior;
      const response = action();
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?)').run(id, fingerprint, JSON.stringify(response));
      return response;
    })();
  }
  addProject(project: Omit<Project, 'id' | 'state_version'>) {
    if (this.db.prepare('SELECT id FROM projects WHERE common_dir = ?').get(project.common_dir)) {
      throw new Problem(409, 'Этот репозиторий уже подключён (включая linked worktrees).');
    }
    const saved = { ...project, id: randomUUID(), state_version: 1 };
    this.db.prepare(`INSERT INTO projects VALUES (@id, @checkout, @common_dir, @remote, @remote_url,
      @hosting, @host, @repository, @target_branch, @state_version)`).run(saved);
    this.event('project.connected', null, { project_id: saved.id });
    return saved;
  }
  project(id: string) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
    if (!project) throw new Problem(404, 'Проект не найден.');
    return project;
  }
  task(projectId: string, id: string) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(id, projectId) as Task | undefined;
    if (!task) throw new Problem(404, 'Задача не найдена в этом проекте.');
    return task;
  }
  createTask(projectId: string, description: string, version: number) {
    if (this.project(projectId).state_version !== version) throw new Problem(409, 'Настройки проекта изменились. Обновите страницу.');
    const id = randomUUID();
    this.db.prepare("INSERT INTO tasks(id, project_id, description, title_state) VALUES (?, ?, ?, 'pending')").run(id, projectId, description);
    this.db.prepare('INSERT INTO task_revisions(task_id, revision, description) VALUES (?, 1, ?)').run(id, description);
    this.event('task.created', id, { project_id: projectId, revision: 1 });
    return this.task(projectId, id);
  }
  editTask(projectId: string, id: string, description: string, version: number) {
    const task = this.task(projectId, id);
    if (task.state_version !== version) throw new Problem(409, 'Карточка изменилась. Загрузите актуальную редакцию перед сохранением.');
    if (!((['backlog', 'build'].includes(task.stage) && task.run_state === 'idle')
      || (task.stage === 'needs-human' && task.run_state === 'waiting'))) throw new Problem(409, 'Описание нельзя менять во время исполнения или до ручной сверки прерванной работы.');
    const reviewed = this.runs().find(r => r.task_id === id && r.role.startsWith('review-'));
    if (reviewed) this.invalidateReviews(reviewed);
    this.db.prepare("UPDATE human_requests SET status = 'revoked' WHERE task_id = ? AND status = 'pending'").run(id);
    this.db.prepare("UPDATE tasks SET stage = 'backlog', run_state = 'idle', description = ?, title = NULL, title_state = 'pending', revision = revision + 1, state_version = state_version + 1 WHERE id = ?").run(description, id);
    this.db.prepare('INSERT INTO task_revisions(task_id, revision, description) VALUES (?, ?, ?)').run(id, task.revision + 1, description);
    this.event('task.edited', id, { revision: task.revision + 1 });
    return this.task(projectId, id);
  }
  claimTitle(task: Task): Task | undefined {
    return this.db.transaction(() => {
      const current = this.task(task.project_id, task.id);
      if (current.revision !== task.revision || current.title_state !== 'pending'
        || current.stage !== 'backlog' || current.run_state !== 'idle') return;
      this.db.prepare("UPDATE tasks SET title_state = 'running' WHERE id = ?").run(task.id);
      this.event('title.started', task.id, { revision: task.revision });
      return current;
    })();
  }
  finishTitle(task: Task, title: string | null) {
    this.db.transaction(() => {
      const current = this.task(task.project_id, task.id);
      if (current.revision !== task.revision || current.title_state !== 'running') return;
      this.db.prepare('UPDATE tasks SET title = ?, title_state = ? WHERE id = ?').run(title, title === null ? 'failed' : 'completed', task.id);
      this.event(title === null ? 'title.failed' : 'title.completed', task.id, { revision: task.revision });
    })();
  }
  settings(projectId: string): Settings {
    this.project(projectId);
    const row = this.db.prepare('SELECT config FROM project_settings WHERE project_id = ?').get(projectId) as { config: string } | undefined;
    return row ? JSON.parse(row.config) : { models: { ...defaultModels }, instructions: '' };
  }
  saveSettings(projectId: string, config: Settings, version: number) {
    if (this.project(projectId).state_version !== version) throw new Problem(409, 'Настройки изменились. Загрузите актуальную версию.');
    this.db.prepare('INSERT INTO project_settings VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET config = excluded.config').run(projectId, JSON.stringify(config));
    this.db.prepare('UPDATE projects SET state_version = state_version + 1 WHERE id = ?').run(projectId);
    this.event('project.settings', null, { project_id: projectId });
    return this.settings(projectId);
  }
  runs(): AgentRun[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY rowid').all() as (Omit<AgentRun, 'config'> & { config: string })[])
      .map(row => ({ ...row, config: JSON.parse(row.config) }));
  }
  specRun(projectId: string, taskId: string, id: string) {
    this.task(projectId, taskId);
    const run = this.runs().find(run => run.id === id && run.task_id === taskId && run.project_id === projectId);
    if (!run) throw new Problem(404, 'Запуск не найден в этой задаче.');
    return run;
  }
  queueSpec(projectId: string, taskId: string, version: number, directory: string) {
    const task = this.task(projectId, taskId);
    if (task.state_version !== version || task.stage !== 'backlog' || task.run_state !== 'idle') throw new Problem(409, 'Задача изменилась или уже запущена.');
    const id = randomUUID();
    const run: AgentRun = { repair_round_id: null, repair_attempt: 0, spec_run_id: null, round_id: null, stale: 0, role: 'spec', head_sha: null, source_hash: null, id, task_id: taskId, project_id: projectId, description_revision: task.revision,
      config: this.settings(projectId), project_version: this.project(projectId).state_version, status: 'queued', parent_run_id: null,
      branch: `swfactory/${taskId}/${id}`, worktree: join(directory, 'worktrees', projectId, id),
      base_sha: null, outcome: null, error: null, report: 0 };
    this.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version,
      status, branch, worktree, base_sha, outcome, error, report, parent_run_id, role, head_sha, source_hash, spec_run_id, round_id, stale, repair_round_id, repair_attempt) VALUES (@id, @task_id, @project_id, @description_revision, @config, @project_version,
      @status, @branch, @worktree, @base_sha, @outcome, @error, @report, @parent_run_id, @role, @head_sha, @source_hash, @spec_run_id, @round_id, @stale, @repair_round_id, @repair_attempt)`).run({ ...run, config: JSON.stringify(run.config) });
    this.db.prepare("UPDATE tasks SET run_state = 'queued', state_version = state_version + 1 WHERE id = ?").run(taskId);
    if (task.title_state === 'pending' || task.title_state === 'running') {
      this.db.prepare("UPDATE tasks SET title_state = 'interrupted' WHERE id = ?").run(taskId);
      this.event('title.interrupted', taskId, { revision: task.revision, reason: 'spec' });
    }
    this.event('spec.queued', taskId, { run_id: id });
    return run;
  }
  queueBuild(projectId: string, taskId: string, version: number) {
    const task = this.task(projectId, taskId);
    const previous = this.runs().filter(run => run.task_id === taskId).at(-1);
    if (task.state_version !== version || task.stage !== 'build' || task.run_state !== 'idle'
      || !previous || previous.role !== 'spec' || previous.outcome !== 'READY' || previous.status !== 'completed'
      || previous.description_revision !== task.revision) throw new Problem(409, 'Нужна актуальная готовая Spec.');
    const run: AgentRun = { ...previous, id: randomUUID(), parent_run_id: previous.id, spec_run_id: previous.id, role: 'build',
      status: 'queued', outcome: null, error: null, report: 0 };
    this.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version,
      status, branch, worktree, base_sha, outcome, error, report, parent_run_id, role, head_sha, source_hash, spec_run_id, round_id, stale, repair_round_id, repair_attempt) VALUES (@id, @task_id, @project_id, @description_revision, @config, @project_version,
      @status, @branch, @worktree, @base_sha, @outcome, @error, @report, @parent_run_id, @role, @head_sha, @source_hash, @spec_run_id, @round_id, @stale, @repair_round_id, @repair_attempt)`)
      .run({ ...run, config: JSON.stringify(run.config) });
    this.db.prepare("UPDATE tasks SET run_state = 'queued', state_version = state_version + 1 WHERE id = ?").run(taskId);
    this.event('build.queued', taskId, { run_id: run.id });
    return run;
  }
  queueReview(projectId: string, taskId: string, version: number) {
    return this.db.transaction(() => {
      const task = this.task(projectId, taskId);
      const previous = this.runs().filter(run => run.task_id === taskId).at(-1);
      if (task.state_version !== version || task.stage !== 'review' || task.run_state !== 'idle'
        || !previous || previous.status !== 'completed' || previous.description_revision !== task.revision
        || previous.stale || !previous.head_sha || !previous.source_hash || !previous.spec_run_id
        || !(previous.role === 'build' ? previous.outcome === 'READY' : ['PASS', 'CHANGES'].includes(previous.outcome ?? ''))) {
        throw new Problem(409, 'Нужна актуальная реализация или завершённый reviewer.');
      }
      const index = previous.role === 'build' ? 0 : reviewRoles.indexOf(previous.role as typeof reviewRoles[number]) + 1;
      if (index >= reviewRoles.length) throw new Problem(409, 'Раунд Review уже завершён.');
      const run: AgentRun = { ...previous, id: randomUUID(), parent_run_id: previous.id,
        round_id: previous.round_id ?? previous.id, role: reviewRoles[index], status: 'queued', outcome: null, error: null, report: 0 };
      this.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version,
        status, branch, worktree, base_sha, outcome, error, report, parent_run_id, role, head_sha, source_hash, spec_run_id, round_id, stale, repair_round_id, repair_attempt)
        VALUES (@id, @task_id, @project_id, @description_revision, @config, @project_version,
        @status, @branch, @worktree, @base_sha, @outcome, @error, @report, @parent_run_id, @role, @head_sha, @source_hash, @spec_run_id, @round_id, @stale, @repair_round_id, @repair_attempt)`)
        .run({ ...run, config: JSON.stringify(run.config) });
      this.db.prepare("UPDATE tasks SET run_state = 'queued', state_version = state_version + 1 WHERE id = ?").run(taskId);
      this.event('review.queued', taskId, { run_id: run.id, role: run.role, round_id: run.round_id });
      return run;
    })();
  }
  queueApprove(projectId: string, taskId: string, version: number) {
    return this.db.transaction(() => {
      const task = this.task(projectId, taskId);
      const previous = this.runs().filter(r => r.task_id === taskId).at(-1);
      if (task.state_version !== version || task.stage !== 'approve' || task.run_state !== 'idle'
        || !previous || previous.role !== 'review-ux' || !this.reviewPasses(previous)) throw new Problem(409, 'Нужны четыре актуальных PASS.');
      const run: AgentRun = { ...previous, id: randomUUID(), parent_run_id: previous.id, role: 'approve', status: 'queued', outcome: null, error: null, report: 0 };
      this.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version,
        status, branch, worktree, base_sha, outcome, error, report, parent_run_id, role, head_sha, source_hash, spec_run_id, round_id, stale, repair_round_id, repair_attempt)
        VALUES (@id, @task_id, @project_id, @description_revision, @config, @project_version,
        @status, @branch, @worktree, @base_sha, @outcome, @error, @report, @parent_run_id, @role, @head_sha, @source_hash, @spec_run_id, @round_id, @stale, @repair_round_id, @repair_attempt)`)
        .run({ ...run, config: JSON.stringify(run.config) });
      this.db.prepare("UPDATE tasks SET run_state = 'queued', state_version = state_version + 1 WHERE id = ?").run(taskId);
      this.event('approve.queued', taskId, { run_id: run.id });
      return run;
    })();
  }
  decide(projectId: string, taskId: string, requestId: string, version: number, decision: 'publish' | 'repair', feedback: string) {
    return this.db.transaction(() => {
      const task = this.task(projectId, taskId);
      const request = this.humanRequests().find(r => r.id === requestId && r.task_id === taskId);
      if (!request) throw new Problem(404, 'Запрос не найден.');
      const previous = this.specRun(projectId, taskId, request.run_id);
      if (task.state_version !== version || task.stage !== 'needs-human' || task.run_state !== 'waiting'
        || request.status !== 'pending' || request.revision !== task.revision || previous.role !== 'approve'
        || previous.status !== 'completed' || previous.outcome !== 'ESCALATE' || previous.stale
        || this.runs().filter(r => r.task_id === taskId).at(-1)?.id !== previous.id || !this.reviewPasses(previous)) throw new Problem(409, 'Решение устарело.');
      if (!['publish', 'repair'].includes(decision) || typeof feedback !== 'string' || feedback.length > 4096
        || (decision === 'repair' && !feedback.trim())) throw new Problem(422, 'Укажите причину доработки.');
      this.db.prepare("UPDATE human_requests SET status = 'answered', answers = ? WHERE id = ?").run(JSON.stringify([decision, feedback]), requestId);
      this.event('approve.decided', taskId, { human_request_id: requestId, run_id: previous.id, head_sha: previous.head_sha, decision, scope: 'publish-only' });
      if (decision === 'publish') {
        this.db.prepare("UPDATE tasks SET stage = 'approve', run_state = 'completed', state_version = state_version + 1 WHERE id = ?").run(taskId);
        return { run: null };
      }
      const run: AgentRun = { ...previous, id: randomUUID(), parent_run_id: previous.id, role: 'build', round_id: null,
        repair_round_id: previous.round_id, repair_attempt: 0, status: 'queued', outcome: null, error: null, report: 0 };
      this.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version,
        status, branch, worktree, base_sha, outcome, error, report, parent_run_id, role, head_sha, source_hash, spec_run_id, round_id, stale, repair_round_id, repair_attempt)
        VALUES (@id, @task_id, @project_id, @description_revision, @config, @project_version,
        @status, @branch, @worktree, @base_sha, @outcome, @error, @report, @parent_run_id, @role, @head_sha, @source_hash, @spec_run_id, @round_id, @stale, @repair_round_id, @repair_attempt)`)
        .run({ ...run, config: JSON.stringify(run.config) });
      this.invalidateReviews(previous);
      this.db.prepare("UPDATE tasks SET stage = 'build', run_state = 'queued', state_version = state_version + 1 WHERE id = ?").run(taskId);
      this.event('repair.queued', taskId, { run_id: run.id, human_request_id: requestId });
      return { run };
    })();
  }
  reviewRound(run: AgentRun) {
    const runs = this.runs();
    return reviewRoles.map(role => runs.filter(r => r.task_id === run.task_id && r.round_id === run.round_id && r.role === role).at(-1));
  }
  queueRepair(projectId: string, taskId: string, version: number, manual = false) {
    return this.db.transaction(() => {
      const task = this.task(projectId, taskId);
      const previous = this.runs().filter(r => r.task_id === taskId).at(-1);
      if (task.state_version !== version || task.stage !== 'needs-human' || task.run_state !== 'interrupted'
        || !previous || previous.role !== 'review-ux' || previous.description_revision !== task.revision
        || (!manual && previous.repair_attempt >= 2)) throw new Problem(409, 'Нужен завершённый раунд с замечаниями и доступный бюджет доработок.');
      const round = this.reviewRound(previous);
      if (!round.every(r => r && r.status === 'completed' && !r.stale && ['PASS', 'CHANGES'].includes(r.outcome ?? '')
        && r.head_sha === previous.head_sha && r.source_hash === previous.source_hash && r.spec_run_id === previous.spec_run_id
        && r.base_sha === previous.base_sha && r.description_revision === task.revision)
        || !round.some(r => r?.outcome === 'CHANGES')) throw new Problem(409, 'Нет полного актуального раунда с замечаниями.');
      const run: AgentRun = { ...previous, id: randomUUID(), parent_run_id: previous.id, role: 'build',
        round_id: null, repair_round_id: previous.round_id, repair_attempt: manual ? 0 : previous.repair_attempt,
        status: 'queued', outcome: null, error: null, report: 0 };
      this.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version,
        status, branch, worktree, base_sha, outcome, error, report, parent_run_id, role, head_sha, source_hash, spec_run_id, round_id, stale, repair_round_id, repair_attempt)
        VALUES (@id, @task_id, @project_id, @description_revision, @config, @project_version,
        @status, @branch, @worktree, @base_sha, @outcome, @error, @report, @parent_run_id, @role, @head_sha, @source_hash, @spec_run_id, @round_id, @stale, @repair_round_id, @repair_attempt)`)
        .run({ ...run, config: JSON.stringify(run.config) });
      this.db.prepare("UPDATE tasks SET stage = 'build', run_state = 'queued', state_version = state_version + 1 WHERE id = ?").run(taskId);
      this.event(manual ? 'repair.restarted' : 'repair.queued', taskId, { run_id: run.id, round_id: run.repair_round_id, completed_repairs: run.repair_attempt });
      return run;
    })();
  }
  reviewPasses(run: AgentRun) {
    const runs = this.runs();
    return reviewRoles.every(role => {
      const result = runs.filter(r => r.task_id === run.task_id && r.round_id === run.round_id && r.role === role).at(-1);
      return result?.status === 'completed' && result.outcome === 'PASS' && !result.stale
        && result.description_revision === run.description_revision && result.spec_run_id === run.spec_run_id
        && result.base_sha === run.base_sha && result.head_sha === run.head_sha && result.source_hash === run.source_hash;
    });
  }
  invalidateReviews(run: AgentRun) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE runs SET stale = 1 WHERE task_id = ? AND (role LIKE 'review-%' OR role = 'approve')").run(run.task_id);
      this.db.prepare("UPDATE tasks SET stage = 'needs-human', run_state = 'interrupted', state_version = state_version + 1 WHERE id = ? AND stage IN ('review','approve','needs-human') AND run_state IN ('idle','completed','waiting')").run(run.task_id);
      this.db.prepare("UPDATE human_requests SET status = 'revoked' WHERE task_id = ? AND role = 'approve' AND (status = 'pending' OR json_extract(answers, '$[0]') = 'publish')").run(run.task_id);
      this.event('review.stale', run.task_id, { run_id: run.id, reason: 'Git state или source изменён' });
    })();
  }
  updateRun(run: AgentRun, stage: Task['stage'], state: Task['run_state'], title?: string, result?: SpecResult | BuildResult | ReviewResult | ApproveResult) {
    this.db.transaction(() => {
      const task = this.task(run.project_id, run.task_id);
      const current = this.specRun(run.project_id, run.task_id, run.id);
      if (!['queued', 'running'].includes(current.status) || task.revision !== run.description_revision
        || !['queued', 'running'].includes(task.run_state)) throw new Problem(409, 'Результат запуска устарел.');
      this.db.prepare('UPDATE runs SET status = @status, base_sha = @base_sha, outcome = @outcome, error = @error, report = @report, head_sha = @head_sha, source_hash = @source_hash, repair_attempt = @repair_attempt WHERE id = @id').run(run);
      this.db.prepare('UPDATE tasks SET stage = ?, run_state = ?, state_version = state_version + 1 WHERE id = ?').run(stage, state, run.task_id);
      if (run.status === 'completed' && !task.title && title !== undefined) {
        this.db.prepare("UPDATE tasks SET title = ?, title_state = 'completed' WHERE id = ?").run(title, task.id);
        this.event('title.completed', task.id, { revision: task.revision, source: 'spec' });
      }
      if (run.status === 'completed' && ['NEEDS_INPUT', 'ESCALATE'].includes(run.outcome ?? '')) {
        if (!result) throw new Problem(422, 'Отсутствуют вопросы агента.');
        const id = randomUUID();
        this.db.prepare("INSERT INTO human_requests VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)")
          .run(id, task.id, run.id, task.revision, run.role, JSON.stringify(result));
        this.event('human.requested', task.id, { human_request_id: id, run_id: run.id });
      }
      this.event(`${run.role}.${run.status}`, run.task_id, { run_id: run.id, stage, outcome: run.outcome, error: run.error });
    })();
  }
  humanRequests(): HumanRequest[] {
    return (this.db.prepare('SELECT * FROM human_requests ORDER BY rowid').all() as (Omit<HumanRequest, 'result' | 'answers'> & { result: string; answers: string | null })[])
      .map(row => ({ ...row, result: JSON.parse(row.result), answers: row.answers === null ? null : JSON.parse(row.answers) }));
  }
  answer(projectId: string, taskId: string, requestId: string, version: number, answers: string[]) {
    return this.db.transaction(() => {
      const task = this.task(projectId, taskId);
      const request = this.humanRequests().find(request => request.id === requestId && request.task_id === taskId);
      if (!request) throw new Problem(404, 'Вопрос не найден в этой задаче.');
      const previous = this.specRun(projectId, taskId, request.run_id);
      if (task.state_version !== version || request.status !== 'pending' || request.revision !== task.revision
        || task.stage !== 'needs-human' || !['waiting', 'interrupted'].includes(task.run_state)
        || previous.status !== 'completed' || previous.outcome !== 'NEEDS_INPUT'
        || this.runs().filter(run => run.task_id === taskId).at(-1)?.id !== previous.id) {
        throw new Problem(409, 'Вопрос отозван, уже отвечен или устарел. Обновите карточку.');
      }
      if (!Array.isArray(answers) || answers.length !== request.result.questions.length
        || answers.some((answer, i) => typeof answer !== 'string' || answer.length > 4096 || (request.result.questions[i].required && !answer.trim()))) {
        throw new Problem(422, 'Ответьте на все обязательные вопросы.');
      }
      this.db.prepare("UPDATE human_requests SET answers = ?, status = 'answered' WHERE id = ?").run(JSON.stringify(answers), requestId);
      this.event('human.answered', taskId, { human_request_id: requestId, run_id: previous.id });
      this.db.prepare('UPDATE tasks SET state_version = state_version + 1 WHERE id = ?').run(taskId);
      // After restart we preserve the answer, but recovery requires manual reconciliation.
      if (task.run_state === 'interrupted') return { run: null };
      const run: AgentRun = { ...previous, id: randomUUID(), parent_run_id: previous.id, status: 'queued', outcome: null, error: null, report: 0 };
      this.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version,
      status, branch, worktree, base_sha, outcome, error, report, parent_run_id, role, head_sha, source_hash, spec_run_id, round_id, stale, repair_round_id, repair_attempt) VALUES (@id, @task_id, @project_id, @description_revision, @config, @project_version,
        @status, @branch, @worktree, @base_sha, @outcome, @error, @report, @parent_run_id, @role, @head_sha, @source_hash, @spec_run_id, @round_id, @stale, @repair_round_id, @repair_attempt)`).run({ ...run, config: JSON.stringify(run.config) });
      this.db.prepare("UPDATE tasks SET stage = ?, run_state = 'queued' WHERE id = ?").run(run.role.startsWith('review-') ? 'review' : run.role, taskId);
      this.event(`${run.role}.queued`, taskId, { run_id: run.id, parent_run_id: previous.id });
      return { run };
    })();
  }
  revisions(projectId: string, id: string): Revision[] {
    this.task(projectId, id);
    return this.db.prepare('SELECT * FROM task_revisions WHERE task_id = ? ORDER BY revision').all(id) as Revision[];
  }
}
