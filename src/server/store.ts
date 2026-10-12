import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project, Task, Snapshot, SavedEvent, Revision } from '../shared.js';

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
      if (version !== 0 && version !== 1 && version !== 2) throw new Error('Версия базы новее приложения. Обновите приложение.');
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
        `);
        if (version !== 2) this.db.exec("ALTER TABLE tasks ADD COLUMN title_state TEXT NOT NULL DEFAULT 'interrupted'; PRAGMA user_version = 2;");
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
    if (task.stage !== 'backlog' || task.run_state !== 'idle') throw new Problem(409, 'Описание можно менять только до запуска задачи.');
    this.db.prepare("UPDATE tasks SET description = ?, title = NULL, title_state = 'pending', revision = revision + 1, state_version = state_version + 1 WHERE id = ?").run(description, id);
    this.db.prepare('INSERT INTO task_revisions(task_id, revision, description) VALUES (?, ?, ?)').run(id, task.revision + 1, description);
    this.event('task.edited', id, { revision: task.revision + 1 });
    return this.task(projectId, id);
  }
  claimTitle(activeIds: string[] = []): Task | undefined {
    return this.db.transaction(() => {
      const tasks = this.snapshot().tasks;
      const occupied = new Set([...activeIds, ...tasks.filter(task => task.title_state === 'running'
        || ['running', 'queued', 'waiting'].includes(task.run_state)).map(task => task.id)]);
      if (occupied.size >= 3) return;
      const task = tasks.find(task => task.title_state === 'pending' && task.stage === 'backlog'
        && task.run_state === 'idle' && !occupied.has(task.id));
      if (!task) return;
      this.db.prepare("UPDATE tasks SET title_state = 'running' WHERE id = ?").run(task.id);
      this.event('title.started', task.id, { revision: task.revision });
      return task;
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
  revisions(projectId: string, id: string): Revision[] {
    this.task(projectId, id);
    return this.db.prepare('SELECT * FROM task_revisions WHERE task_id = ? ORDER BY revision').all(id) as Revision[];
  }
}
