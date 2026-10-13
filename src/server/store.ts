import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultModels, reviewRoles, type ApproveResult, type ReviewResult, type BuildResult, type HumanRequest, type SpecResult, type Settings, type AgentRun, type Project, type Task, type Snapshot, type SavedEvent, type Revision, type ExecutionPause } from '../shared.js';

export class Problem extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export type GithubIssue = { number: number; url: string; title: string; description: string };

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
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8 && version !== 9 && version !== 10 && version !== 11 && version !== 12 && version !== 13 && version !== 14 && version !== 15 && version !== 16) throw new Error('Версия базы новее приложения. Обновите приложение.');
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
        if (version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8) {
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
        const taskColumns = this.db.pragma('table_info(tasks)') as { name: string }[];
        for (const [name, type] of [['publication_status', 'TEXT'], ['pr_url', 'TEXT'], ['pr_number', 'INTEGER'], ['deletion_state', 'TEXT'], ['deletion_error', 'TEXT'], ['execution_unverified', 'INTEGER NOT NULL DEFAULT 0'], ['stop_unverified', 'INTEGER NOT NULL DEFAULT 0'], ['archived', 'INTEGER NOT NULL DEFAULT 0'], ['archive_source', 'TEXT'], ['archive_reason', 'TEXT']]) {
          if (!taskColumns.some(c => c.name === name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
        }
        for (const task of this.db.prepare("SELECT id FROM tasks WHERE publication_status = 'pending'").all() as { id: string }[]) {
          this.db.prepare("UPDATE tasks SET publication_status = 'unknown', stage = 'needs-human', run_state = 'interrupted', state_version = state_version + 1 WHERE id = ?").run(task.id);
          this.event('publication.unknown', task.id, { reason: 'Backend перезапущен. Нужна ручная сверка GitHub; повтор запрещён.' });
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS execution_pause (id INTEGER PRIMARY KEY CHECK (id = 1), paused INTEGER NOT NULL, reset_at TEXT, state_version INTEGER NOT NULL);
          INSERT OR IGNORE INTO execution_pause VALUES (1, 0, NULL, 1);`);
        for (const [name, type] of [['diagnostic', "TEXT NOT NULL DEFAULT '{}'"], ['started_at', 'TEXT'], ['finished_at', 'TEXT']]) {
          if (!runColumns.some(c => c.name === name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS run_output (
          run_id TEXT PRIMARY KEY REFERENCES runs(id), text TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL);`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
          run_id TEXT REFERENCES runs(id), session_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), delivered_at TEXT, error TEXT);
          CREATE INDEX IF NOT EXISTS chat_task ON chat_messages(task_id);
          UPDATE chat_messages SET status = 'unknown', error = 'Backend перезапущен без подтверждения доставки. Автоматического повтора нет.' WHERE status = 'sending';`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS github_issues (
          project_id TEXT NOT NULL REFERENCES projects(id), issue_number INTEGER NOT NULL,
          issue_url TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
          imported_version INTEGER NOT NULL, PRIMARY KEY(project_id, issue_number));`);
        if (Number(version) < 14) this.db.exec("UPDATE tasks SET archived = 1 WHERE deletion_state = 'deleted'");
        if (Number(version) < 16) {
          // Only the old automatic closure event, without any manual deletion intent, proves provenance.
          for (const row of this.db.prepare(`SELECT t.id, g.issue_number FROM tasks t JOIN github_issues g ON g.task_id = t.id
            WHERE t.archived = 1 AND t.archive_source IS NULL
              AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'task.deletion-requested')`).all() as { id: string; issue_number: number }[]) {
            const archives = this.db.prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'task.archived'").all(row.id) as { payload: string }[];
            if (archives.length !== 1) continue;
            try {
              const payload = JSON.parse(archives[0].payload);
              if (payload.reason === 'Исходная GitHub issue закрыта.' && payload.issue_number === row.issue_number) {
                this.db.prepare("UPDATE tasks SET archive_source = 'github-filter', archive_reason = ? WHERE id = ?").run(payload.reason, row.id);
              }
            } catch { /* Ambiguous archives remain manual. */ }
          }
          this.db.exec("UPDATE tasks SET archive_source = 'manual' WHERE archived = 1 AND archive_source IS NULL");
        }
        this.db.pragma('user_version = 16');
        // No OS proof survives restart. Never infer termination from SQLite run status.
        if (Number(version) < 13) {
          this.db.exec(`UPDATE tasks SET stop_unverified = 1
            WHERE (title_state <> 'pending'
              OR EXISTS (SELECT 1 FROM runs WHERE runs.task_id = tasks.id)
              OR EXISTS (SELECT 1 FROM events WHERE events.task_id = tasks.id
                AND type IN ('title.started', 'title.completed', 'title.failed', 'title.interrupted', 'execution.process-started')))
            AND NOT EXISTS (SELECT 1 FROM events WHERE events.task_id = tasks.id AND type = 'task.stop-verified-by-human')`);
        }
        this.db.prepare("UPDATE tasks SET stop_unverified = 1 WHERE execution_unverified = 1 OR title_state = 'running' OR run_state = 'running'").run();
        this.db.prepare("UPDATE tasks SET deletion_state = 'failed', deletion_error = 'Backend перезапущен во время удаления. Проверьте процессы вручную; остановка не подтверждена.', stop_unverified = 1 WHERE deletion_state = 'stopping'").run();
        for (const task of this.db.prepare("SELECT * FROM tasks WHERE title_state IN ('pending','running')").all() as Task[]) {
          this.db.prepare("UPDATE tasks SET title_state = 'interrupted' WHERE id = ?").run(task.id);
          this.event('title.interrupted', task.id, { revision: task.revision });
        }
        for (const task of this.db.prepare("SELECT * FROM tasks WHERE run_state IN ('running','queued') OR (run_state = 'waiting' AND execution_unverified = 1)").all() as Task[]) {
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
      tasks: this.db.prepare("SELECT t.*, g.issue_number, g.issue_url FROM tasks t LEFT JOIN github_issues g ON g.task_id = t.id WHERE archived = 0 ORDER BY t.rowid").all() as Task[],
      archived_tasks: this.db.prepare("SELECT t.*, g.issue_number, g.issue_url FROM tasks t LEFT JOIN github_issues g ON g.task_id = t.id WHERE archived = 1 ORDER BY t.rowid").all() as Task[],
      runs: this.runs().filter(r => !(this.db.prepare('SELECT archived FROM tasks WHERE id = ?').get(r.task_id) as Task).archived), execution_pause: this.executionPause(),
      human_requests: this.humanRequests().filter(r => !this.blocked(r.task_id)),
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
  rawTask(projectId: string, id: string) {
    const task = this.db.prepare('SELECT t.*, g.issue_number, g.issue_url FROM tasks t LEFT JOIN github_issues g ON g.task_id = t.id WHERE t.id = ? AND t.project_id = ?').get(id, projectId) as Task | undefined;
    if (!task) throw new Problem(404, 'Задача не найдена в этом проекте.');
    return task;
  }
  blocked(id: string) {
    const task = this.db.prepare('SELECT archived, deletion_state FROM tasks WHERE id = ?').get(id) as Task | undefined;
    return !!(task?.archived || task?.deletion_state);
  }
  task(projectId: string, id: string) {
    const task = this.rawTask(projectId, id);
    if (task.archived || task.deletion_state) throw new Problem(409, 'Удаление задачи принято. Новые действия заблокированы.');
    return task;
  }
  archiveTask(projectId: string, id: string, version: number, source: 'manual' | 'github-filter' = 'manual', reason: string | null = null) {
    return this.db.transaction(() => {
      const task = this.rawTask(projectId, id);
      if (task.state_version !== version) throw new Problem(409, 'Карточка изменилась. Обновите её перед архивированием.');
      if (task.archived && (source !== 'manual' || task.archive_source === 'manual')) return task;
      if (!task.archived && task.deletion_state !== 'stopping') this.beginDeletion(projectId, id, version);
      this.db.prepare('UPDATE tasks SET archived = 1, archive_source = ?, archive_reason = ?, state_version = state_version + 1 WHERE id = ?').run(source, reason, id);
      this.event('task.archived', id, { source, reason, warning: 'Карточка скрыта; результат остановки доступен в архиве.' });
      return this.rawTask(projectId, id);
    }).immediate();
  }
  beginDeletion(projectId: string, id: string, version: number, reconciliation?: string) {
    const task = this.rawTask(projectId, id);
    if (task.deletion_state === 'deleted' && task.archived) return task;
    if (task.state_version !== version) throw new Problem(409, 'Карточка изменилась. Обновите её перед удалением.');
    if (task.deletion_state === 'deleted') return task;
    if (reconciliation) {
      if (task.deletion_state !== 'failed' || !task.stop_unverified) throw new Problem(409, 'Ручная сверка доступна только для неподтверждённой остановки процессов.');
      this.db.prepare('UPDATE tasks SET stop_unverified = 0, execution_unverified = 0 WHERE id = ?').run(id);
      this.event('task.stop-verified-by-human', id, { evidence: reconciliation, state_version: task.state_version, revision: task.revision });
    }
    this.db.prepare("UPDATE tasks SET deletion_state = 'stopping', deletion_error = NULL, state_version = state_version + 1 WHERE id = ?").run(id);
    this.db.prepare("UPDATE human_requests SET status = 'revoked' WHERE task_id = ? AND status = 'pending'").run(id);
    this.db.prepare("UPDATE chat_messages SET status = 'revoked', error = 'Задача удаляется; доставка и применение запрещены.' WHERE task_id = ? AND status IN ('queued','sending')").run(id);
    this.event('task.deletion-requested', id, {});
    return this.rawTask(projectId, id);
  }
  finishDeletion(id: string, error?: string) {
    this.db.transaction(() => {
      this.db.prepare('UPDATE tasks SET deletion_state = ?, deletion_error = ?, state_version = state_version + 1 WHERE id = ?')
        .run(error ? 'failed' : 'deleted', error ?? null, id);
      this.db.prepare("UPDATE runs SET status = 'interrupted', error = 'Исполнение остановлено при архивировании.', finished_at = ? WHERE task_id = ? AND status IN ('queued','running')").run(new Date().toISOString(), id);
      // Visibility belongs to archive/restore, never to a late stop callback (except legacy /delete).
      this.db.prepare(`UPDATE tasks SET archived = CASE WHEN ? = 0 AND archive_source IS NOT 'github-filter' THEN 1 ELSE archived END,
        run_state = CASE WHEN run_state IN ('queued','running','waiting') THEN 'interrupted' ELSE run_state END,
        title_state = CASE WHEN title_state IN ('pending','running') THEN 'interrupted' ELSE title_state END,
        publication_status = CASE WHEN publication_status = 'pending' THEN 'unknown' ELSE publication_status END WHERE id = ?`).run(Number(!!error), id);
      this.event(error ? 'task.deletion-failed' : 'task.deleted', id, { error: error ?? null, warning: (this.db.prepare('SELECT publication_status FROM tasks WHERE id = ?').get(id) as Task).publication_status === 'unknown' ? 'Remote операция могла завершиться. Проверьте hosting вручную; автоматического повтора нет. Task marker: ' + id : null });
    })();
  }
  releaseStoppedTask(projectId: string, id: string) {
    this.db.transaction(() => {
      const task = this.rawTask(projectId, id);
      if (task.archived || task.deletion_state !== 'deleted' || task.stop_unverified || task.execution_unverified) return;
      // A new Spec is explicit; interrupted runs and unknown publication remain in history.
      const restartable = task.run_state === 'interrupted' && !task.publication_status;
      this.db.prepare('UPDATE tasks SET deletion_state = NULL, stage = ?, run_state = ?, state_version = state_version + 1 WHERE id = ?')
        .run(restartable ? 'backlog' : task.stage, restartable ? 'idle' : task.run_state, id);
      this.event('task.execution-unblocked', id, {});
    }).immediate();
  }
  createTask(projectId: string, description: string, version: number) {
    if (this.project(projectId).state_version !== version) throw new Problem(409, 'Настройки проекта изменились. Обновите страницу.');
    const id = randomUUID();
    this.db.prepare("INSERT INTO tasks(id, project_id, description, title_state) VALUES (?, ?, ?, 'pending')").run(id, projectId, description);
    this.db.prepare('INSERT INTO task_revisions(task_id, revision, description) VALUES (?, 1, ?)').run(id, description);
    this.event('task.created', id, { project_id: projectId, revision: 1 });
    return this.task(projectId, id);
  }
  retainedGithubIssues(projectId: string) {
    return this.db.prepare('SELECT issue_number FROM github_issues WHERE project_id = ?').all(projectId) as { issue_number: number }[];
  }
  reconcileGithubIssue(projectId: string, number: number, matches: boolean, reason: string) {
    return this.db.transaction(() => {
      const link = this.db.prepare('SELECT task_id FROM github_issues WHERE project_id = ? AND issue_number = ?').get(projectId, number) as { task_id: string } | undefined;
      if (!link) return;
      const task = this.rawTask(projectId, link.task_id);
      if (!matches) {
        if (task.archived) return;
        return this.archiveTask(projectId, task.id, task.state_version, 'github-filter', reason);
      }
      if (!task.archived || task.archive_source !== 'github-filter') return;
      this.db.prepare('UPDATE tasks SET archived = 0, state_version = state_version + 1 WHERE id = ?').run(task.id);
      this.event('task.restored', task.id, { source: 'github-filter', issue_number: number });
      return this.rawTask(projectId, task.id);
    }).immediate();
  }
  importGithubIssue(projectId: string, issue: GithubIssue) {
    return this.db.transaction(() => {
      const link = this.db.prepare('SELECT task_id, imported_version FROM github_issues WHERE project_id = ? AND issue_number = ?')
        .get(projectId, issue.number) as { task_id: string; imported_version: number } | undefined;
      if (!link) {
        const task = this.createTask(projectId, issue.description, this.project(projectId).state_version);
        this.db.prepare("UPDATE tasks SET title = ?, title_state = 'completed' WHERE id = ?").run(issue.title, task.id);
        this.db.prepare('INSERT INTO github_issues VALUES (?, ?, ?, ?, ?)').run(projectId, issue.number, issue.url, task.id, task.state_version);
        return true;
      }
      const task = this.rawTask(projectId, link.task_id);
      // The import baseline advances only for GitHub changes; even a reverted local edit breaks it.
      if (task.archived || task.deletion_state || task.stage !== 'backlog' || task.run_state !== 'idle'
        || task.title_state !== 'completed' || task.state_version !== link.imported_version
        || task.execution_unverified || task.stop_unverified
        || this.db.prepare('SELECT 1 FROM runs WHERE task_id = ? LIMIT 1').get(task.id)) return false;
      if (task.title === issue.title && task.description === issue.description) return false;
      const revision = task.revision + Number(task.description !== issue.description);
      this.db.prepare('UPDATE tasks SET title = ?, description = ?, revision = ?, state_version = state_version + 1 WHERE id = ?')
        .run(issue.title, issue.description, revision, task.id);
      if (revision !== task.revision) this.db.prepare('INSERT INTO task_revisions(task_id, revision, description) VALUES (?, ?, ?)').run(task.id, revision, issue.description);
      this.db.prepare('UPDATE github_issues SET imported_version = ? WHERE task_id = ?').run(task.state_version + 1, task.id);
      this.event('task.issue-updated', task.id, { revision, issue_number: issue.number });
      return true;
    }).immediate();
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
    this.db.prepare("UPDATE chat_messages SET status = 'revoked' WHERE task_id = ? AND status = 'queued'").run(id);
    this.event('task.edited', id, { revision: task.revision + 1 });
    return this.task(projectId, id);
  }
  claimTitle(task: Task): Task | undefined {
    if (this.blocked(task.id)) return;
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
    if (this.blocked(task.id)) return;
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
  executionPause(): ExecutionPause {
    return this.db.prepare('SELECT paused, reset_at, state_version FROM execution_pause WHERE id = 1').get() as ExecutionPause;
  }
  pauseExecution(resetAt: string | null) {
    const current = this.executionPause();
    const until = current.paused ? (!current.reset_at || !resetAt ? null : [current.reset_at, resetAt].sort().at(-1)!) : resetAt;
    this.db.prepare('UPDATE execution_pause SET paused = 1, reset_at = ?, state_version = state_version + 1 WHERE id = 1').run(until);
    this.event('execution.paused', null, { reset_at: until });
  }
  resumeExecution(version: number) {
    const pause = this.executionPause();
    if (pause.state_version !== version || !pause.paused || (pause.reset_at && Date.parse(pause.reset_at) > Date.now())) throw new Problem(409, 'Пауза уже изменена.');
    this.db.prepare('UPDATE execution_pause SET paused = 0, reset_at = NULL, state_version = state_version + 1 WHERE id = 1').run();
    this.event('execution.resumed', null, {});
    return this.executionPause();
  }
  requestInterrupt(projectId: string, taskId: string, runId: string, version: number) {
    const task = this.task(projectId, taskId);
    const run = this.specRun(projectId, taskId, runId);
    if (task.state_version !== version || task.run_state !== 'running' || task.publication_status
      || run.status !== 'running' || !run.diagnostic?.can_interrupt || run.diagnostic.interrupt_requested_at
      || run.diagnostic.result_saved || this.runs().filter(r => r.task_id === taskId).at(-1)?.id !== runId) throw new Problem(409, 'Этот этап уже завершён, прерывается или недоступен.');
    run.diagnostic = { ...run.diagnostic, interrupt_requested_at: new Date().toISOString() };
    this.db.prepare('UPDATE runs SET diagnostic = ? WHERE id = ?').run(JSON.stringify(run.diagnostic), run.id);
    this.db.prepare('UPDATE tasks SET state_version = state_version + 1 WHERE id = ?').run(task.id);
    this.event('run.interrupt-requested', taskId, { run_id: run.id });
    return run;
  }
  retryRun(projectId: string, taskId: string, version: number) {
    const task = this.task(projectId, taskId);
    const previous = this.runs().filter(r => r.task_id === taskId).at(-1);
    if (task.state_version !== version || task.run_state !== 'interrupted' || task.publication_status || task.execution_unverified
      || !previous || previous.status !== 'failed' || !previous.diagnostic?.execution_finished || previous.stale
      || !previous.source_hash || !previous.base_sha || previous.description_revision !== task.revision) {
      throw new Problem(409, 'Повтор запрещён: требуется ручная проверка неизвестного исполнения, публикации или worktree.');
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version,
      status, branch, worktree, base_sha, parent_run_id, role, head_sha, source_hash, spec_run_id, round_id, stale, repair_round_id, repair_attempt)
      SELECT ?, task_id, project_id, description_revision, config, project_version, 'queued', branch, worktree, base_sha,
      id, role, head_sha, source_hash, spec_run_id, round_id, stale, repair_round_id, repair_attempt FROM runs WHERE id = ?`).run(id, previous.id);
    if (previous.diagnostic?.result_saved) this.db.prepare('UPDATE runs SET diagnostic = ? WHERE id = ?')
      .run(JSON.stringify({ result_run_id: previous.id }), id);
    this.db.prepare("UPDATE tasks SET stage = ?, run_state = 'queued', state_version = state_version + 1 WHERE id = ?")
      .run(previous.role.startsWith('review-') ? 'review' : previous.role, taskId);
    this.event('run.retried', taskId, { run_id: id, parent_run_id: previous.id });
    return this.specRun(projectId, taskId, id);
  }
  recordOutput(run: AgentRun, text: string) {
    if (this.blocked(run.task_id)) return;
    if (!text.trim()) return;
    this.db.transaction(() => {
      const current = this.specRun(run.project_id, run.task_id, run.id);
      if (current.status !== 'running') return;
      this.db.prepare(`INSERT INTO run_output VALUES (?, ?, ?, 1)
        ON CONFLICT(run_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at, version = version + 1`)
        .run(run.id, text, new Date().toISOString());
      this.event('run.output', run.task_id, { run_id: run.id });
    })();
  }
  output(runId: string) {
    return this.db.prepare('SELECT text, updated_at, version FROM run_output WHERE run_id = ?').get(runId) as { text: string; updated_at: string; version: number } | undefined;
  }
  runs(): AgentRun[] {
    return (this.db.prepare(`SELECT runs.*, substr(run_output.text, 1, 600) AS output_preview,
      run_output.updated_at AS output_at, run_output.version AS output_version
      FROM runs LEFT JOIN run_output ON run_output.run_id = runs.id ORDER BY runs.rowid`).all() as (Omit<AgentRun, 'config' | 'diagnostic'> & { config: string; diagnostic: string })[])
      .map(row => ({ ...row, config: JSON.parse(row.config), diagnostic: JSON.parse(row.diagnostic) }));
  }
  specRun(projectId: string, taskId: string, id: string) {
    this.task(projectId, taskId);
    return this.readRun(projectId, taskId, id);
  }
  readRun(projectId: string, taskId: string, id: string) {
    this.rawTask(projectId, taskId);
    const run = this.runs().find(run => run.id === id && run.task_id === taskId && run.project_id === projectId);
    if (!run) throw new Problem(404, 'Запуск не найден в этой задаче.');
    return run;
  }
  queueSpec(projectId: string, taskId: string, version: number, directory: string) {
    const task = this.task(projectId, taskId);
    if (task.state_version !== version || task.stage !== 'backlog' || task.run_state !== 'idle') throw new Problem(409, 'Задача изменилась или уже запущена.');
    const id = randomUUID();
    const run: AgentRun = { output_preview: null, output_at: null, output_version: null, diagnostic: {}, started_at: null, finished_at: null, repair_round_id: null, repair_attempt: 0, spec_run_id: null, round_id: null, stale: 0, role: 'spec', head_sha: null, source_hash: null, id, task_id: taskId, project_id: projectId, description_revision: task.revision,
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
    const run: AgentRun = { ...previous, output_preview: null, output_at: null, output_version: null, diagnostic: {}, started_at: null, finished_at: null, id: randomUUID(), parent_run_id: previous.id, spec_run_id: previous.id, role: 'build',
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
      const run: AgentRun = { ...previous, output_preview: null, output_at: null, output_version: null, diagnostic: {}, started_at: null, finished_at: null, id: randomUUID(), parent_run_id: previous.id,
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
  publicationRun(projectId: string, taskId: string) {
    const task = this.task(projectId, taskId);
    const run = this.runs().filter(r => r.task_id === taskId).at(-1);
    if (!run || run.role !== 'approve' || run.status !== 'completed' || run.stale
      || run.description_revision !== task.revision
      || !this.reviewPasses(run) || !(run.outcome === 'APPROVE' || (run.outcome === 'ESCALATE'
        && this.humanRequests().some(r => r.run_id === run.id && r.status === 'answered' && r.answers?.[0] === 'publish')))) {
      throw new Problem(409, 'Нужны четыре актуальных PASS и разрешение публикации этой версии.');
    }
    return run;
  }
  beginPublication(projectId: string, taskId: string, version: number) {
    return this.db.transaction(() => {
      const task = this.task(projectId, taskId);
      if (task.state_version !== version || task.stage !== 'approve' || task.run_state !== 'completed' || task.publication_status) {
        throw new Problem(409, 'Публикация недоступна или уже начата. При неизвестном исходе нужна ручная сверка GitHub.');
      }
      if (this.project(projectId).hosting !== 'github') throw new Problem(422, 'Публикация поддерживает GitHub.');
      const run = this.publicationRun(projectId, taskId);
      this.db.prepare("UPDATE tasks SET publication_status = 'pending', run_state = 'queued', state_version = state_version + 1 WHERE id = ?").run(taskId);
      this.event('publication.started', taskId, { run_id: run.id, head_sha: run.head_sha, source_hash: run.source_hash, branch: run.branch });
      return run;
    })();
  }
  finishPublication(run: AgentRun, identity?: { number: number; url: string }) {
    const saved = this.rawTask(run.project_id, run.task_id);
    if (saved.publication_status === 'confirmed' && !identity) return;
    this.db.transaction(() => {
      this.db.prepare("UPDATE tasks SET publication_status = ?, pr_number = ?, pr_url = ?, stage = ?, run_state = ?, state_version = state_version + 1 WHERE id = ?")
        .run(identity ? 'confirmed' : 'unknown', identity?.number ?? null, identity?.url ?? saved.pr_url,
          identity ? 'pr-created' : 'needs-human', identity ? 'completed' : 'interrupted', run.task_id);
      this.event(identity ? 'publication.confirmed' : 'publication.unknown', run.task_id,
        identity ?? { reason: 'Исход публикации не подтверждён. Проверьте GitHub и branch вручную; слепой повтор запрещён.' });
    })();
  }
  queueApprove(projectId: string, taskId: string, version: number) {
    return this.db.transaction(() => {
      const task = this.task(projectId, taskId);
      const previous = this.runs().filter(r => r.task_id === taskId).at(-1);
      if (task.state_version !== version || task.stage !== 'approve' || task.run_state !== 'idle'
        || !previous || previous.role !== 'review-ux' || !this.reviewPasses(previous)) throw new Problem(409, 'Нужны четыре актуальных PASS.');
      const run: AgentRun = { ...previous, output_preview: null, output_at: null, output_version: null, diagnostic: {}, started_at: null, finished_at: null, id: randomUUID(), parent_run_id: previous.id, role: 'approve', status: 'queued', outcome: null, error: null, report: 0 };
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
      const run: AgentRun = { ...previous, output_preview: null, output_at: null, output_version: null, diagnostic: {}, started_at: null, finished_at: null, id: randomUUID(), parent_run_id: previous.id, role: 'build', round_id: null,
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
      const run: AgentRun = { ...previous, output_preview: null, output_at: null, output_version: null, diagnostic: {}, started_at: null, finished_at: null, id: randomUUID(), parent_run_id: previous.id, role: 'build',
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
    if (this.blocked(run.task_id)) return;
    this.db.transaction(() => {
      this.db.prepare("UPDATE runs SET stale = 1 WHERE task_id = ? AND (role LIKE 'review-%' OR role = 'approve')").run(run.task_id);
      this.db.prepare("UPDATE tasks SET stage = 'needs-human', run_state = 'interrupted', state_version = state_version + 1 WHERE id = ? AND stage IN ('review','approve','needs-human') AND run_state IN ('idle','completed','waiting')").run(run.task_id);
      this.db.prepare("UPDATE human_requests SET status = 'revoked' WHERE task_id = ? AND role = 'approve' AND (status = 'pending' OR json_extract(answers, '$[0]') = 'publish')").run(run.task_id);
      this.event('review.stale', run.task_id, { run_id: run.id, reason: 'Git state или source изменён' });
    })();
  }
  applyRequirements(taskId: string) {
    if (this.blocked(taskId)) return;
    const messages = this.db.prepare("SELECT id, text FROM chat_messages WHERE task_id = ? AND kind = 'requirements' AND status = 'queued' ORDER BY rowid").all(taskId) as { id: string; text: string }[];
    if (!messages.length) return;
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task;
    const description = task.description + '\n\nУточнения требований:\n' + messages.map(m => m.text).join('\n\n');
    if (description.length > 100000) {
      this.db.prepare("UPDATE chat_messages SET status = 'failed', error = 'Описание превысит 100000 символов. Измените требования через редактор.' WHERE task_id = ? AND kind = 'requirements' AND status = 'queued'").run(taskId);
      this.event('chat.failed', taskId, {}); return;
    }
    // The current executor has finished; its worktree and reports remain in history.
    this.db.prepare("UPDATE tasks SET stage = 'build', run_state = 'idle' WHERE id = ?").run(taskId);
    this.db.prepare("UPDATE chat_messages SET status = 'applied' WHERE task_id = ? AND kind = 'requirements' AND status = 'queued'").run(taskId);
    this.editTask(task.project_id, taskId, description, task.state_version);
  }
  updateRun(run: AgentRun, stage: Task['stage'], state: Task['run_state'], title?: string, result?: SpecResult | BuildResult | ReviewResult | ApproveResult) {
    if (this.blocked(run.task_id)) return;
    this.db.transaction(() => {
      const task = this.task(run.project_id, run.task_id);
      const current = this.specRun(run.project_id, run.task_id, run.id);
      if (!['queued', 'running'].includes(current.status) || task.revision !== run.description_revision
        || !['queued', 'running'].includes(task.run_state)) throw new Problem(409, 'Результат запуска устарел.');
      const now = new Date().toISOString();
      run.started_at = current.started_at ?? (run.status === 'running' ? now : null);
      run.finished_at = ['completed', 'failed'].includes(run.status) ? now : null;
      run.diagnostic ??= {};
      if (run.diagnostic.error_kind === 'rate_limit') this.pauseExecution(run.diagnostic.reset_at ?? null);
      this.db.prepare('UPDATE runs SET diagnostic = ?, started_at = ?, finished_at = ? WHERE id = ?')
        .run(JSON.stringify(run.diagnostic), run.started_at, run.finished_at, run.id);
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
      if (run.status === 'completed') this.applyRequirements(run.task_id);
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
      const resuming = task.run_state === 'interrupted' && request.status === 'answered';
      if (task.state_version !== version || (request.status !== 'pending' && !resuming) || request.revision !== task.revision
        || task.publication_status || previous.stale
        || (task.run_state === 'interrupted' && (task.execution_unverified || !previous.diagnostic?.execution_finished))
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
      const run: AgentRun = { ...previous, output_preview: null, output_at: null, output_version: null, diagnostic: {}, started_at: null, finished_at: null, id: randomUUID(), parent_run_id: previous.id, status: 'queued', outcome: null, error: null, report: 0 };
      this.db.prepare(`INSERT INTO runs (id, task_id, project_id, description_revision, config, project_version,
      status, branch, worktree, base_sha, outcome, error, report, parent_run_id, role, head_sha, source_hash, spec_run_id, round_id, stale, repair_round_id, repair_attempt) VALUES (@id, @task_id, @project_id, @description_revision, @config, @project_version,
        @status, @branch, @worktree, @base_sha, @outcome, @error, @report, @parent_run_id, @role, @head_sha, @source_hash, @spec_run_id, @round_id, @stale, @repair_round_id, @repair_attempt)`).run({ ...run, config: JSON.stringify(run.config) });
      this.db.prepare("UPDATE tasks SET stage = ?, run_state = 'queued' WHERE id = ?").run(run.role.startsWith('review-') ? 'review' : run.role, taskId);
      this.event(`${run.role}.queued`, taskId, { run_id: run.id, parent_run_id: previous.id });
      return { run };
    })();
  }
  revisions(projectId: string, id: string): Revision[] {
    this.rawTask(projectId, id);
    return this.db.prepare('SELECT * FROM task_revisions WHERE task_id = ? ORDER BY revision').all(id) as Revision[];
  }
}
