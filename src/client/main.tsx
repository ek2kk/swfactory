import { TaskStatistics, RunStatistics, StatisticsWindow } from './statistics.js';
import { ModelPicker, ReasoningPicker } from './models.js';
import { api } from './api.js';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { publicationBlocksLocal, dependencyActionBlocker, resultsResetBlocker, stages, type Project, type Task, type Snapshot, type Revision, type SavedEvent, roles, allRoles, requiredReviews, type ReviewRole, type Settings, type AgentRun, type HumanRequest, type ChatMessage } from '../shared.js';
import './style.css';
import { Composer, Message, RunConversation } from './chat.js';
import { AgentOutput, RunProgress } from './output.js';
import { applyTheme, readTheme, type Theme } from './theme.js';
import { reviewSummary, stageRoles, stageNames, stageTabStatus } from './stageHistory.js';
import { TaskView, type DescriptionDraft } from './taskView.js';
import { TaskMarkdown } from './TaskMarkdown.js';
import { Modal, Toast, ActionIcon, type Notice } from './windows.js';
import type { ResultsResetPlan } from '../resultsReset.js';

applyTheme(readTheme());

const labels = ['Backlog', 'Spec', 'Build', 'Review', 'Approve', 'PR/MR created', 'Needs human'];
const taskPath = (task: Task) => `/projects/${task.project_id}/tasks/${task.id}`;

function SourceIssue({ task }: { task: Task }) {
  return task.issue_url && <p className="meta"><a href={task.issue_url} target="_blank" rel="noreferrer">GitHub issue #{task.issue_number}</a></p>;
}

