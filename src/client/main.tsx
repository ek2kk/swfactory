import { ModelPicker, ReasoningPicker } from './models.js';
import { api } from './api.js';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { stages, type Project, type Task, type Snapshot, type Revision, roles, allRoles, requiredReviews, type ReviewRole, type Settings, type AgentRun, type HumanRequest, type ChatMessage } from '../shared.js';
import './style.css';
import { Composer, Message, RunConversation } from './chat.js';
import { AgentOutput, RunProgress } from './output.js';
import { applyTheme, readTheme, type Theme } from './theme.js';
import { stageRoles, stageNames, stageTabStatus } from './stageHistory.js';
import { TaskView, type DescriptionDraft } from './taskView.js';

applyTheme(readTheme());

const labels = ['Backlog', 'Spec', 'Build', 'Review', 'Approve', 'PR/MR created', 'Needs human'];
const taskPath = (task: Task) => `/projects/${task.project_id}/tasks/${task.id}`;

function SourceIssue({ task }: { task: Task }) {
  return task.issue_url && <p className="meta"><a href={task.issue_url} target="_blank" rel="noreferrer">GitHub issue #{task.issue_number}</a></p>;
}

function TaskDisposition({ task, refresh, notify }: { task: Task; refresh: () => Promise<void>; notify: (text: string) => void }) {
  const [verification, setVerification] = useState<unknown>(null);
  useEffect(() => {
    if (!task.deletion_state) return;
    let disposed = false;
    api<{ verification: unknown }>(`${taskPath(task)}/deletion`).then(result => { if (!disposed) setVerification(result.verification); }).catch(() => {});
    return () => { disposed = true; };
  }, [task.id, task.deletion_state, task.state_version]);
  const [reconciliation, setReconciliation] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!confirming || !element) return;
    element.showModal(); cancelButton.current?.focus();
    return () => element.close();
  }, [confirming]);
  function closeConfirmation() {
    // Closing before unmount lets the browser restore focus to the card.
    dialog.current?.close(); setConfirming(false);
  }
  const [version, setVersion] = useState(task.state_version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const checkingStop = !(confirming && archiving) && !!(task.archived || task.deletion_state);
  return <section aria-label={checkingStop ? "Остановка исполнения" : "Архивирование задачи"}>
    {task.archive_source === 'github-filter' && <p role="status">{task.archived ? `Автоматический архив: ${task.archive_reason}` : 'Соответствие фильтру GitHub восстановлено. Исполнение автоматически не возобновляется.'}</p>}
    {task.deletion_state === 'stopping' && <p role="status">Останавливаем известные процессы. Подтверждение остановки всех процессов пока не получено.</p>}
    {task.deletion_error && <p role="alert">{task.deletion_error}</p>}
    {!!verification && <details><summary>Данные для ручной сверки процессов и публикации</summary><pre>{JSON.stringify(verification, null, 2)}</pre></details>}
    {task.deletion_state === 'deleted' && <p role="status">Остановка подтверждена. {task.archived ? 'Карточка остаётся в архиве.' : 'Проверьте остановку для разблокировки доступных действий; новый запуск требует отдельного действия.'}</p>}
    {(!task.archived || task.deletion_state !== 'deleted') && <button className={checkingStop ? "secondary" : "secondary archive-button"} aria-label={checkingStop ? "Остановить исполнение / сверить" : "Архивировать"} title={checkingStop ? "Остановить исполнение / сверить" : "Архивировать"} disabled={busy || task.deletion_state === 'stopping'} onClick={() => { setArchiving(false); setVersion(task.state_version); setConfirming(true); setError(''); }}>{checkingStop ? 'Остановить исполнение / сверить' : <><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16v13H4zM3 3h18v4H3zM9 11h6" /></svg><span className="action-tooltip" aria-hidden="true">Архивировать</span></>}</button>}
    {task.archive_source === 'github-filter' && (task.archived || task.deletion_state) && <button className="secondary" disabled={busy} onClick={() => {
      setArchiving(true); setVersion(task.state_version); setConfirming(true); setError('');
    }}>Архивировать вручную</button>}
    {confirming && <dialog ref={dialog} onCancel={event => { event.preventDefault(); if (!busy) closeConfirmation(); }} aria-labelledby={`delete-title-${task.id}`} className="delete-confirmation">
      <h4 id={`delete-title-${task.id}`}>{checkingStop ? 'Проверить остановку' : 'Архивировать'} «{task.title ?? task.description}»?</h4>
      <p>{checkingStop ? 'Повторим остановку известных процессов без изменения видимости карточки. Ручная сверка ниже нужна только для подтверждения отсутствия всех процессов и проверки remote результата. Новые запуски не выполняются.' : <>Карточка будет скрыта с доски, новые запуски и публикация заблокированы. Попытаемся остановить известные процессы. Архивирование не подтверждает остановку всех процессов: неизвестный потомок может продолжать работу. История и результаты остановки доступны в архиве; файлы и существующие PR сохраняются. Уже отправленная remote операция могла завершиться. Вручную архивированные карточки автоматически не восстанавливаются.</>}</p>
      {checkingStop && !!task.stop_unverified && task.deletion_state === 'failed' && <label>Необязательная ручная сверка (оставьте пустым для повторной попытки остановки): проверьте отсутствие процессов задачи, Codex sessions и их дочерних процессов, а также remote результат публикации. Опишите фактические наблюдения (не вводите credentials). Это ваше подтверждение остановки; backend проверить его самостоятельно не может.<textarea minLength={20} maxLength={4096} value={reconciliation} onChange={event => setReconciliation(event.target.value)} /></label>}
      {checkingStop && version !== task.state_version && <p role="status">Карточка изменилась. Текст сверки сохранён. <button className="secondary" disabled={busy} onClick={() => { setVersion(task.state_version); cancelButton.current?.focus(); }}>Сверять актуальную версию</button></p>}
      <button disabled={busy || version !== task.state_version || (!!reconciliation.trim() && reconciliation.trim().length < 20)} onClick={async () => {
        setBusy(true); setError('');
        try {
          if (checkingStop) {
            const result = await api<{ deleted: boolean; error: string | null; warning: string | null }>(`${taskPath(task)}/stop`, 'POST', { state_version: version, ...(reconciliation.trim() ? { reconciliation: reconciliation.trim() } : {}) });
            setError(result.error ?? ''); closeConfirmation(); setReconciliation('');
            notify(`${result.deleted ? 'Остановка подтверждена.' : 'Остановка не подтверждена; исполнение заблокировано.'}${result.warning ? ' ' + result.warning : ''}`);
          } else {
            await api(`${taskPath(task)}/archive`, 'POST', { state_version: version });
            closeConfirmation();
            notify('Карточка скрыта. Результат остановки и история доступны в архиве.');
          }
          await refresh();
        } catch (error) { setError((error as Error).message); await refresh().catch(() => {}); }
        finally { setBusy(false); }
      }}>{busy ? 'Выполняем…' : checkingStop ? 'Проверить остановку' : 'Подтвердить архивирование'}</button>{' '}
      <button ref={cancelButton} className="secondary" disabled={busy} onClick={closeConfirmation}>Отмена</button>
      {!checkingStop && !busy && version !== task.state_version && <p role="status">Карточка изменилась. Отмените подтверждение и откройте его снова.</p>}
      {error && <p role="alert">{error}</p>}
    </dialog>}
    {!confirming && error && error !== task.deletion_error && <p role="alert">{error}</p>}
  </section>;
}

function ArchivedTask({ task, refresh, notify, expanded = false, draft, openTask }: { task: Task; refresh: () => Promise<void>; notify: (text: string) => void; expanded?: boolean; draft?: DescriptionDraft; openTask?: (id: string) => void }) {
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
    <summary data-task-heading>{task.title ?? task.id} · {task.deletion_state === 'deleted' ? 'остановка подтверждена' : task.deletion_state === 'stopping' ? 'остановка выполняется' : 'остановка не подтверждена'}</summary>
    {open && <>
      <p className="description">{task.description}</p>
      {draft && <label>Несохранённый черновик описания — можно скопировать<textarea readOnly value={draft.description} /></label>}
      <SourceIssue task={task} />
      {task.publication_status === 'unknown' || task.publication_status === 'pending' ? <p role="alert">Remote операция могла завершиться. Проверьте hosting; автоматического повтора публикации нет.</p> : null}
      {task.pr_url && <a href={task.pr_url} target="_blank" rel="noreferrer">Существующий PR</a>}
      {openTask ? <>
        {task.archive_source === 'github-filter' && <p role="status">Автоматический архив: {task.archive_reason}</p>}
        {task.deletion_error && <p role="alert">{task.deletion_error}</p>}
        <button id={`open-${task.id}`} onClick={() => openTask(task.id)}>Открыть задачу / сверить остановку ↗</button>
      </> : <TaskDisposition task={task} refresh={refresh} notify={notify} />}
      {loading && <p role="status">Загружаем историю…</p>}
      {error && <p role="alert">{error}</p>}
      {history && <>
        <details><summary>История описания</summary>{history.revisions.map(revision => <div key={revision.revision}><p>Версия требований: {revision.revision}</p><pre>{revision.description}</pre></div>)}</details>
        {history.messages.map(message => <Message key={message.id} message={message} />)}
        {history.runs.map(run => <RunReport key={run.id} task={task} run={run} />)}
      </>}
    </>}
  </details>;
}

function TaskCard({ task, project, runs, questions, refresh, active, cursor, notify, draft, setDraft }: { task: Task; project: Project; runs: AgentRun[]; questions: HumanRequest[]; refresh: () => Promise<void>; active: boolean; cursor: number; notify: (text: string) => void; draft?: DescriptionDraft; setDraft: (draft: DescriptionDraft | null) => void }) {
  const [specMode, setSpecMode] = useState<'auto' | 'spec' | 'skip'>('auto');
  const decision = task.spec_decision?.revision === task.revision ? task.spec_decision : null;
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
  const blockingReview = runs.findLast(run => run.round_id === latest?.round_id && run.outcome === 'CHANGES' && !run.stale && run.description_revision === task.revision);
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
    <fieldset className="task-controls" disabled={!!task.deletion_state}>
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
    </form> : <><p className="description">{task.description}</p>{!task.publication_status && task.run_state !== 'interrupted' && <button ref={requirementsButton} className="secondary" onClick={() => {
      if (!draft) {
        replacement.current = task.description; clarification.current = '';
        setDraft({ description: canReplace ? task.description : '', version: task.state_version, ...(canReplace ? {} : { kind: 'requirements' as const }) });
      }
      setEditing(true); setRequirementsError('');
    }}>Изменить требования</button>}</>}
    </section>
    {messages.filter(message => message.kind === 'requirements' && ['queued', 'failed'].includes(message.status)).map(message => <p key={message.id} role={message.status === 'failed' ? 'alert' : 'status'}>{message.status === 'queued' ? 'Изменение требований ожидает применения после текущего этапа.' : `Изменение требований не применено: ${message.error ?? 'Ошибка сохранения'}`}</p>)}
    <div className="current-activity">
    {latest?.description_revision === task.revision && latest.error && <p role="alert" className="error">{latest.error}</p>}
    {latest?.description_revision === task.revision && <RunProgress run={latest} busy={busy}
      onInterrupt={latest.status === 'running' && latest.diagnostic?.can_interrupt && !latest.diagnostic.result_saved && !task.publication_status ? async () => {
        setBusy(true); setError('');
        try { await api(`${taskPath(task)}/runs/${latest.id}/interrupt`, 'POST', { state_version: task.state_version }); await refresh(); }
        catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      } : undefined} />}
    {latest?.description_revision === task.revision ? <AgentOutput key={latest.id} run={latest} load={() => api(`${taskPath(task)}/runs/${latest.id}/output`)} /> : <p className="hint">Сообщений агента пока нет.</p>}
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
    {latest?.review_plan && <div aria-label="План Review">{latest.review_plan.checks.map(check => <p key={check.role} className="meta">{stageNames[check.role]}: {check.reuse_run_id ? 'Предыдущий PASS применим' : check.required ? 'Обязателен' : 'Не требуется'} — {check.reason}</p>)}</div>}
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
    {!editing && ['backlog', 'build', 'review', 'approve'].includes(task.stage) && task.run_state === 'idle' && <button disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await api(`${taskPath(task)}/${task.stage === 'approve' ? 'approve' : task.stage === 'review' ? 'review' : task.stage === 'build' ? 'build' : 'start'}`, 'POST', { state_version: task.state_version, ...(task.stage === 'backlog' ? { spec_mode: specMode } : {}) }); await refresh(); }
      catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>{busy ? 'Ставим в очередь…' : task.stage === 'approve' ? 'Запустить Approve' : task.stage === 'review' ? 'Продолжить Review' : task.stage === 'build' ? 'Запустить Build' : 'Приступить к реализации'}</button>}
    {!editing && task.stage === 'needs-human' && task.run_state === 'interrupted' && latest && requiredReviews(latest).includes(latest.role as ReviewRole)
      && runs.at(-1)?.status === 'completed' && !runs.at(-1)?.stale && ['PASS', 'CHANGES'].includes(runs.at(-1)?.outcome ?? '') && <>
      <p>Approve не запущен: {stageNames[(blockingReview ?? latest).role]} требует доработок. Выполнено доработок: {latest.repair_attempt}/2.</p>
      <RunReport task={task} run={blockingReview ?? latest} />
      <button disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try { await api(`${taskPath(task)}/repair`, 'POST', { state_version: task.state_version }); await refresh(); }
        catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      }}>{busy ? 'Ставим в очередь…' : 'Доработать: новый цикл (до двух доработок)'}</button>
    </>}
    {!editing && questions.map(request => request.result.outcome === 'ESCALATE' ? <HumanDecision key={request.id} task={task} request={request} refresh={refresh} /> : <HumanQuestions key={`${request.id}-${request.status}`} task={task} request={request} refresh={refresh} resume={task.run_state === 'interrupted' && !task.execution_unverified && !task.publication_status && runs.at(-1)?.id === request.run_id && runs.at(-1)?.status === 'completed' && !!runs.at(-1)?.diagnostic?.execution_finished && !runs.at(-1)?.stale} />)}
    {task.run_state === 'interrupted' && !task.execution_unverified && runs.at(-1)?.status === 'failed' && runs.at(-1)?.diagnostic?.execution_finished && !task.publication_status && <button disabled={busy} onClick={async () => {
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
      {runs.some(run => run.role === role) ? <RunConversation runs={runs} role={role} revision={task.revision} path={taskPath(task)} api={api} messages={messages} requests={questions} active={active && tab === role} report={run => <RunReport task={task} run={run} />} /> : <p className="empty">Этот этап ещё не запускался.</p>}
    </div>)}
    {tab !== 'overview' && messages.filter(message => !message.run_id).map(message => <Message key={message.id} message={message} />)}
    {chatError && <p role="alert">{chatError}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <Composer task={task} path={taskPath(task)} api={api} refresh={refresh} />
    </fieldset>
  </article>;
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
  return <>{error && <p role="alert">{error}</p>}{revisions ? revisions.map(r => <div key={r.revision}><p className="meta">Версия требований: {r.revision} · {new Date(r.created_at).toLocaleString('ru')}</p><pre>{r.description}</pre></div>) : <p role="status">Загружаем историю…</p>}</>;
}

function RunReport({ task, run }: { task: Task; run: AgentRun }) {
  const [report, setReport] = useState('');
  const [log, setLog] = useState<{ text: string; next_offset: number; more: boolean }>({ text: '', next_offset: 0, more: true });
  const [logName, setLogName] = useState('events.jsonl');
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
    <summary>{run.report ? 'Отчёт' : 'Диагностика'} · {run.outcome ?? run.status}{run.stale || run.description_revision !== task.revision ? ' · Неактуален' : ''}{run.finished_at && ` · ${new Date(run.finished_at).toLocaleString('ru')}`}</summary>
    <p className="meta">Версия требований: {run.description_revision} · Модель: {run.config.models[run.role]}</p>
    <p className="meta">Доработки: {run.repair_attempt}/2 · {run.round_id && `Раунд: ${run.round_id}`} {run.spec_run_id && `Spec: ${run.spec_run_id}`}<br />{run.base_sha && `Base: ${run.base_sha}`}<br />{run.head_sha && `Head: ${run.head_sha}`}<br />Branch: {run.branch}<br />{run.worktree}</p>
    <p className="meta">Модели запуска: {allRoles.filter(role => run.config.models[role]).map(role => `${role}: ${run.config.models[role]} (${run.config.reasoning_efforts?.[role] ?? 'по умолчанию Codex'})`).join(' · ')}</p>
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
  </details>;
}
function ModelSettings({ project, refresh }: { project: Project; refresh: () => Promise<void> }) {
  const [config, setConfig] = useState<Settings | null>(null);
  const [version, setVersion] = useState(project.state_version);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<import('../shared.js').ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  async function refreshCatalog() {
    setLoading(true); setCatalogError('');
    try { setCatalog(await api(`/projects/${project.id}/models`)); }
    catch { setCatalogError('Не удалось получить каталог. Текущий выбор сохранён; доступен ручной ввод.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refreshCatalog(); }, [project.id]);
  async function reload() {
    setConfig(await api<Settings>(`/projects/${project.id}/settings`));
    setVersion(project.state_version);
  }
  useEffect(() => { reload().catch(error => setError(error.message)); }, [project.id]);
  return <details><summary>Модели и инструкции · {project.host}/{project.repository} · {project.checkout}</summary>
    {config && <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { await api(`/projects/${project.id}/settings`, 'PUT', { ...config, state_version: version }); setVersion(version + 1); await refresh(); }
      catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>
      <p role="status">{loading ? 'Получаем модели Codex…' : catalog ? `Источник: ${{ codex: 'Codex', cache: 'последний успешный каталог', defaults: 'встроенные настройки' }[catalog.source]}${catalog.updated_at ? ' · ' + new Date(catalog.updated_at).toLocaleString('ru') : ''}` : 'Каталог пока недоступен.'}</p>
      {(catalogError || catalog?.error) && <p role="alert">{catalogError || catalog?.error}</p>}
      <button type="button" className="secondary" disabled={loading} onClick={() => void refreshCatalog()}>Обновить список моделей</button>
      <div className="fields">{roles.map(role => <div key={role}>
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
      </div>)}</div>
      <label>Инструкции проекта<textarea maxLength={30000} value={config.instructions} onChange={event => setConfig({ ...config, instructions: event.target.value })} /></label>
      <p className="hint">Каталог Codex не гарантирует доступ к модели. Модель вне списка можно указать вручную. При смене модели глубина сбрасывается на «По умолчанию Codex». Конфигурация фиксируется при старте задачи; недоступная модель останавливает запуск без подмены.</p>
      {project.state_version !== version && <p role="status">Настройки изменились. Загрузите актуальную версию перед сохранением.</p>}
      <button disabled={busy || project.state_version !== version}>Сохранить настройки</button>{' '}
      <button type="button" className="secondary" disabled={busy} onClick={() => reload().catch(error => setError(error.message))}>Загрузить актуальные</button>
    </form>}{error && <p role="alert" className="error">{error}</p>}
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
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (ready && detailId && ![...snapshot.tasks, ...(snapshot.archived_tasks ?? [])].some(task => task.id === detailId)) {
      history.replaceState(null, '', location.pathname);
      setDetailId(''); setOpened(ids => ids.filter(id => id !== detailId));
      setNotice(value => value || 'Карточка архивирована или недоступна.');
    }
  }, [ready, snapshot, detailId]);
  const [connection, setConnection] = useState('Подключаемся к backend…');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [projectId, setProjectId] = useState('');
  const [filter, setFilter] = useState('');
  const [description, setDescription] = useState('');
  const [checkout, setCheckout] = useState('');
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
      setSnapshot(initial); setReady(true);
      events = new EventSource('/api/events');
      events.addEventListener('snapshot', event => { setSnapshot(JSON.parse((event as MessageEvent).data)); setConnection('Сохранено локально · Соединение активно'); });
      events.addEventListener('change', event => {
        const change = JSON.parse((event as MessageEvent).data);
        if (change.type === 'task.archived') setNotice('Карточка скрыта. Результат остановки и история доступны в архиве.');
        if (change.type === 'task.restored') setNotice('Карточка возвращена на доску. Исполнение автоматически не возобновляется.');
      });
      events.onerror = () => setConnection('Live-обновления недоступны. Переподключаемся. Это само по себе не означает остановку задачи. Обновите страницу, чтобы получить актуальное состояние');
    })().catch(error => { if (!disposed) { setError(error.message); setConnection('Подключение не выполнено'); } });
    return () => { disposed = true; events?.close(); };
  }, []);
  const visibleTasks = snapshot.tasks.filter(task => !filter || task.project_id === filter);
  const archived = (snapshot.archived_tasks ?? []).filter(task => !filter || task.project_id === filter);
  const unverified = (snapshot.archived_tasks ?? []).filter(task => task.deletion_state !== 'deleted');
  const selected = snapshot.projects.find(p => p.id === projectId) ?? snapshot.projects[0];
  return <main>
    <header><div><p className="eyebrow">LOCAL WORKSPACE</p><h1>SW Factory</h1></div><p className="connection" role="status">{connection}</p>
      <label className="theme">Тема<select value={theme} onChange={event => {
        const next = event.target.value as Theme;
        setTheme(next); applyTheme(next);
        try { localStorage.setItem('theme', next); } catch { /* The theme still works when storage is unavailable. */ }
      }}><option value="system">Системная</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label>
    </header>
    <p className="intro" hidden={!!detailId}>Из описания — в проверяемую спецификацию. Codex работает в отдельном worktree; закрытие вкладки не останавливает задачу.</p>
    {notice && <p role="status">{notice}</p>}
    {!!unverified.length && <p role="alert">В архиве {unverified.length} задач: остановка всех процессов не подтверждена. Проверьте раздел «Архив» на доске.</p>}
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
    <div className="setup">
      <section aria-labelledby="connect-title"><h2 id="connect-title">Подключить проект</h2>
        <form onSubmit={async event => {
          event.preventDefault(); if (!ready || busy || selectingFolder.current) return;
          const form = event.currentTarget; const fields = new FormData(form);
          setBusy('project'); setError('');
          try {
            const project = await api<Project>('/projects', 'POST', { ...Object.fromEntries(fields), state_version: 0 });
            await refresh(); setProjectId(project.id); form.reset(); setCheckout('');
          } catch (error) { setError((error as Error).message); } finally { setBusy(''); }
        }}>
          <label>Checkout<input name="checkout" required placeholder="/Users/you/projects/repository" value={checkout} disabled={busy === 'folder'} onChange={event => setCheckout(event.target.value)} /></label>
          <button type="button" className="secondary" disabled={!ready || !!busy} onClick={async () => {
            if (!ready || busy || selectingFolder.current) return;
            selectingFolder.current = true; setBusy('folder'); setError('');
            try {
              const result = await api<{ checkout: string | null }>('/projects/choose-folder', 'POST');
              if (result.checkout !== null) setCheckout(result.checkout);
            } catch (error) { setError((error as Error).message); }
            finally { selectingFolder.current = false; setBusy(''); }
          }}>{busy === 'folder' ? 'Выбираем папку…' : 'Выбрать папку…'}</button>
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
            {snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.host}/{p.repository} · {p.checkout} · {p.target_branch}</option>)}
          </select></label>
          <label>Описание<textarea required maxLength={100000} value={description} onChange={event => setDescription(event.target.value)} placeholder="Что нужно сделать?" /></label>
          <button disabled={!ready || !selected || !description.trim() || !!busy}>{busy === 'task' ? 'Сохраняем…' : 'Добавить в Backlog'}</button>
        </form>
      </section>
    </div>
    {!!snapshot.projects.length && <details className="projects"><summary>Подключённые проекты ({snapshot.projects.length})</summary>{snapshot.projects.map(p => <div key={p.id}>
      <strong>{p.host}/{p.repository}</strong>{' '}
      {p.hosting === 'github' && <IssueRefresh project={p} syncing={!!snapshot.issue_syncing?.includes(p.id)} />}
      <p>{p.checkout}</p><p>{p.hosting} · {p.remote} → {p.remote_url} · target: {p.target_branch}</p>
    </div>)}</details>}
    <section className="projects" aria-label="Настройки моделей">{snapshot.projects.map(project => <ModelSettings key={project.id} project={project} refresh={refresh} />)}</section>
    <section aria-label="Архив" className="projects"><h2>Архив ({archived.length})</h2>{archived.map(task => <ArchivedTask key={task.id} task={task} refresh={refresh} notify={setNotice} draft={drafts[task.id]} openTask={openTask} />)}{!archived.length && <p>Архив пуст.</p>}</section>
    <div className="board-heading"><h2>Доска <span>{visibleTasks.length}</span></h2><label>Проект <select value={filter} onChange={event => setFilter(event.target.value)}><option value="">Все проекты</option>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.host}/{p.repository} · {p.checkout}</option>)}</select></label></div>
    <div className="board" tabIndex={0} role="region" aria-label="Kanban, горизонтальная прокрутка">
      {stages.map((stage, index) => {
        const tasks = visibleTasks.filter(t => t.stage === stage);
        return <section key={stage} className={`column ${stage === 'needs-human' ? 'human' : ''}`} aria-label={labels[index]}><h2>{labels[index]} <span>{tasks.length}</span></h2>
          {tasks.length ? tasks.map(task => <article className="card" key={task.id}>
            <span className="project-name">{snapshot.projects.find(p => p.id === task.project_id)?.repository}</span>
            <SourceIssue task={task} />
            <h3>{task.title ?? `Задача ${task.id.slice(0, 8)}`}</h3><p className="meta">{{ idle: 'Ожидает запуска', queued: 'В очереди', running: 'В работе', waiting: 'Нужен ответ', interrupted: 'Нужна сверка', completed: 'Завершена' }[task.run_state]}</p>
            <p className="agent-preview">{task.description}</p>
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
        return task && project ? <TaskView key={id} hidden={id !== detailId} blocked={!!(task.archived || task.deletion_state)}>{task.archived || task.deletion_state ? <ArchivedTask task={task} refresh={refresh} notify={setNotice} expanded draft={drafts[id]} /> : <TaskCard task={task} project={project} runs={snapshot.runs.filter(run => run.task_id === id)} questions={snapshot.human_requests.filter(request => request.task_id === id)} refresh={refresh} active={id === detailId} cursor={snapshot.cursor} notify={setNotice} draft={drafts[id]} setDraft={draft => setTaskDraft(id, draft)} />}</TaskView> : null;
      })}
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
