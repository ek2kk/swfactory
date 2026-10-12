import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { stages, type Project, type Task, type Snapshot, type Revision, roles, type Settings, type SpecRun } from '../shared.js';
import './style.css';

const pendingRequests = new Map<string, string>();
async function api<T>(path: string, method = 'GET', body?: Record<string, unknown>): Promise<T> {
  const key = JSON.stringify([method, path, body]);
  if (body && path !== '/session') {
    // Keep the same ID after a lost response so retry cannot duplicate a saved action.
    const id = pendingRequests.get(key) ?? crypto.randomUUID();
    pendingRequests.set(key, id);
    body = { ...body, request_id: id };
  }
  const response = await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  pendingRequests.delete(key);
  if (!response.ok) throw new Error(data.message ?? 'Backend недоступен. Проверьте терминал.');
  return data as T;
}
const labels = ['Backlog', 'Spec', 'Build', 'Review', 'Approve', 'PR/MR created', 'Needs human'];
const taskPath = (task: Task) => `/projects/${task.project_id}/tasks/${task.id}`;

function TaskCard({ task, project, runs, refresh }: { task: Task; project: Project; runs: SpecRun[]; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description);
  const [editVersion, setEditVersion] = useState(task.state_version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  return <article className="card">
    <span className="project-name">{project.repository}</span>
    <h3>{task.title ?? `Задача ${task.id.slice(0, 8)}`}</h3>
    <p className="meta">Редакция {task.revision} · {{ idle: task.stage === 'build' ? 'Spec готова · Build ещё не реализован' : 'Не запущена', queued: 'В очереди · ожидает слот', running: task.stage === 'spec' ? 'Codex готовит Spec' : 'Проверяем checkout и создаём worktree', waiting: 'Нужен ответ человека · продолжение в следующем срезе', interrupted: 'Прервана — нужна ручная проверка', completed: 'Завершена' }[task.run_state]}</p>
    {editing ? <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try {
        await api(taskPath(task), 'PATCH', { description: draft, state_version: editVersion });
        setEditing(false); setRevisions(null); await refresh();
      } catch (error) { setError((error as Error).message); }
      finally { setBusy(false); }
    }}>
      <label>Описание<textarea required maxLength={100000} value={draft} onChange={e => setDraft(e.target.value)} /></label>
      {task.state_version !== editVersion && <p role="status">Есть новая редакция. Ваш черновик сохранён в форме; скопируйте его перед загрузкой актуальной версии.</p>}
      <div className="actions"><button disabled={busy || !draft.trim() || task.state_version !== editVersion}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setDraft(task.description); setEditVersion(task.state_version); }}>Загрузить актуальную</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(false)}>Отмена</button></div>
    </form> : <><p className="description">{task.description}</p>{task.stage === 'backlog' && task.run_state === 'idle' && <button className="secondary" onClick={() => { setDraft(task.description); setEditVersion(task.state_version); setError(''); setEditing(true); }}>Редактировать</button>}</>}
    {!editing && task.stage === 'backlog' && task.run_state === 'idle' && <button disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await api(`${taskPath(task)}/start`, 'POST', { state_version: task.state_version }); await refresh(); }
      catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>{busy ? 'Ставим в очередь…' : 'Приступить к реализации'}</button>}
    {runs.map(run => <RunReport key={run.id} task={task} run={run} />)}
    <details onToggle={event => setShowHistory(event.currentTarget.open)}><summary>История описания</summary>
      {showHistory && <History task={task} revisions={revisions} setRevisions={setRevisions} />}
    </details>
    {error && <p role="alert" className="error">{error}</p>}
  </article>;
}
function History({ task, revisions, setRevisions }: { task: Task; revisions: Revision[] | null; setRevisions: (value: Revision[]) => void }) {
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Revision[]>(`${taskPath(task)}/revisions`).then(value => { if (active) setRevisions(value); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [task.id, task.revision, setRevisions]);
  return <>{error && <p role="alert">{error}</p>}{revisions ? revisions.map(r => <div key={r.revision}><p className="meta">Редакция {r.revision} · {new Date(r.created_at).toLocaleString('ru')}</p><pre>{r.description}</pre></div>) : <p role="status">Загружаем историю…</p>}</>;
}

function RunReport({ task, run }: { task: Task; run: SpecRun }) {
  const [report, setReport] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || !run.report) return;
    let active = true;
    api<{ text: string }>(`${taskPath(task)}/runs/${run.id}/report`)
      .then(value => { if (active) setReport(value.text); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [open, run.id, run.report, task.id]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Spec · {run.outcome ?? run.status} · {run.config.models.spec}</summary>
    <p className="meta">{run.base_sha && `Base: ${run.base_sha}`}<br />{run.worktree}</p>
    <p className="meta">Модели запуска: {roles.map(role => `${role}: ${run.config.models[role]}`).join(' · ')}</p>
    {run.error && <pre role="alert" className="error">{run.error}</pre>}
    {error && <p role="alert">{error}</p>}
    {!!run.report && <pre>{report || 'Загружаем сохранённый отчёт…'}</pre>}
  </details>;
}
function ModelSettings({ project, refresh }: { project: Project; refresh: () => Promise<void> }) {
  const [config, setConfig] = useState<Settings | null>(null);
  const [version, setVersion] = useState(project.state_version);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function reload() {
    setConfig(await api<Settings>(`/projects/${project.id}/settings`));
    setVersion(project.state_version);
  }
  useEffect(() => { reload().catch(error => setError(error.message)); }, [project.id]);
  return <details><summary>Модели и инструкции · {project.repository}</summary>
    {config && <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { await api(`/projects/${project.id}/settings`, 'PUT', { ...config, state_version: version }); setVersion(version + 1); await refresh(); }
      catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>
      <div className="fields">{roles.map(role => <label key={role}>{role}<input required maxLength={128} value={config.models[role]} onChange={event => setConfig({ ...config, models: { ...config.models, [role]: event.target.value } })} /></label>)}</div>
      <label>Инструкции проекта<textarea maxLength={30000} value={config.instructions} onChange={event => setConfig({ ...config, instructions: event.target.value })} /></label>
      <p className="hint">Укажите доступные вашему Codex модели. Конфигурация фиксируется при старте задачи; недоступная модель останавливает запуск без подмены.</p>
      {project.state_version !== version && <p role="status">Настройки изменились. Загрузите актуальную версию перед сохранением.</p>}
      <button disabled={busy || project.state_version !== version}>Сохранить настройки</button>{' '}
      <button type="button" className="secondary" disabled={busy} onClick={() => reload().catch(error => setError(error.message))}>Загрузить актуальные</button>
    </form>}{error && <p role="alert" className="error">{error}</p>}
  </details>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ projects: [], tasks: [], runs: [], cursor: 0 });
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState('Подключаемся к backend…');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [projectId, setProjectId] = useState('');
  const [filter, setFilter] = useState('');
  const [description, setDescription] = useState('');
  async function refresh() { setSnapshot(await api<Snapshot>('/snapshot')); }
  useEffect(() => {
    let events: EventSource | undefined, disposed = false;
    (async () => {
      const token = new URLSearchParams(location.hash.slice(1)).get('token');
      if (token) {
        history.replaceState(null, '', location.pathname);
        await api('/session', 'POST', { token });
      }
      const initial = await api<Snapshot>('/snapshot');
      if (disposed) return;
      setSnapshot(initial); setReady(true);
      events = new EventSource('/api/events');
      events.addEventListener('snapshot', event => { setSnapshot(JSON.parse((event as MessageEvent).data)); setConnection('Сохранено локально · Соединение активно'); });
      events.onerror = () => setConnection('Связь потеряна. Переподключаемся; сохранённые данные остаются на backend. Если backend перезапущен, откройте новый URL из терминала.');
    })().catch(error => { if (!disposed) { setError(error.message); setConnection('Подключение не выполнено'); } });
    return () => { disposed = true; events?.close(); };
  }, []);
  const selected = snapshot.projects.find(p => p.id === projectId) ?? snapshot.projects[0];
  return <main>
    <header><div><p className="eyebrow">LOCAL WORKSPACE</p><h1>SW Factory</h1></div><p className="connection" role="status">{connection}</p></header>
    <p className="intro">Из описания — в проверяемую спецификацию. Codex работает в отдельном worktree; закрытие вкладки не останавливает задачу.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {snapshot.execution_error && <p role="alert" className="error">{snapshot.execution_error}</p>}
    <div className="setup">
      <section aria-labelledby="connect-title"><h2 id="connect-title">Подключить проект</h2>
        <form onSubmit={async event => {
          event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form);
          setBusy('project'); setError('');
          try {
            const project = await api<Project>('/projects', 'POST', { ...Object.fromEntries(fields), state_version: 0 });
            await refresh(); setProjectId(project.id); form.reset();
          } catch (error) { setError((error as Error).message); } finally { setBusy(''); }
        }}>
          <label>Checkout<input name="checkout" required placeholder="/Users/you/projects/repository" /></label>
          <div className="fields"><label>Remote<input name="remote" required defaultValue="origin" /></label>
          <label>Целевая ветка<input name="target_branch" required defaultValue="main" /></label>
          <label>Hosting<select name="hosting"><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></label></div>
          <button disabled={!ready || !!busy}>{busy === 'project' ? 'Проверяем Git и CLI…' : 'Подключить'}</button>
          <p className="hint">Проверим локальный remote, известную target branch и CLI auth. Checkout останется без изменений.</p>
        </form>
      </section>
      <section aria-labelledby="create-title"><h2 id="create-title">Новая задача</h2>
        <form onSubmit={async event => {
          event.preventDefault(); if (!selected) return; setBusy('task'); setError('');
          try { await api(`/projects/${selected.id}/tasks`, 'POST', { state_version: selected.state_version, description }); setDescription(''); await refresh(); }
          catch (error) { setError((error as Error).message); } finally { setBusy(''); }
        }}>
          <label>Проект<select value={selected?.id ?? ''} onChange={event => setProjectId(event.target.value)} disabled={!snapshot.projects.length}>
            {!snapshot.projects.length && <option value="">Сначала подключите проект</option>}
            {snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.repository} · {p.target_branch}</option>)}
          </select></label>
          <label>Описание<textarea required maxLength={100000} value={description} onChange={event => setDescription(event.target.value)} placeholder="Что нужно сделать?" /></label>
          <button disabled={!ready || !selected || !description.trim() || !!busy}>{busy === 'task' ? 'Сохраняем…' : 'Добавить в Backlog'}</button>
        </form>
      </section>
    </div>
    {!!snapshot.projects.length && <details className="projects"><summary>Подключённые проекты ({snapshot.projects.length})</summary>{snapshot.projects.map(p => <div key={p.id}><strong>{p.repository}</strong><p>{p.checkout}</p><p>{p.hosting} · {p.remote} → {p.remote_url} · target: {p.target_branch}</p></div>)}</details>}
    <section className="projects" aria-label="Настройки моделей">{snapshot.projects.map(project => <ModelSettings key={project.id} project={project} refresh={refresh} />)}</section>
    <div className="board-heading"><h2>Доска <span>{snapshot.tasks.length}</span></h2><label>Проект <select value={filter} onChange={event => setFilter(event.target.value)}><option value="">Все проекты</option>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.repository}</option>)}</select></label></div>
    <div className="board" tabIndex={0} role="region" aria-label="Kanban, горизонтальная прокрутка">
      {stages.map((stage, index) => {
        const tasks = snapshot.tasks.filter(t => t.stage === stage && (!filter || t.project_id === filter));
        return <section key={stage} className={`column ${stage === 'needs-human' ? 'human' : ''}`} aria-label={labels[index]}><h2>{labels[index]} <span>{tasks.length}</span></h2>
          {tasks.length ? tasks.map(task => <TaskCard key={task.id} task={task} runs={snapshot.runs.filter(run => run.task_id === task.id)} project={snapshot.projects.find(p => p.id === task.project_id)!} refresh={refresh} />) : <p className="empty">{stage === 'backlog' ? 'Добавьте первую задачу' : 'Пока нет задач'}</p>}
        </section>;
      })}
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