function TaskResultsReset({ task, refresh, notify, role, hasResults = !!task.has_results }: { task: Task; refresh: () => Promise<void>; notify: (text: string, key?: string) => void; role?: AgentRun['role']; hasResults?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [version, setVersion] = useState(task.state_version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<ResultsResetPlan | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const blocker = resultsResetBlocker(task);
  useEffect(() => {
    if (!confirming || !dialog.current) return;
    const element = dialog.current;
    element.showModal(); cancelButton.current?.focus();
    return () => element.close();
  }, [confirming]);
  function close() { dialog.current?.close(); setConfirming(false); resetButton.current?.focus(); }
  return <section className="results-reset" aria-label="Сброс результатов">
    {!!(role || task.has_results || task.reset_pending) && <>
      <button ref={resetButton} className="secondary" disabled={busy || !!blocker || !!role && !hasResults} aria-describedby={`reset-hint-${task.id}-${role ?? 'all'}`} onClick={async () => {
        setBusy(true); setError('');
        try {
          const value = await api<ResultsResetPlan>(`${taskPath(task)}/reset-results/${role ?? 'spec'}`);
          setPlan(value); setVersion(value.state_version); setConfirming(true);
        } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      }}>{task.reset_pending ? 'Повторить очистку результатов' : role ? 'Сбросить результаты этапа' : 'Сбросить все результаты'}</button>
      <p id={`reset-hint-${task.id}-${role ?? 'all'}`} className="hint">{blocker ?? (task.reset_pending ? 'Очистка не завершена. Новые действия заблокированы до её завершения.' : role && !hasResults ? 'У этапа пока нет результатов для сброса.' : 'Требования и Git-результаты сохранятся. Новый запуск — отдельным действием.')}</p>
    </>}
    {!!task.archived && !task.has_results && <p className="hint">{blocker}</p>}
    {(task.reset_error || error && !confirming) && <p role="alert">{task.reset_error ?? error}</p>}
    {confirming && <dialog ref={dialog} className="delete-confirmation" aria-labelledby={`reset-title-${task.id}-${role ?? 'all'}`} onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
      <h4 id={`reset-title-${task.id}-${role ?? 'all'}`}>{role ? `Сбросить ${stageNames[role]} и зависимые результаты?` : 'Сбросить все результаты?'}</h4>
      <p>Выбранный этап: {stageNames[plan?.role ?? 'spec']}. Будут удалены следующие runs и их зависимые результаты:</p>
      <ul>{plan?.runs.map(run => <li key={run.id}>{stageNames[run.role]} · {run.id}</li>)}</ul>
      <p>Удаляются их отчёты, логи, управляемые файлы, sessions, чат, вопросы, ответы человека и зависимые решения/reuse PASS. Пригодные независимые результаты сохранятся.</p>
      <p>ID карточки, проект, название, исходный Markdown, revision и история требований, GitHub issue и настройки проекта сохранятся. Уже применённые из чата требования останутся в описании.</p>
      <p>Основной checkout, Git worktrees, branches и опубликованные PR сохранятся. Подтверждённый PR останется в истории сбросов. Новый цикл может создать отдельный PR; remote операции при сбросе не выполняются.</p>
      <p>{plan?.restart.reason} Агент не запустится автоматически. «Запустить заново» создаст новый run и session context.</p>
      {(!!blocker || version !== task.state_version) && <p role="status">{blocker ?? 'Карточка изменилась. Отмените подтверждение и откройте его снова.'}</p>}
      <div className="actions"><button disabled={busy || !!blocker || version !== task.state_version} onClick={async () => {
        setBusy(true); setError('');
        try {
          await api(`${taskPath(task)}/reset-results`, 'POST', { state_version: version, ...(role ? { stage: role } : {}) });
          close();
          await refresh();
        } catch (error) { setError((error as Error).message); await refresh().catch(() => {}); }
        finally { setBusy(false); }
      }}>{busy ? 'Очищаем…' : task.reset_pending ? 'Повторить очистку' : 'Подтвердить сброс'}</button>
        <button ref={cancelButton} className="secondary" disabled={busy} onClick={close}>Отмена</button></div>
      {error && <p role="alert">{error}</p>}
    </dialog>}
    {!role && <ResetHistory task={task} />}
  </section>;
}

function TaskResultsRestart({ task, refresh, executionPaused }: { task: Task; refresh: () => Promise<void>; executionPaused: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!task.results_restart || task.run_state !== 'idle') return null;
  const blocker = resultsResetBlocker(task) ?? (executionPaused ? 'Исполнение глобально приостановлено.' : null);
  return <section aria-label="Новый запуск после сброса"><p role="status">{task.results_restart.reason}</p>
    <button disabled={busy || !!blocker || !!task.reset_pending} onClick={async () => {
      setBusy(true); setError('');
      try { await api(`${taskPath(task)}/restart-results`, 'POST', { state_version: task.state_version }); await refresh(); }
      catch (error) { setError((error as Error).message); await refresh().catch(() => {}); } finally { setBusy(false); }
    }}>{busy ? 'Ставим в очередь…' : `Запустить заново · ${stageNames[task.results_restart.role]}`}</button>
    {blocker && <p role="status">{blocker}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}

function ResetHistory({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const [resets, setResets] = useState<SavedEvent[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    api<{ resets: SavedEvent[] }>(`${taskPath(task)}/history`).then(value => {
      if (!disposed) { setResets(value.resets); setError(''); }
    }).catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; };
  }, [open, task.id, task.state_version]);
  return <details onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}><summary>История сбросов и прежние PR</summary>
    {open && <>{error && <p role="alert">{error}</p>}{resets === null ? <p role="status">Загружаем…</p> : !resets.length ? <p>Сбросов ещё не было.</p> : resets.map(event => {
      const reset = JSON.parse(event.payload) as { removed_runs: number; previous_pr: { number: number | null; url: string | null; host: string; repository: string } | null };
      return <div key={event.id}><p>{new Date(event.created_at).toLocaleString('ru')} · Результаты сброшены · runs: {reset.removed_runs}</p>
        {reset.previous_pr && <p>Внешний результат сохранён: {reset.previous_pr.url ? <a href={reset.previous_pr.url} target="_blank" rel="noreferrer">PR #{reset.previous_pr.number} · {reset.previous_pr.host}/{reset.previous_pr.repository}</a> : `PR #${reset.previous_pr.number} · ${reset.previous_pr.host}/${reset.previous_pr.repository}`}.</p>}</div>;
    })}</>}
  </details>;
}

function TaskDisposition({ task, refresh, notify }: { task: Task; refresh: () => Promise<void>; notify: (text: string, key?: string) => void }) {
  const [verification, setVerification] = useState<{ processes: { state: string; pgid: number }[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [version, setVersion] = useState(task.state_version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const stopping = busy || task.deletion_state === 'stopping';
  const warning = task.execution_warning ?? task.deletion_error;
  useEffect(() => {
    let disposed = false;
    api<{ verification: NonNullable<typeof verification> }>(`${taskPath(task)}/deletion`).then(result => { if (!disposed) setVerification(result.verification); }).catch(() => {});
    return () => { disposed = true; };
  }, [task]);
  useEffect(() => {
    const element = dialog.current;
    if (!confirming || !element) return;
    element.showModal(); cancelButton.current?.focus();
    return () => element.close();
  }, [confirming]);
  function close() { dialog.current?.close(); setConfirming(false); }
  const live = new Set(verification?.processes.filter(row => row.state === 'running').map(row => row.pgid)).size;
  const unknown = new Set(verification?.processes.filter(row => row.state === 'unknown').map(row => row.pgid)).size;
  return <section aria-label="Остановка и архивирование">
    {task.archive_source === 'github-filter' && <p role="status">{task.archived ? `Автоматический архив: ${task.archive_reason}` : 'Соответствие фильтру GitHub восстановлено. Новый запуск — отдельным действием.'}</p>}
    {stopping && <p role="status">Останавливаем… {task.archived ? 'Карточка останется в архиве.' : 'Карточка вернётся в Backlog не позднее чем через 5 секунд.'} Результаты сохранятся.</p>}
    {warning && <p role="alert">{warning}</p>}
    {!!task.legacy_execution_unknown && !warning && <p role="status">Диагностика прежнего исполнения неполна. Его завершение неизвестно; после Stop доступен изолированный новый запуск.</p>}
    {live > 0 && <p role="status">Продолжают работать группы процессов: {live}. Они занимают место в очереди до завершения.</p>}
    {unknown > 0 && <p role="status">Не удалось подтвердить состояние групп процессов: {unknown}.</p>}
    {!!task.execution_generation && !stopping && !warning && !task.stop_unverified && !task.execution_unverified && !live && !unknown && (task.archived || (task.stage === 'backlog' && task.run_state === 'idle')) && <p role="status">Известное исполнение завершено. {task.archived ? 'Карточка остаётся в архиве.' : 'Карточка в Backlog; новый запуск — отдельным действием.'}</p>}
    {(task.publication_status === 'unknown' || task.publication_status === 'pending') && <p role="alert">Результат публикации не подтверждён. Повтор публикации запрещён до сверки GitHub; изолированный локальный запуск доступен после остановки.</p>}
    <div className="actions"><button className="secondary" aria-disabled={stopping || !!task.reset_pending} aria-busy={stopping} disabled={!!task.reset_pending} onClick={async () => {
      if (stopping || task.reset_pending) return;
      setBusy(true); setError('');
      try {
        const result = await api<{ archived: boolean; deleted: boolean; error: string | null; warning: string | null }>(`${taskPath(task)}/stop`, 'POST', { state_version: task.state_version });
        notify(`${result.archived ? 'Карточка остаётся в архиве.' : 'Карточка возвращена в Backlog.'} ${result.error ?? 'Известное исполнение завершено.'}${result.warning ? ' ' + result.warning : ''}`);
        await refresh();
      } catch (error) { setError((error as Error).message); await refresh().catch(() => {}); }
      finally { setBusy(false); }
    }}>{stopping ? 'Останавливаем…' : warning || live || unknown ? 'Повторить остановку' : 'Остановить'}</button>
    {(!task.archived || task.archive_source === 'github-filter') && <button className="secondary archive-button" aria-label="Архивировать" disabled={busy || !!task.reset_pending} onClick={() => { setVersion(task.state_version); setConfirming(true); setError(''); }}>Архивировать</button>}</div>
    {verification && <details><summary>Технические подробности исполнения</summary><pre>{JSON.stringify(verification, null, 2)}</pre></details>}
    {confirming && <dialog ref={dialog} onCancel={event => { event.preventDefault(); if (!busy) close(); }} aria-labelledby={`archive-title-${task.id}`} className="delete-confirmation">
      <h4 id={`archive-title-${task.id}`}>Архивировать «{task.title ?? task.description}»?</h4>
      <p>Карточка будет скрыта с доски. Известное исполнение будет остановлено; результаты, worktrees и PR сохранятся. Уже отправленная публикация могла завершиться. Ручной архив автоматически не восстанавливается.</p>
      <button disabled={busy || version !== task.state_version} onClick={async () => {
        setBusy(true); setError('');
        try {
          const archived = await api<Task>(`${taskPath(task)}/archive`, 'POST', { state_version: version });
          close(); notify('Карточка архивирована. История и результат остановки доступны в архиве.', `archive:${task.id}:${archived.state_version}`); await refresh();
        } catch (error) { setError((error as Error).message); await refresh().catch(() => {}); }
        finally { setBusy(false); }
      }}>{busy ? 'Архивируем…' : 'Подтвердить архивирование'}</button>{' '}
      <button ref={cancelButton} className="secondary" disabled={busy} onClick={close}>Отмена</button>
      {version !== task.state_version && <p role="status">Карточка изменилась. Откройте подтверждение снова.</p>}
      {error && <p role="alert">{error}</p>}
    </dialog>}
    {!confirming && error && <p role="alert">{error}</p>}
  </section>;
}

function ArchivedTask({ task, refresh, notify, expanded = false, draft, openTask }: { task: Task; refresh: () => Promise<void>; notify: (text: string, key?: string) => void; expanded?: boolean; draft?: DescriptionDraft; openTask?: (id: string) => void }) {
  const [open, setOpen] = useState(expanded);
  const [history, setHistory] = useState<{ revisions: Revision[]; messages: ChatMessage[]; runs: AgentRun[] } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(open);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setLoading(true);
    api<NonNullable<typeof history>>(`${taskPath(task)}/history`).then(value => {
      if (!disposed) { setHistory(value); setError(''); setLoading(false); }
    }).catch(error => { if (!disposed) { setError(error.message); setLoading(false); } });
    return () => { disposed = true; };
  }, [open, task.id, task.state_version]);
  return <details open={open} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary data-task-heading>{task.title ?? task.id} · {task.deletion_state === 'deleted' && !task.stop_unverified && !task.execution_unverified ? 'известное исполнение завершено' : task.deletion_state === 'stopping' ? 'остановка выполняется' : 'остановка не подтверждена'}</summary>
    {open && <>
      <TaskMarkdown>{task.description}</TaskMarkdown>
      {draft && <label>Несохранённый черновик описания — можно скопировать<textarea readOnly value={draft.description} /></label>}
      <SourceIssue task={task} />
      {task.publication_status === 'unknown' || task.publication_status === 'pending' ? <p role="alert">Remote операция могла завершиться. Проверьте hosting; автоматического повтора публикации нет.</p> : null}
      {task.pr_url && <a href={task.pr_url} target="_blank" rel="noreferrer">Существующий PR</a>}
      {openTask ? <>
        {task.archive_source === 'github-filter' && <p role="status">Автоматический архив: {task.archive_reason}</p>}
        {task.deletion_error && <p role="alert">{task.deletion_error}</p>}
        <button id={`open-${task.id}`} onClick={() => openTask(task.id)}>Открыть задачу / остановить ↗</button>
      </> : <><TaskDisposition task={task} refresh={refresh} notify={notify} /><TaskResultsReset task={task} refresh={refresh} notify={notify} /></>}
      {loading && <p role="status">Загружаем историю…</p>}
      {error && <p role="alert">{error}</p>}
      {history && <>
        <details><summary>История описания</summary>{history.revisions.map(revision => <div key={revision.revision}><p>Версия требований: {revision.revision}</p><TaskMarkdown>{revision.description}</TaskMarkdown></div>)}</details>
        {history.messages.map(message => <Message key={message.id} message={message} />)}
        {history.runs.map(run => <RunReport key={run.id} task={task} run={run} />)}
      </>}
    </>}
  </details>;
}

function TaskCard({ task, project, runs, questions, refresh, active, cursor, notify, draft, setDraft, executionPaused = false }: { executionPaused?: boolean; task: Task; project: Project; runs: AgentRun[]; questions: HumanRequest[]; refresh: () => Promise<void>; active: boolean; cursor: number; notify: (text: string, key?: string) => void; draft?: DescriptionDraft; setDraft: (draft: DescriptionDraft | null) => void }) {
  const [specMode, setSpecMode] = useState<'auto' | 'spec' | 'skip'>('auto');
  const decision = task.spec_decision?.revision === task.revision && !runs.at(-1)?.revoked ? task.spec_decision : null;
  const [editing, setEditing] = useState(!!draft);
  const requirementsButton = useRef<HTMLButtonElement>(null);
  const requirementsInput = useRef<HTMLTextAreaElement>(null);
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (!wasEditing.current && editing) requirementsInput.current?.focus();
    if (wasEditing.current && !editing) requirementsButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const canReplace = (['backlog', 'build'].includes(task.stage) && task.run_state === 'idle') || (task.stage === 'needs-human' && task.run_state === 'waiting');
  const replacement = useRef(draft?.kind ? task.description : draft?.description ?? task.description);
  const clarification = useRef(draft?.kind ? draft.description : '');
  const [requirementsError, setRequirementsError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const latest = runs.at(-1);
  const reviews = reviewSummary(runs, task.revision);
  const blockingReviews = reviews?.blockers.filter(entry => entry.current && entry.run?.status === 'completed' && entry.run.outcome === 'CHANGES') ?? [];
  const report = (run: AgentRun, preview = false) => <RunReport task={task} run={run} preview={preview}
    historical={run.role.startsWith('review-') && !reviews?.entries.some(entry => entry.current && entry.run?.id === run.id)} />;
  const taskRoles = stageRoles(runs);
  const [tab, setTab] = useState<string>('overview');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatError, setChatError] = useState('');
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    api<ChatMessage[]>(`${taskPath(task)}/messages`).then(value => { if (!disposed) { setMessages(value); setChatError(''); } }).catch(error => { if (!disposed) setChatError(error.message); });
    return () => { disposed = true; };
  }, [active, task.id, cursor]);
  return <article className="card">
    <span className="project-name">{project.host}/{project.repository} · {project.checkout}</span>
    <h3 data-task-heading tabIndex={-1}>{task.title ?? `Задача ${task.id.slice(0, 8)}`}</h3>
    <SourceIssue task={task} />
    <div className="actions card-actions"><TaskDisposition task={task} refresh={refresh} notify={notify} /></div>
    <TaskResultsReset task={task} refresh={refresh} notify={notify} />
    <fieldset className="task-controls" disabled={!!(task.deletion_state || task.reset_pending)}>
    <section className="task-description" aria-label="Требования задачи">
    {editing && draft ? <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setRequirementsError('');
      try {
        if (draft.kind === 'requirements') {
          await api(`${taskPath(task)}/messages`, 'POST', { text: draft.description, kind: 'requirements', state_version: draft.version });
        } else {
          await api(taskPath(task), 'PATCH', { description: draft.description, state_version: draft.version });
        }
        setDraft(null); setEditing(false); setRevisions(null); await refresh();
      } catch (error) { setRequirementsError((error as Error).message); }
      finally { setBusy(false); }
    }}>
      <p className="hint">Сохранение обновит описание и его версию, отзовёт открытые вопросы и сделает прежние проверки неактуальными. Новую Spec нужно запустить явно. История и отчёты сохранятся.</p>
      <div className="actions requirements-modes">
        {canReplace && <button type="button" className="secondary" aria-pressed={!draft.kind} disabled={busy} onClick={() => setDraft({ description: replacement.current, version: draft.version })}>Заменить описание</button>}
        <button type="button" className="secondary" aria-pressed={draft.kind === 'requirements'} disabled={busy} onClick={() => setDraft({ description: clarification.current, version: draft.version, kind: 'requirements' })}>Добавить уточнения</button>
      </div>
      {draft.kind === 'requirements' && <p className="hint">{['queued', 'running'].includes(task.run_state) ? 'Уточнения ожидают применения после текущего этапа. До применения описание и версия требований остаются прежними.' : 'Уточнения добавятся к существующему описанию.'}</p>}
      <label>{draft.kind === 'requirements' ? 'Уточнения требований' : 'Описание'}<textarea ref={requirementsInput} aria-label={draft.kind === 'requirements' ? 'Уточнения требований' : 'Описание'} required maxLength={draft.kind === 'requirements' ? 4096 : 100000} value={draft.description} onChange={e => { (draft.kind === 'requirements' ? clarification : replacement).current = e.target.value; setDraft({ ...draft, description: e.target.value }); }} /></label>
      {task.state_version !== draft.version && <p role="status">Карточка изменилась. Ваш черновик сохранён. Проверьте актуальное состояние перед повторным сохранением.</p>}
      <div className="actions"><button disabled={busy || !draft.description.trim() || task.state_version !== draft.version || (!draft.kind && !canReplace)}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setDraft({ ...draft, version: task.state_version })}>Использовать актуальное состояние</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(false)}>Отмена</button></div>
      {requirementsError && <p role="alert" className="error">{requirementsError}</p>}
    </form> : <><TaskMarkdown>{task.description}</TaskMarkdown>{!publicationBlocksLocal(task) && task.run_state !== 'interrupted' && <button ref={requirementsButton} className="secondary" onClick={() => {
      if (!draft) {
        replacement.current = task.description; clarification.current = '';
        setDraft({ description: canReplace ? task.description : '', version: task.state_version, ...(canReplace ? {} : { kind: 'requirements' as const }) });
      }
      setEditing(true); setRequirementsError('');
    }}>Изменить требования</button>}</>}
    </section>
    {messages.filter(message => message.kind === 'requirements' && ['queued', 'failed'].includes(message.status)).map(message => <p key={message.id} role={message.status === 'failed' ? 'alert' : 'status'}>{message.status === 'queued' ? 'Изменение требований ожидает применения после текущего этапа.' : `Изменение требований не применено: ${message.error ?? 'Ошибка сохранения'}`}</p>)}
    <DependencyStatus task={task} runs={runs} refresh={refresh} executionPaused={executionPaused} />
    <div className="current-activity">
    {!latest?.revoked && latest?.description_revision === task.revision && latest.error && <p role="alert" className="error">{latest.error}</p>}
    {!latest?.revoked && latest?.description_revision === task.revision && <RunProgress run={latest} busy={busy}
      onInterrupt={latest.status === 'running' && latest.diagnostic?.can_interrupt && !latest.diagnostic.result_saved && !publicationBlocksLocal(task) ? async () => {
        setBusy(true); setError('');
        try { await api(`${taskPath(task)}/runs/${latest.id}/interrupt`, 'POST', { state_version: task.state_version }); await refresh(); }
        catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      } : undefined} />}
    {!latest?.revoked && latest?.description_revision === task.revision ? <AgentOutput key={latest.id} run={latest} load={() => api(`${taskPath(task)}/runs/${latest.id}/output`)} /> : <p className="hint">Сообщений агента пока нет.</p>}
    </div>
    <div className="task-tabs" role="tablist" aria-label="Этапы задачи" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')];
      const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault(); tabs[next].click(); tabs[next].focus();
    }}>
      <div className="overview-control"><button id={`${task.id}-tab-overview`} role="tab" aria-selected={tab === 'overview'} aria-controls={`${task.id}-panel-overview`} tabIndex={tab === 'overview' ? 0 : -1} className="secondary" onClick={() => setTab('overview')}>Обзор{questions.some(q => q.status === 'pending') ? ' · нужен ответ' : ''}</button></div>
      <div className="stage-tabs">{taskRoles.map(role => {
        const status = role === 'spec' && decision?.required === false
          ? { state: 'idle', icon: '−', label: decision.mode === 'skip' ? 'Пропущена пользователем' : 'Не требуется' }
          : stageTabStatus(role, runs, task.revision, questions);
        return <button key={role} id={`${task.id}-tab-${role}`} role="tab" aria-selected={tab === role} aria-label={`${stageNames[role]}: ${status.label}`} title={latest?.review_plan?.checks.find(c => c.role === role)?.reason ?? status.label} aria-controls={`${task.id}-panel-${role}`} tabIndex={tab === role ? 0 : -1} className={`stage-tab status-${status.state}`} onClick={() => setTab(role)}><span aria-hidden="true">{status.icon}</span> {stageNames[role]}</button>;
      })}</div>
    </div>
    <div role="tabpanel" id={`${task.id}-panel-overview`} aria-labelledby={`${task.id}-tab-overview`} hidden={tab !== 'overview'} tabIndex={0}>
    <TaskStatistics runs={runs} active={active && tab === 'overview'} />
    <TaskResultsRestart task={task} refresh={refresh} executionPaused={executionPaused} />
    {reviews && <section className="review-summary" aria-label="Результаты текущего Review">
      <h4>Текущий раунд Review</h4>
      <p className="meta">Раунд: {reviews.round} · HEAD: {latest?.head_sha ?? 'неизвестен'} · Версия требований: {task.revision}</p>
      <ul>{reviews.entries.map(entry => <li key={entry.role}>
        <strong>{stageNames[entry.role]}</strong>: {!entry.required ? 'Не требуется' : !entry.run ? 'Ещё не запускался'
          : !entry.current ? `${entry.run.outcome ?? entry.run.status} · Неактуальный результат, не учитывается`
          : entry.reused ? 'Предыдущий PASS применим по плану Review'
          : `${entry.run.outcome ?? entry.run.status} · текущий результат`}
      </li>)}</ul>
      {!reviews.passed && ['review', 'needs-human', 'approve'].includes(task.stage) && <p role="status">Approve не запущен: {reviews.blockers.length ? reviews.blockers.map(entry =>
        `${stageNames[entry.role].replace(' · ', ' ')} ${entry.current && entry.run?.status === 'completed' && entry.run.outcome === 'CHANGES' ? 'требует доработок' : 'не имеет актуального PASS'}`).join('; ') : 'версия реализации или план Review неактуальны'}.</p>}
      {reviews.passed && <p role="status">Все обязательные Review имеют актуальный PASS. Лимит доработок не препятствует Approve.</p>}
      {blockingReviews.map(entry => <div key={entry.run!.id}><p><strong>{stageNames[entry.role]} — замечание</strong></p>{report(entry.run!, true)}</div>)}
    </section>}
    {!latest?.revoked && latest?.review_plan && <div aria-label="План Review">{latest.review_plan.checks.map(check => <p key={check.role} className="meta">{stageNames[check.role]}: {check.reuse_run_id ? 'Предыдущий PASS применим' : check.required ? 'Обязателен' : 'Не требуется'} — {check.reason}</p>)}</div>}
    {task.publication_status === 'pending' && <p role="status">Публикуем GitHub PR… Повторный запуск заблокирован.</p>}
    {task.publication_status === 'unknown' && <p role="alert">Исход публикации неизвестен. Нужна ручная сверка GitHub и source branch из отчёта (task marker: {task.id}). Слепой повтор запрещён; worktree сохранён.</p>}
    {task.publication_status === 'confirmed' && task.pr_url && <p><a href={task.pr_url} target="_blank" rel="noreferrer">GitHub PR #{task.pr_number}</a> · CI не проверен; merge выполняется на GitHub.</p>}
    {task.stage === 'approve' && task.run_state === 'completed' && !task.publication_status && project.hosting === 'github' && <button disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await api(`${taskPath(task)}/publish`, 'POST', { state_version: task.state_version }); await refresh(); }
      catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>{busy ? 'Запускаем публикацию…' : 'Опубликовать GitHub PR'}</button>}
    {!task.title && <p role="status" className="meta">{task.title_state === 'pending' ? 'Заголовок ожидает свободного слота…'
      : task.title_state === 'running' ? 'Codex формирует заголовок…'
      : task.title_state === 'interrupted' ? 'Генерация заголовка прервана. Описание сохранено; заголовок можно получить в Spec.'
      : 'Не удалось получить заголовок. Описание сохранено; проверьте Codex CLI. Заголовок можно получить в Spec.'}</p>}
    {decision && <p role="status">Spec: {decision.required === null ? 'Оценка требований' : decision.required ? 'Требуется' : decision.mode === 'skip' ? 'Пропущена пользователем' : 'Не требуется'} — {decision.reason}
      {decision.missing.length > 0 && ` Недостающие решения: ${decision.missing.join('; ')}`}</p>}
    {!editing && task.stage === 'backlog' && task.run_state === 'idle' && <label>Подготовка Spec <select value={specMode} disabled={busy} onChange={e => setSpecMode(e.target.value as typeof specMode)}>
      <option value="auto">Авто</option><option value="spec">Со Spec</option><option value="skip">Без Spec</option>
    </select></label>}
    {!editing && !task.results_restart && ['backlog', 'build', 'review', 'approve'].includes(task.stage) && task.run_state === 'idle' && <button disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await api(`${taskPath(task)}/${task.stage === 'approve' ? 'approve' : task.stage === 'review' ? 'review' : task.stage === 'build' ? 'build' : 'start'}`, 'POST', { state_version: task.state_version, ...(task.stage === 'backlog' ? { spec_mode: specMode } : {}) }); await refresh(); }
      catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>{busy ? 'Ставим в очередь…' : task.stage === 'approve' ? 'Запустить Approve' : task.stage === 'review' ? 'Продолжить Review' : task.stage === 'build' ? 'Запустить Build' : 'Приступить к реализации'}</button>}
    {!editing && task.stage === 'needs-human' && task.run_state === 'interrupted' && latest && requiredReviews(latest).includes(latest.role as ReviewRole)
      && latest.status === 'completed' && !latest.stale && ['PASS', 'CHANGES'].includes(latest.outcome ?? '') && blockingReviews.length > 0 && <>
      <p>{latest.repair_attempt >= 2 ? 'Автоматические исправления остановлены: лимит двух доработок исчерпан.' : 'Автоматические исправления остановлены.'} Выполнено доработок: {latest.repair_attempt}/2.</p>
      <button disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try { await api(`${taskPath(task)}/repair`, 'POST', { state_version: task.state_version }); await refresh(); }
        catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      }}>{busy ? 'Ставим в очередь…' : 'Доработать: новый цикл (до двух доработок)'}</button>
    </>}
    {!editing && questions.map(request => request.result.outcome === 'ESCALATE' ? <HumanDecision key={request.id} task={task} request={request} refresh={refresh} /> : <HumanQuestions key={`${request.id}-${request.status}`} task={task} request={request} refresh={refresh} resume={task.run_state === 'interrupted' && !task.execution_unverified && !publicationBlocksLocal(task) && runs.at(-1)?.id === request.run_id && runs.at(-1)?.status === 'completed' && !!runs.at(-1)?.diagnostic?.execution_finished && !runs.at(-1)?.stale} />)}
    {task.run_state === 'interrupted' && !task.execution_unverified && runs.at(-1)?.status === 'failed' && runs.at(-1)?.diagnostic?.execution_finished && !publicationBlocksLocal(task) && <button disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await api(`${taskPath(task)}/retry`, 'POST', { state_version: task.state_version }); await refresh(); }
      catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>{runs.at(-1)?.diagnostic?.result_saved ? 'Продолжить по сохранённому результату' : 'Повторить завершённый запуск'}</button>}
    {task.run_state === 'interrupted' && runs.at(-1)?.status === 'failed' && runs.at(-1)?.diagnostic?.result_saved && <p>Результат агента сохранён. Продолжение повторит проверки backend и переход этапа без нового вызова модели.</p>}
    {task.run_state === 'interrupted' && (runs.at(-1)?.status === 'interrupted' || !runs.at(-1)?.diagnostic?.execution_finished) && <p>Перед продолжением нужна ручная проверка процесса и worktree. Автоматический повтор недоступен.</p>}
    <details onToggle={event => setShowHistory(event.currentTarget.open)}><summary>История описания</summary>
      {showHistory && <History task={task} revisions={revisions} setRevisions={setRevisions} />}
    </details>
    {messages.map(message => <Message key={message.id} message={message} />)}
    </div>
    {taskRoles.map(role => <div key={role} role="tabpanel" id={`${task.id}-panel-${role}`} aria-labelledby={`${task.id}-tab-${role}`} hidden={tab !== role} tabIndex={0}>
      <TaskResultsReset task={task} role={role} hasResults={runs.some(run => run.role === role)} refresh={refresh} notify={notify} />
      <TaskResultsRestart task={task} refresh={refresh} executionPaused={executionPaused} />
      {runs.some(run => run.role === role) ? <RunConversation runs={runs} role={role} revision={task.revision} path={taskPath(task)} api={api} messages={messages} requests={questions} active={active && tab === role} report={report} /> : <p className="empty">Этот этап ещё не запускался.</p>}
    </div>)}
    {tab !== 'overview' && messages.filter(message => !message.run_id).map(message => <Message key={message.id} message={message} />)}
    {chatError && <p role="alert">{chatError}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <Composer task={task} path={taskPath(task)} api={api} refresh={refresh} />
    </fieldset>
  </article>;
}
function DependencyStatus({ task, runs, refresh, executionPaused }: { task: Task; runs: AgentRun[]; refresh: () => Promise<void>; executionPaused: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmation, setConfirmation] = useState('');
  const latest = runs.at(-1);
  const source = latest?.outcome === 'BLOCKED' ? latest : latest?.diagnostic?.dependency_resume
    ? runs.find(r => r.id === latest.diagnostic!.dependency_resume!.blocked_run_id)
    : runs.findLast(r => r.diagnostic?.dependency_checks?.length);
  if (!source) return null;
  const checks = source.diagnostic?.dependency_checks ?? [], check = checks.at(-1);
  const dependencies = source.diagnostic?.dependency_block?.dependencies ?? [];
  const pending = check?.status === 'pending';
  const eligible = !latest?.revoked && (latest?.outcome === 'BLOCKED' || latest && ['failed', 'interrupted'].includes(latest.status) && !!latest.diagnostic?.dependency_resume);
  const blocker = dependencyActionBlocker(task) ?? (executionPaused ? 'Исполнение глобально приостановлено.' : null);
  const stateNames = { pending: 'Проверка выполняется', blocked: 'Блокировки остались', cleared: 'Зависимости сняты', error: 'Ошибка проверки', stale: 'Проверка устарела', interrupted: 'Проверка прервана' };
  return <section className="dependency-status" aria-label="Внешние блокировки">
    <h4>Внешние блокировки</h4>
    <p>{source.diagnostic?.dependency_block?.reason ?? 'Причина BLOCKED ещё не подтверждена структурированными зависимостями. Явная диагностика проверит её без Build и публикации.'}</p>
    <p className="meta">Исходный run: {source.id} · {stageNames[source.role]} · revision {source.description_revision}</p>
    {dependencies.map((d, index) => {
      const result = check?.results[index];
      return <div key={index} className="dependency-item">
        <p>{d.kind === 'code' ? 'Код' : 'Условие без кода'}: {d.reason}</p>
        <p>{[d.issue_url, d.pr_url].filter(Boolean).map(url => <a key={url} href={url!} target="_blank" rel="noreferrer">{url}</a>)}</p>
        <p>Условие снятия: {d.condition}</p>
        {d.issue_must_be_closed && <p>Дополнительно требуется закрытие исходной issue.</p>}
        <p>{result ? `${result.state === 'cleared' ? 'Снята' : result.state === 'blocked' ? 'Не снята' : 'Неизвестно'}: ${result.reason}` : 'Ещё не проверена'}</p>
        {result?.evidence.map((e, i) => <p key={i} className="meta">{e}</p>)}
      </div>;
    })}
    <div aria-live="polite" role="status">{check && <p>{stateNames[check.status]} · <time dateTime={check.finished_at ?? check.started_at}>{check.finished_at ?? check.started_at}</time>{check.status !== 'error' && <><br />{check.reason}</>}</p>}</div>
    {check?.questions.map((q, i) => <div key={i}><p><strong>{q.text}</strong> (обязательно)</p><p>{q.context}</p><p>{q.impact}</p></div>)}
    {check?.confirmation && <p className="meta">Сохранённое свидетельство: {check.confirmation}</p>}
    {eligible && <>
      {dependencies.some(d => d.kind === 'condition') && <label>Свидетельство выполнения условия без кода<textarea value={confirmation} maxLength={4096} disabled={busy || pending} onChange={e => setConfirmation(e.target.value)} placeholder="Что выполнено, кем и когда; ссылка или наблюдаемый результат" /></label>}
      <button aria-disabled={busy || pending || !!blocker} aria-busy={busy || pending} onClick={async () => {
        if (busy || pending || blocker) return;
        setBusy(true); setError('');
        try { await api(`${taskPath(task)}/check-dependencies`, 'POST', { state_version: task.state_version, confirmation }); await refresh(); }
        catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      }}>Проверить блокировки и продолжить</button>
      {blocker && <p className="hint">{blocker}</p>}
    </>}
    {(error || check?.status === 'error') && <p role="alert" className="error">{error || check?.reason}</p>}
    {latest?.diagnostic?.dependency_resume?.preserved_worktree && <p>Partial edits сохранены в {latest.diagnostic.dependency_resume.preserved_worktree} и не включены в новый запуск.</p>}
    {checks.length > 1 && <details><summary>Предыдущие проверки ({checks.length - 1})</summary>{checks.slice(0, -1).map(c => <details key={c.id}>
      <summary>{c.finished_at ?? c.started_at} · {stateNames[c.status]}</summary><p>{c.reason}</p>
      {c.results.map((r, i) => <div key={i}><p>{r.dependency.condition} · {r.reason}</p>{r.evidence.map((e, j) => <p key={j}>{e}</p>)}</div>)}
      {c.confirmation && <p>Свидетельство: {c.confirmation}</p>}{c.continuation_run_id && <p>Run: {c.continuation_run_id}</p>}
    </details>)}</details>}
  </section>;
}

function HumanDecision({ task, request, refresh }: { task: Task; request: HumanRequest; refresh: () => Promise<void> }) {
  const [version] = useState(task.state_version);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (request.result.outcome !== 'ESCALATE') return null;
  const decide = async (decision: 'publish' | 'repair') => {
    setBusy(true); setError('');
    try { await api(`${taskPath(task)}/decisions/${request.id}`, 'POST', { state_version: version, decision, feedback }); await refresh(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  return <section aria-label="Решение о публикации">
    <h4>ESCALATE · требуется решение человека</h4><p>{request.result.summary}</p>
    <p>Разрешение касается только публикации PR/MR этой версии. Merge запрещён. Четыре отчёта Review доступны на соответствующих вкладках.</p>
    <ul>{request.result.risks.map((risk, i) => <li key={i}>{risk}</li>)}</ul>
    <p>Затронутые файлы: {request.result.affected_paths.join(', ') || 'Не указаны; см. отчёты.'}</p>
    {request.status === 'pending' ? <>
      <label>Причина доработки<textarea value={feedback} maxLength={4096} onChange={e => setFeedback(e.target.value)} /></label>
      <button disabled={busy || task.state_version !== version || task.run_state !== 'waiting'} onClick={() => decide('publish')}>Разрешить публикацию PR/MR</button>
      <button disabled={busy || !feedback.trim() || task.state_version !== version || task.run_state !== 'waiting'} onClick={() => decide('repair')}>Отправить на доработку</button>
      {task.state_version !== version && <p role="status">Карточка изменилась. Обновите страницу перед решением.</p>}
      {task.run_state === 'interrupted' && <p>После restart нужна ручная сверка; исполнение не возобновляется автоматически.</p>}
    </> : <p>{request.status === 'revoked' ? 'Разрешение отозвано: версия изменилась.' : `Решение сохранено: ${request.answers?.[0] === 'publish' ? 'разрешена публикация' : 'доработка'}`}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function HumanQuestions({ task, request, refresh, resume }: { task: Task; request: HumanRequest; refresh: () => Promise<void>; resume: boolean }) {
  const [answers, setAnswers] = useState<string[]>(request.answers ?? request.result.questions.map(() => ''));
  const [version] = useState(task.state_version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (request.status !== 'pending' && !(resume && request.status === 'answered')) return <details><summary>Вопросы · Версия требований: {request.revision} · {request.status === 'answered' ? 'Ответ сохранён' : 'Отозваны'}</summary>
    {request.result.questions.map((q, i) => <p key={i}>{q.text}<br />{request.answers?.[i] || 'Без ответа'}</p>)}</details>;
  return <form onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(`${taskPath(task)}/questions/${request.id}/answer`, 'POST', { state_version: version, answers }); await refresh(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }}>
    <h4>Нужен ответ человека</h4>
    <p>{request.result.summary}</p>
    {request.result.questions.map((q, i) => <fieldset key={i} disabled={busy}>
      <legend>{q.text}{q.required ? ' (обязательно)' : ' (необязательно)'}</legend>
      <p>{q.context}</p><p>Влияние ответа: {q.impact}</p>
      {!!q.options.length && <label>Вариант<select value={q.options.includes(answers[i]) ? answers[i] : ''} onChange={event => setAnswers(values => values.map((value, index) => index === i ? event.target.value : value))}>
        <option value="">Выберите или введите свой ответ</option>{q.options.map((option, index) => <option key={index} value={option}>{option}</option>)}
      </select></label>}
      <label>Ваш ответ<textarea required={q.required} maxLength={4096} value={answers[i]} onChange={event => setAnswers(values => values.map((value, index) => index === i ? event.target.value : value))} /></label>
    </fieldset>)}
    {task.run_state === 'interrupted' && <p role="status">{resume ? 'Ответы будут переданы новому запуску после проверки worktree.' : 'Нужна ручная сверка исполнения; продолжение пока недоступно.'}</p>}
    {task.state_version !== version && <p role="status">Карточка изменилась. Скопируйте черновик ответов и обновите страницу.</p>}
    <button disabled={busy || (task.run_state === 'interrupted' && !resume) || task.state_version !== version || request.result.questions.some((q, i) => q.required && !answers[i].trim())}>
      {busy ? 'Сохраняем…' : request.status === 'answered' ? 'Продолжить с сохранёнными ответами' : `Ответить и продолжить ${request.role}`}
    </button>{error && <p role="alert" className="error">{error}</p>}
  </form>;
}

function History({ task, revisions, setRevisions }: { task: Task; revisions: Revision[] | null; setRevisions: (value: Revision[]) => void }) {
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Revision[]>(`${taskPath(task)}/revisions`).then(value => { if (active) setRevisions(value); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [task.id, task.revision, setRevisions]);
  return <>{error && <p role="alert">{error}</p>}{revisions ? revisions.map(r => <div key={r.revision}><p className="meta">Версия требований: {r.revision} · {new Date(r.created_at).toLocaleString('ru')}</p><TaskMarkdown>{r.description}</TaskMarkdown></div>) : <p role="status">Загружаем историю…</p>}</>;
}

function RunReport({ task, run, preview = false, historical = false }: { task: Task; run: AgentRun; preview?: boolean; historical?: boolean }) {
  const [report, setReport] = useState('');
  const [log, setLog] = useState<{ text: string; next_offset: number; more: boolean }>({ text: '', next_offset: 0, more: true });
  const [logName, setLogName] = useState('events.jsonl');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if ((!open && !preview) || !run.report) return;
    let active = true;
    api<{ text: string }>(`${taskPath(task)}/runs/${run.id}/report`)
      .then(value => { if (active) { setReport(value.text); setError(''); } })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [open, preview, run.id, run.report, task.id]);
  const excerpt = (report.split('\n\n## Findings\n')[1]?.split('\n\n')[0] ?? report.split('\n\n')[0]).trim();
  return <>
    {preview && <p>{error || (excerpt ? `${excerpt.slice(0, 360)}${excerpt.length > 360 ? '…' : ''}` : run.report ? 'Загружаем замечание…' : 'Сохранённый отчёт отсутствует; доступна диагностика.')}</p>}
    <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{run.report ? 'Отчёт' : 'Диагностика'} · {run.outcome ?? run.status}{historical || run.revoked || run.stale || run.description_revision !== task.revision ? ' · Неактуален, не учитывается в текущем раунде' : ''}{run.finished_at && ` · ${new Date(run.finished_at).toLocaleString('ru')}`}</summary>
    <p className="meta">Версия требований: {run.description_revision} · Модель: {run.config.models[run.role]}</p>
    <p className="meta">Доработки: {run.repair_attempt}/2 · {run.round_id && `Раунд: ${run.round_id}`} {run.spec_run_id && `Spec: ${run.spec_run_id}`}<br />{run.base_sha && `Base: ${run.base_sha}`}<br />{run.head_sha && `Head: ${run.head_sha}`}<br />Branch: {run.branch}<br />{run.worktree}</p>
    <p className="meta">Модели запуска: {allRoles.filter(role => run.config.models[role]).map(role => `${role}: ${run.config.models[role]} (${run.config.reasoning_efforts?.[role] ?? 'по умолчанию Codex'}; ${run.config.fast_modes?.[role] === undefined ? 'Fast наследуется' : run.config.fast_modes[role] ? 'Fast запрошен' : 'обычный режим'})`).join(' · ')}</p>
    <p className="meta">CLI: {run.diagnostic?.cli_version ?? 'неизвестна'} · Session: {run.diagnostic?.session_id ?? 'не предоставлен'}<br />
      Начало: {run.started_at ?? '—'} · Конец: {run.finished_at ?? '—'} · Duration: {run.started_at && run.finished_at ? `${Date.parse(run.finished_at) - Date.parse(run.started_at)} ms` : '—'}</p>
    {run.diagnostic?.usage && <p>Usage этого запуска: {JSON.stringify(run.diagnostic.usage)}. Это не остаток подписки.</p>}
    {run.diagnostic?.error_kind && <p>Причина: {run.diagnostic.error_kind}</p>}
    <label>Локальный лог <select value={logName} onChange={e => { setLogName(e.target.value); setLog({ text: '', next_offset: 0, more: true }); }}><option>events.jsonl</option><option>stderr.log</option></select></label>
    <button onClick={async () => { try { setLog(await api(`${taskPath(task)}/runs/${run.id}/log?name=${logName}&offset=${log.next_offset}`)); setError(''); } catch (error) { setError((error as Error).message); } }}>Следующие 64 KiB лога</button>
    {log.text && <pre>{log.text}</pre>}{!log.more && <p>Конец доступного лога.</p>}
    {run.error && <pre role="alert" className="error">{run.error}</pre>}
    {error && <p role="alert">{error}</p>}
    {!!run.report && <pre>{report || 'Загружаем сохранённый отчёт…'}</pre>}
  </details></>;
}
function ModelSettings({ project, refresh }: { project: Project; refresh: () => Promise<void> }) {
  const [config, setConfig] = useState<Settings | null>(null);
  const [version, setVersion] = useState(project.state_version);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<import('../shared.js').ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const submitting = useRef(false);
  async function refreshCatalog() {
    setLoading(true); setCatalogError('');
    try { setCatalog(await api(`/projects/${project.id}/models`)); }
    catch { setCatalogError('Не удалось получить каталог. Текущий выбор сохранён; доступен ручной ввод.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refreshCatalog(); }, [project.id]);
  async function reload() {
    const { state_version, ...saved } = await api<Settings & { state_version: number }>(`/projects/${project.id}/settings`);
    setConfig(saved); setVersion(state_version); setError(''); setNotice('');
  }
  useEffect(() => { reload().catch(error => setError(error.message)); }, [project.id]);
  return <details className="model-settings" open><summary>Модели и инструкции · {project.host}/{project.repository} · {project.checkout}</summary>
    {config && <form onSubmit={async event => {
      event.preventDefault(); if (submitting.current) return; submitting.current = true; setBusy(true); setError(''); setNotice('');
      try {
        const saved = await api<Settings>(`/projects/${project.id}/settings`, 'PUT', { ...config, state_version: version });
        setConfig(saved); setVersion(version + 1);
        setNotice('Настройки сохранены.');
        await refresh();
      }
      catch (error) { setError((error as Error).message); } finally { submitting.current = false; setBusy(false); }
    }}>
      <fieldset className="form-fields" disabled={busy}>
      <p role="status">{loading ? 'Получаем модели Codex…' : catalog ? `Источник: ${{ codex: 'Codex', cache: 'последний успешный каталог', defaults: 'встроенные настройки' }[catalog.source]}${catalog.updated_at ? ' · ' + new Date(catalog.updated_at).toLocaleString('ru') : ''}` : 'Каталог пока недоступен.'}</p>
      {(catalogError || catalog?.error) && <p role="alert">{catalogError || catalog?.error}</p>}
      <button type="button" className="secondary" disabled={loading} onClick={() => void refreshCatalog()}>Обновить список моделей</button>
      <div className="model-rows">{roles.map(role => <section className="model-row" key={role} aria-label={`Настройки роли ${role}`}>
        <strong>{role === 'review-ui-ux' ? 'Review UI/UX' : role === 'review-code' ? 'Review Code' : role === 'review-security' ? 'Review Security' : role === 'spec' ? 'Spec' : role === 'build' ? 'Build' : 'Approve'}</strong>
        <ModelPicker role={role} value={config.models[role]!} catalog={catalog?.models ?? []} onChange={value => {
          const reasoning_efforts = { ...config.reasoning_efforts };
          if (value !== config.models[role]) delete reasoning_efforts[role];
          setConfig({ ...config, models: { ...config.models, [role]: value }, reasoning_efforts });
        }} />
        <ReasoningPicker role={role} value={config.reasoning_efforts?.[role] ?? ''} model={catalog?.models.find(model => model.id === config.models[role])} onChange={value => {
          const reasoning_efforts = { ...config.reasoning_efforts };
          if (value) reasoning_efforts[role] = value; else delete reasoning_efforts[role];
          setConfig({ ...config, reasoning_efforts });
        }} />
        <div className="fast-setting">
          <label><input type="checkbox" aria-label={`Fast · ${role}`} checked={config.fast_modes?.[role] === true}
            disabled={config.fast_modes?.[role] !== true && (catalog?.source !== 'codex' || !catalog.models.find(model => model.id === config.models[role])?.fast?.supported)}
            onChange={event => setConfig({ ...config, fast_modes: { ...config.fast_modes, [role]: event.target.checked } })} />Fast</label>
          <p className="hint">{config.fast_modes?.[role] === undefined ? 'Наследуется настройка Codex; фактический режим неизвестен.' : config.fast_modes[role] ? 'Запрошен Fast; применение проверяется при запуске.' : 'Обычный режим (явно).'} </p>
          {(catalog?.source !== 'codex' || !catalog.models.find(model => model.id === config.models[role])?.fast?.supported) && <p className="hint">{catalog?.source !== 'codex' ? 'Fast не подтверждён: актуальный каталог недоступен.' : catalog.models.find(model => model.id === config.models[role])?.fast?.reason ?? 'Fast не подтверждён для модели и аккаунта.'}</p>}
          {config.fast_modes?.[role] === undefined && <button type="button" className="secondary" onClick={() => setConfig({ ...config, fast_modes: { ...config.fast_modes, [role]: false } })}>Обычный режим · {role}</button>}
        </div>
      </section>)}</div>
      <p className="hint">Fast при входе через ChatGPT: расход включённых лимитов ×2,5; купленные credits и Enterprise pay-as-you-go ×2. При API key действует API token pricing; этот путь Fast пока не подтверждён. <a href="https://developers.openai.com/codex/speed" target="_blank" rel="noreferrer">Тарификация Codex</a></p>
      <label>Инструкции проекта<textarea maxLength={30000} value={config.instructions} onChange={event => setConfig({ ...config, instructions: event.target.value })} /></label>
      <p className="hint">Каталог Codex не гарантирует доступ к модели. Модель вне списка можно указать вручную. При смене модели глубина сбрасывается на «По умолчанию Codex». Конфигурация фиксируется при старте задачи; недоступная модель останавливает запуск без подмены.</p>
      {project.state_version !== version && <p role="status">Настройки изменились. Загрузите актуальную версию перед сохранением.</p>}
      <button disabled={busy || project.state_version !== version}>Сохранить настройки</button>{' '}
      <button type="button" className="secondary" disabled={busy} onClick={() => reload().catch(error => setError(error.message))}>Отменить / загрузить сохранённые</button>
      </fieldset>
    </form>}{notice && <p role="status">{notice}</p>}{!config && <button type="button" className="secondary" onClick={() => reload().catch(error => setError(error.message))}>Загрузить настройки</button>}{error && <p role="alert" className="error">{error}</p>}
  </details>;
}

function IssueRefresh({ project, syncing }: { project: Project; syncing: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requesting = useRef(false);
  return <>
    <button className="secondary" disabled={syncing || busy} onClick={async () => {
      if (syncing || requesting.current) return;
      requesting.current = true; setBusy(true); setError('');
      try { await api(`/projects/${project.id}/issues/refresh`, 'POST'); }
      catch (error) { setError((error as Error).message); }
      finally { requesting.current = false; setBusy(false); }
    }}>Обновить задачи из GitHub</button>{' '}
    <span role="status">{syncing || busy ? 'Обновляем…' : ''}</span>
    {error && <p role="alert" className="error">GitHub Issues · {project.host}/{project.repository}: {error}</p>}
  </>;
}

function App() {
  const [theme, setTheme] = useState(readTheme);
  const readTaskId = () => new URLSearchParams(location.search).get('task') ?? '';
  const [detailId, setDetailId] = useState(readTaskId);
  const [opened, setOpened] = useState<string[]>(() => readTaskId() ? [readTaskId()] : []);
  const [drafts, setDrafts] = useState<Record<string, DescriptionDraft>>({});
  function setTaskDraft(id: string, draft: DescriptionDraft | null) {
    setDrafts(previous => {
      const next = { ...previous };
      if (draft) next[id] = draft; else delete next[id];
      return next;
    });
  }
  const boardPosition = useRef({ x: 0, y: 0 });
  const previousDetail = useRef(detailId);
  const returnButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const navigate = () => {
      const id = readTaskId(); setDetailId(id);
      if (id) setOpened(ids => ids.includes(id) ? ids : [...ids, id]);
    };
    addEventListener('popstate', navigate); return () => removeEventListener('popstate', navigate);
  }, []);
  useEffect(() => {
    if (detailId) { window.scrollTo(0, 0); returnButton.current?.focus(); }
    else if (previousDetail.current) {
      document.getElementById(`open-${previousDetail.current}`)?.focus({ preventScroll: true });
      window.scrollTo(boardPosition.current.x, boardPosition.current.y);
    }
    previousDetail.current = detailId;
  }, [detailId]);
  function openTask(id: string) {
    boardPosition.current = { x: window.scrollX, y: window.scrollY };
    history.pushState({ taskDetail: true }, '', `?task=${encodeURIComponent(id)}`);
    setOpened(ids => ids.includes(id) ? ids : [...ids, id]); setDetailId(id);
  }
  function closeTask() {
    if (history.state?.taskDetail) history.back();
    else { history.replaceState(null, '', location.pathname); setDetailId(''); }
  }
  const [snapshot, setSnapshot] = useState<Snapshot>({ projects: [], tasks: [], runs: [], human_requests: [], cursor: 0 });
  const [ready, setReady] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const eventCursor = useRef(0);
  const announced = useRef(new Set<string>());
  function setNotice(text: string, key?: string) {
    if (key && announced.current.has(key)) return;
    if (key) announced.current.add(key);
    const notice = { id: ++noticeId.current, text, persistent: /не подтверждена|Remote|remote/.test(text) };
    setNotices(previous => [...previous, notice]);
  }
  useEffect(() => {
    if (ready && detailId && ![...snapshot.tasks, ...(snapshot.archived_tasks ?? [])].some(task => task.id === detailId)) {
      history.replaceState(null, '', location.pathname);
      setDetailId(''); setOpened(ids => ids.filter(id => id !== detailId));
      setNotice('Карточка архивирована или недоступна.');
    }
  }, [ready, snapshot, detailId]);
  const [connection, setConnection] = useState('Подключаемся к backend…');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [projectId, setProjectId] = useState('');
  const [filter, setFilter] = useState('');
  const [description, setDescription] = useState('');
  const [checkout, setCheckout] = useState('');
  const [windowName, setWindowName] = useState('');
  const [projectError, setProjectError] = useState('');
  const [taskError, setTaskError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [resumeCreate, setResumeCreate] = useState(false);
  const submitting = useRef(false);
  const projectPopover = useRef<HTMLDivElement>(null);
  const createDraftStarted = useRef(false);
  function showWindow(name: string) {
    projectPopover.current?.hidePopover();
    if (name === 'create' && !createDraftStarted.current) {
      setProjectId(filter || (snapshot.projects.some(project => project.id === projectId) ? projectId : snapshot.projects[0]?.id ?? ''));
      createDraftStarted.current = true;
    }
    if (name === 'delete') { setDeleting(snapshot.projects.find(project => project.id === filter) ?? null); setDeleteError(''); }
    setWindowName(name);
  }
  function closeWindow() { setWindowName(''); setResumeCreate(false); }
  useEffect(() => {
    if (!ready) return;
    if (filter && !snapshot.projects.some(project => project.id === filter)) setFilter('');
    if (projectId && !snapshot.projects.some(project => project.id === projectId)) setProjectId('');
  }, [snapshot.projects, filter, projectId, ready]);
  const selectingFolder = useRef(false);
  async function refresh() { setSnapshot(await api<Snapshot>('/snapshot')); }
  useEffect(() => {
    let events: EventSource | undefined, disposed = false;
    (async () => {
      const token = new URLSearchParams(location.hash.slice(1)).get('token');
      if (token) {
        history.replaceState(null, '', location.pathname + location.search);
        await api('/session', 'POST', { token });
      }
      const initial = await api<Snapshot>('/snapshot');
      if (disposed) return;
      eventCursor.current = initial.cursor; setSnapshot(initial); setReady(true);
      events = new EventSource('/api/events');
      events.addEventListener('snapshot', event => { setSnapshot(JSON.parse((event as MessageEvent).data)); setConnection('Сохранено локально · Соединение активно'); });
      events.addEventListener('change', event => {
        const change = JSON.parse((event as MessageEvent).data) as SavedEvent;
        if (change.id <= eventCursor.current) return;
        eventCursor.current = change.id;
        if (change.type === 'task.archived') {
          const payload = JSON.parse(change.payload) as { state_version?: number };
          setNotice('Карточка скрыта. Результат остановки и история доступны в архиве.', payload.state_version ? `archive:${change.task_id}:${payload.state_version}` : `event:${change.id}`);
        }
        if (change.type === 'task.results-reset') setNotice('Выбранные и зависимые результаты сброшены. Новый запуск — отдельным действием.');
        if (change.type === 'task.restored') setNotice('Карточка возвращена на доску. Исполнение автоматически не возобновляется.');
      });
      events.onerror = () => setConnection('Live-обновления недоступны. Переподключаемся. Это само по себе не означает остановку задачи. Обновите страницу, чтобы получить актуальное состояние');
    })().catch(error => { if (!disposed) { setError(error.message); setConnection('Подключение не выполнено'); } });
    return () => { disposed = true; events?.close(); };
  }, []);
  const visibleTasks = snapshot.tasks.filter(task => !filter || task.project_id === filter);
  const archived = (snapshot.archived_tasks ?? []).filter(task => !filter || task.project_id === filter);
  const unverified = (snapshot.archived_tasks ?? []).filter(task => task.deletion_state !== 'deleted' || task.stop_unverified || task.execution_unverified);
  const selected = snapshot.projects.find(p => p.id === projectId);
  const filteredProject = snapshot.projects.find(p => p.id === filter);
  return <main>
    <header><div><p className="eyebrow">LOCAL WORKSPACE</p><h1>SW Factory</h1></div><p className="connection" role="status">{connection}</p>
      <label className="theme">Тема<select value={theme} onChange={event => {
        const next = event.target.value as Theme;
        setTheme(next); applyTheme(next);
        try { localStorage.setItem('theme', next); } catch { /* The theme still works when storage is unavailable. */ }
      }}><option value="system">Системная</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label>
    </header>
    <div className="toasts" aria-label="Уведомления">{notices.map(notice => <Toast key={notice.id} notice={notice} dismiss={() => setNotices(previous => previous.filter(item => item.id !== notice.id))} />)}</div>
    {!!unverified.length && <p role="alert">В архиве {unverified.length} задач: остановка всех процессов не подтверждена. Откройте «Архив» с панели действий.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {snapshot.title_error && <p role="alert" className="error">{snapshot.title_error}</p>}
    {snapshot.execution_error && <p role="alert" className="error">{snapshot.execution_error}</p>}
    {snapshot.issue_errors?.map((error, index) => {
      const project = snapshot.projects.find(project => project.id === error.project_id);
      return <p key={`${error.project_id}-${index}`} role="alert" className="error">GitHub Issues · {project ? `${project.host}/${project.repository}` : error.project_id}: {error.message}</p>;
    })}
    {!!snapshot.execution_pause?.paused && <section aria-label="Лимит Codex"><p role="status">Новые запуски приостановлены: {snapshot.execution_pause.reset_at ? `до ${snapshot.execution_pause.reset_at}` : 'reset time неизвестен; после восстановления лимитов продолжите вручную'}. Уже работающие задачи завершаются.</p>
      {!snapshot.execution_pause.reset_at && <button disabled={!!busy} onClick={async () => { setBusy('resume'); try { await api('/execution/resume', 'POST', { state_version: snapshot.execution_pause!.state_version }); await refresh(); } catch (error) { setError((error as Error).message); } finally { setBusy(''); } }}>Лимит восстановлен — продолжить очередь</button>}
    </section>}
    <div hidden={!!detailId}>
    <nav className="workspace-actions" aria-label="Действия доски">
      <button className="secondary" onClick={() => showWindow('connect')}><ActionIcon kind="connect" />Подключить проект</button>
      <button className="secondary project-choice" popoverTarget="project-selector" aria-haspopup="dialog" onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (projectPopover.current) { projectPopover.current.style.top = `${Math.min(rect.bottom + 8, innerHeight - 160)}px`; projectPopover.current.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 376))}px`; }
      }}><ActionIcon kind="select" /><span>{filteredProject ? `${filteredProject.host}/${filteredProject.repository} · ${filteredProject.checkout}` : 'Все проекты'}</span><span aria-hidden="true">▾</span></button>
      <div id="project-selector" ref={projectPopover} popover="auto" role="dialog" aria-label="Выбор проекта" className="project-popover" onToggle={event => { if (event.newState === 'open') event.currentTarget.querySelector('select')?.focus(); }}>
        <label>Показывать проект<select value={filter} onChange={event => { setFilter(event.target.value); projectPopover.current?.hidePopover(); }}><option value="">Все проекты</option>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.host}/{p.repository} · {p.checkout} · {p.target_branch}</option>)}</select></label>
        <button className="secondary" onClick={() => projectPopover.current?.hidePopover()}>Закрыть</button>
      </div>
      <button id="create-task-action" onClick={() => showWindow('create')}><ActionIcon kind="create" />Создать задачу</button>
      <span className="delete-project-action"><button className="secondary" disabled={!filteredProject} aria-describedby={!filteredProject ? 'delete-project-hint' : undefined} onClick={() => showWindow('delete')}><ActionIcon kind="delete" />Удалить проект</button>{!filteredProject && <small id="delete-project-hint">Выберите конкретный проект для удаления</small>}</span>
      <button className="secondary" onClick={() => showWindow('settings')}><ActionIcon kind="settings" />Модели и инструкции</button>
      <button className="secondary" onClick={() => showWindow('statistics')}><ActionIcon kind="statistics" />Статистика</button>
      <button id="archive-action" className="secondary" onClick={() => showWindow('archive')}><ActionIcon kind="archive" />Архив ({archived.length})</button>
    </nav>
    <Modal open={windowName === 'statistics'} title="Статистика" close={closeWindow}>{windowName === 'statistics' && <StatisticsWindow snapshot={snapshot} initialProject={filter} />}</Modal>
    <Modal open={windowName === 'connect'} title="Подключить проект" close={closeWindow}>
        <form onSubmit={async event => {
          event.preventDefault(); if (!ready || submitting.current || busy || selectingFolder.current) return;
          const form = event.currentTarget; const fields = new FormData(form);
          submitting.current = true; setBusy('project'); setProjectError('');
          try {
            const project = await api<Project>('/projects', 'POST', { ...Object.fromEntries(fields), state_version: 0 });
            await refresh(); setProjectId(project.id); form.reset(); setCheckout('');
            setWindowName(resumeCreate ? 'create' : ''); setResumeCreate(false);
          } catch (error) { setProjectError((error as Error).message); } finally { submitting.current = false; setBusy(''); }
        }}>
          <fieldset className="form-fields" disabled={!!busy}>
          <label>Checkout<input data-initial-focus name="checkout" required placeholder="/Users/you/projects/repository" value={checkout} disabled={busy === 'folder'} onChange={event => setCheckout(event.target.value)} /></label>
          <button type="button" className="secondary" disabled={!ready || !!busy} onClick={async () => {
            if (!ready || busy || selectingFolder.current) return;
            selectingFolder.current = true; setBusy('folder'); setProjectError('');
            try {
              const result = await api<{ checkout: string | null }>('/projects/choose-folder', 'POST');
              if (result.checkout !== null) setCheckout(result.checkout);
            } catch (error) { setProjectError((error as Error).message); }
            finally { selectingFolder.current = false; setBusy(''); }
          }}>{busy === 'folder' ? 'Выбираем папку…' : 'Выбрать папку…'}</button>
          <div className="fields"><label>Remote<input name="remote" required defaultValue="origin" /></label>
          <label>Целевая ветка<input name="target_branch" required defaultValue="main" /></label>
          <label>Hosting<select name="hosting"><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></label></div>
          <button disabled={!ready || !!busy}>{busy === 'project' ? 'Проверяем Git и CLI…' : 'Подключить'}</button>
          <p className="hint">Проверим локальный remote, известную target branch и CLI auth. Checkout останется без изменений.</p>
          {projectError && <p role="alert" className="error">{projectError}</p>}
          </fieldset>
        </form>
    </Modal>
    <Modal open={windowName === 'create'} title="Новая задача" close={closeWindow}>
        <form onSubmit={async event => {
          event.preventDefault(); if (!ready || !selected || !description.trim() || busy || submitting.current) return;
          submitting.current = true; setBusy('task'); setTaskError('');
          try {
            await api(`/projects/${selected.id}/tasks`, 'POST', { state_version: selected.state_version, description });
            setDescription(''); createDraftStarted.current = false; setTaskError(''); setWindowName(''); await refresh().catch(error => setError(error.message));
          } catch (error) { setTaskError((error as Error).message); } finally { submitting.current = false; setBusy(''); }
        }}>
          <fieldset className="form-fields" disabled={!!busy}>
          <label>Проект<select data-initial-focus required value={selected?.id ?? ''} onChange={event => setProjectId(event.target.value)} disabled={!snapshot.projects.length}>
            <option value="" disabled>Выберите проект</option>
            {snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.host}/{p.repository} · {p.checkout} · {p.target_branch}</option>)}
          </select></label>
          {!snapshot.projects.length && <p>Сначала подключите проект. Описание сохранится. <button type="button" className="secondary" onClick={() => { setResumeCreate(true); showWindow('connect'); }}>Подключить проект</button></p>}
          <label>Описание<textarea required maxLength={100000} value={description} onChange={event => setDescription(event.target.value)} placeholder="Что нужно сделать?" /></label>
          <button disabled={!ready || !selected || !description.trim() || !!busy}>{busy === 'task' ? 'Сохраняем…' : 'Добавить в Backlog'}</button>
          {taskError && <p role="alert" className="error">{taskError}</p>}
          </fieldset>
        </form>
    </Modal>
    <Modal open={windowName === 'settings'} title="Модели и инструкции" close={closeWindow}>
      {!snapshot.projects.length && <p>Сначала подключите проект.</p>}
      {windowName === 'settings' && snapshot.projects.map(project => <ModelSettings key={project.id} project={project} refresh={refresh} />)}
      <details className="projects"><summary>Подключённые проекты ({snapshot.projects.length})</summary>{snapshot.projects.map(p => <div key={p.id}>
        <strong>{p.host}/{p.repository}</strong>{' '}
        {p.hosting === 'github' && <IssueRefresh project={p} syncing={!!snapshot.issue_syncing?.includes(p.id)} />}
        <p>{p.checkout}</p><p>{p.hosting} · {p.remote} → {p.remote_url} · target: {p.target_branch}</p>
      </div>)}</details>
    </Modal>
    <Modal open={windowName === 'archive'} title={`Архив (${archived.length}) · ${filteredProject ? filteredProject.repository : 'Все проекты'}`} close={closeWindow}>
      {archived.map(task => <ArchivedTask key={task.id} task={task} refresh={refresh} notify={setNotice} draft={drafts[task.id]} openTask={id => { setWindowName(''); openTask(id); }} />)}{!archived.length && <p>Архив пуст.</p>}
    </Modal>
    <Modal open={windowName === 'delete'} title="Удалить регистрацию проекта?" close={closeWindow}>
      {deleting && <>
        <p><strong>{deleting.host}/{deleting.repository}</strong> · {deleting.checkout} · {deleting.target_branch}</p>
        <p>Будут удалены регистрация и настройки проекта в приложении. Локальный checkout, Git worktrees, ветки и удалённый репозиторий не удаляются. Проект можно подключить повторно.</p>
        <p>Удаление разрешено только без любых связанных задач, включая завершённые и архивные. Архивирование не снимает ограничение; история и результаты задач не удаляются.</p>
        {(!snapshot.projects.some(project => project.id === deleting.id) || snapshot.projects.find(project => project.id === deleting.id)?.state_version !== deleting.state_version) && <p role="status">Проект удалён или изменился. Закройте окно и откройте подтверждение заново.</p>}
        {[...snapshot.tasks, ...(snapshot.archived_tasks ?? [])].some(task => task.project_id === deleting.id) && <p role="status">У проекта есть связанные задачи. Удаление запрещено.</p>}
        <div className="actions"><button disabled={!!busy || !snapshot.projects.some(project => project.id === deleting.id && project.state_version === deleting.state_version) || [...snapshot.tasks, ...(snapshot.archived_tasks ?? [])].some(task => task.project_id === deleting.id)} onClick={async () => {
          if (submitting.current || busy) return;
          submitting.current = true; setBusy('delete'); setDeleteError('');
          try {
            await api(`/projects/${deleting.id}`, 'DELETE', { state_version: deleting.state_version });
            setFilter(''); setProjectId(id => id === deleting.id ? '' : id); setWindowName('');
            setNotice('Регистрация и настройки проекта удалены. Репозиторий сохранён.'); await refresh().catch(error => setError(error.message));
          } catch (error) { setDeleteError((error as Error).message); await refresh().catch(() => {}); }
          finally { submitting.current = false; setBusy(''); }
        }}>{busy === 'delete' ? 'Удаляем…' : 'Подтвердить удаление'}</button><button data-initial-focus className="secondary" onClick={closeWindow}>Отмена</button></div>
        {deleteError && <p role="alert" className="error">{deleteError}</p>}
      </>}
    </Modal>
    <div className="board-heading"><h2>Доска <span>{visibleTasks.length}</span></h2></div>
    <div className="board" tabIndex={0} role="region" aria-label="Kanban, горизонтальная прокрутка">
      {stages.map((stage, index) => {
        const tasks = visibleTasks.filter(t => t.stage === stage);
        return <section key={stage} className={`column ${stage === 'needs-human' ? 'human' : ''}`} aria-label={labels[index]}><h2>{labels[index]} <span>{tasks.length}</span></h2>
          {tasks.length ? tasks.map(task => <article className="card" key={task.id}>
            <span className="project-name">{snapshot.projects.find(p => p.id === task.project_id)?.repository}</span>
            <SourceIssue task={task} />
            <h3>{task.title ?? `Задача ${task.id.slice(0, 8)}`}</h3><p className="meta">{{ idle: 'Ожидает запуска', queued: 'В очереди', running: 'В работе', waiting: 'Нужен ответ', interrupted: 'Нужна сверка', completed: 'Завершена' }[task.run_state]}</p>
            <p className="agent-preview task-summary">{task.description}</p>
            {snapshot.runs.filter(run => run.task_id === task.id).at(-1)?.output_preview && <p className="agent-preview">{snapshot.runs.filter(run => run.task_id === task.id).at(-1)?.output_preview}</p>}
            {task.deletion_state && <p role={task.deletion_state === 'failed' ? 'alert' : 'status'}>{task.deletion_state === 'failed' ? task.deletion_error : task.deletion_state === 'deleted' ? 'Остановка подтверждена; требуется явная разблокировка.' : 'Останавливаем исполнение…'}</p>}
            <button id={`open-${task.id}`}  onClick={() => openTask(task.id)}>Открыть задачу ↗</button>
          </article>) : <p className="empty">{stage === 'backlog' ? 'Добавьте первую задачу' : 'Пока нет задач'}</p>}
        </section>;
      })}
    </div>
    </div>
    <div hidden={!detailId} className="task-page">
      <button ref={returnButton} className="secondary" onClick={closeTask}>← На доску</button>
      {ready && ![...snapshot.tasks, ...(snapshot.archived_tasks ?? [])].some(task => task.id === detailId) && <p role="status">Задача не найдена.</p>}
      {opened.map(id => {
        const task = [...snapshot.tasks, ...(snapshot.archived_tasks ?? [])].find(task => task.id === id);
        const project = task && snapshot.projects.find(project => project.id === task.project_id);
        return task && project ? <TaskView key={id} hidden={id !== detailId} blocked={!!(task.archived || task.deletion_state)}>{task.archived || (task.deletion_state && task.deletion_state !== 'stopping') ? <><RunStatistics records={snapshot.statistics_runs?.filter(run => run.task_id === id && run.project_id === project.id)} active={id === detailId} calendar breakdown /><ArchivedTask task={task} refresh={refresh} notify={setNotice} expanded draft={drafts[id]} /></> : <TaskCard task={task} project={project} executionPaused={!!snapshot.execution_pause?.paused} runs={snapshot.runs.filter(run => run.task_id === id && run.project_id === project.id)} questions={snapshot.human_requests.filter(request => request.task_id === id)} refresh={refresh} active={id === detailId} cursor={snapshot.cursor} notify={setNotice} draft={drafts[id]} setDraft={draft => setTaskDraft(id, draft)} />}</TaskView> : null;
      })}
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
