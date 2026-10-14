import { allRoles, reviewRoles, reviewsFor, type AgentRun, type ChatMessage, type HumanRequest, type SavedEvent, type TranscriptEntry } from '../shared.js';

export const stageNames = { spec: 'Spec', build: 'Build', 'review-code': 'Review · Code', 'review-security': 'Review · Security', 'review-ui-ux': 'Review · UI/UX', 'review-ui': 'Review · UI', 'review-ux': 'Review · UX', approve: 'Approve' };
export function stageRoles(runs: AgentRun[]) {
  const latest = runs.at(-1);
  const current: readonly string[] = latest ? reviewsFor(latest.config) : reviewRoles;
  return allRoles.filter(role => !role.startsWith('review-') || current.includes(role) || runs.some(run => run.role === role));
}
const states = {
  idle: { label: 'Ещё не запускался', icon: '○' },
  queued: { label: 'В очереди', icon: '◷' },
  running: { label: 'Выполняется', icon: '▶' },
  success: { label: 'Успешно завершён', icon: '✓' },
  attention: { label: 'Нужно вмешательство', icon: '!' },
  stale: { label: 'Неактуальный результат', icon: '↺' },
};
export function stageStatus(runs: AgentRun[], revision: number, requests: HumanRequest[]) {
  const run = runs.at(-1);
  let state: keyof typeof states = 'idle';
  if (run) {
    if (run.stale || run.description_revision !== revision) state = 'stale';
    else if (run.status === 'queued' || run.status === 'running') state = run.status;
    else if (run.status === 'completed' && !requests.some(q => q.run_id === run.id && q.status === 'pending')
      && run.outcome === (run.role.startsWith('review-') ? 'PASS' : run.role === 'approve' ? 'APPROVE' : 'READY')) state = 'success';
    else state = 'attention';
  }
  const attention = run?.status === 'failed' ? 'Ошибка' : run?.status === 'interrupted' ? 'Остановлен — нужна сверка'
    : requests.some(q => q.run_id === run?.id && q.status === 'pending') ? 'Нужен ответ человека'
    : ({ NEEDS_INPUT: 'Нужен ответ человека', BLOCKED: 'Заблокирован', CHANGES: 'Нужна доработка', ESCALATE: 'Нужно решение человека' } as Record<string, string>)[run?.outcome ?? ''] ?? 'Нет успешного результата';
  return { state, ...states[state], ...(state === 'attention' ? { label: attention } : {}) };
}

export type HistoryItem = {
  id: string; at: string; kind: TranscriptEntry['kind'] | 'message' | 'report'; title: string; text: string;
  status?: string; run?: AgentRun; message?: ChatMessage; alert?: boolean;
  time: number; attempt: number; sequence: number; source: number;
};
const time = (at: string) => Date.parse(at) || 0;
const eventTitles: Record<string, string> = {
  'spec.decision': 'Решение о Spec',
  'run.interrupt-requested': 'Запрошена остановка', 'run.retried': 'Продолжение',
  'human.requested': 'Нужен ответ человека', 'human.answered': 'Ответ человека',
  'approve.decided': 'Решение человека', 'repair.queued': 'Доработка', 'repair.restarted': 'Продолжение после доработки',
  'task.interrupted': 'Работа остановлена', 'task.stop-verified-by-human': 'Ручная сверка',
  'task.execution-unblocked': 'Исполнение разблокировано', 'task.deletion-requested': 'Остановка исполнения',
  'task.deleted': 'Остановка подтверждена', 'task.deletion-failed': 'Остановка не подтверждена',
  'task.edited': 'Требования изменены', 'task.issue-updated': 'Обновление из GitHub', 'review.stale': 'Проверки неактуальны',
};

export function stageTimeline(runs: AgentRun[], transcripts: Record<string, TranscriptEntry[]>, messages: ChatMessage[], events: SavedEvent[], requests: HumanRequest[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const payloads = events.map(event => ({ event, payload: JSON.parse(event.payload) as Record<string, unknown> }));
  const queues = new Map<string, SavedEvent>();
  for (const { event, payload } of payloads) {
    if (typeof payload.run_id === 'string' && (event.type.endsWith('.queued') || event.type === 'run.retried' || event.type === 'repair.restarted')) queues.set(payload.run_id, event);
  }
  runs.forEach((run, attempt) => {
    let previousTime = time(queues.get(run.id)?.created_at ?? run.started_at ?? '');
    (transcripts[run.id] ?? []).forEach((entry, sequence) => {
      // Missing timestamps use saved order for sorting only; no invented date is displayed.
      previousTime = time(entry.at) || previousTime;
      items.push({ ...entry, id: `transcript:${entry.id}`, run, time: previousTime, attempt, sequence, source: 1 });
    });
  });
  messages.forEach((message, sequence) => {
    const attempt = runs.findIndex(run => run.id === message.run_id);
    if (attempt < 0) return;
    items.push({ id: `message:${message.id}`, at: message.created_at, time: time(message.created_at), attempt, sequence, source: 2,
      kind: 'message', title: 'Вы', text: message.text, message });
  });
  for (const { event, payload } of payloads) {
    let attempt = runs.findIndex(run => run.id === payload.run_id);
    if (attempt < 0 && !payload.run_id) {
      // Task-wide interventions belong to the last attempt that existed at the saved event.
      attempt = runs.findLastIndex(run => {
        const queued = queues.get(run.id);
        return queued ? queued.id <= event.id : !!run.started_at && time(run.started_at) <= time(event.created_at);
      });
    }
    if (attempt < 0) continue;
    const run = runs[attempt];
    const phase = event.type.split('.').at(-1)!;
    const lifecycle = ['queued', 'running', 'completed', 'failed', 'interrupted'].includes(phase) && payload.run_id && !event.type.startsWith('chat.');
    const title = eventTitles[event.type] ?? (lifecycle ? ({ queued: payload.parent_run_id ? 'Продолжение в очереди' : 'В очереди', running: 'Запуск', completed: 'Завершено', failed: 'Ошибка', interrupted: 'Остановлено' }[phase]) : undefined);
    if (!title) continue;
    const request = requests.find(q => q.id === payload.human_request_id);
    const text = [
      payload.reason, payload.error, payload.evidence,
      payload.revision != null ? `Версия требований: ${payload.revision}` : '',
      event.type === 'human.requested' && request ? [request.result.summary, ...request.result.questions.map(q => q.text)].join('\n') : '',
      event.type === 'human.answered' && request ? request.result.questions.map((q, i) => `${q.text}\n${request.answers?.[i] ?? ''}`).join('\n\n') : '',
      event.type === 'approve.decided' && request ? `${payload.decision === 'publish' ? 'Разрешена публикация PR/MR' : 'Отправлено на доработку'}\n${request.answers?.[1] ?? ''}` : '',
      event.type === 'run.retried' && run.diagnostic?.result_run_id ? 'По сохранённому результату; без нового вызова модели.' : '',
    ].filter(value => typeof value === 'string' && value).join('\n');
    items.push({ id: `event:${event.id}`, kind: 'event', at: event.created_at, time: time(event.created_at), attempt,
      sequence: event.id, source: phase === 'queued' || phase === 'running' ? 0 : 3, title, text,
      status: typeof payload.outcome === 'string' ? payload.outcome : undefined, run,
      alert: !!payload.error || ['human.requested', 'task.deletion-failed', 'review.stale'].includes(event.type),
    });
  }
  runs.forEach((run, attempt) => {
    if (run.error && !items.some(item => item.run?.id === run.id && item.text.includes(run.error!))) {
      items.push({ id: `error:${run.id}`, kind: 'event', title: 'Ошибка', text: run.error, alert: true,
        at: run.finished_at ?? '', time: time(run.finished_at ?? ''), attempt, sequence: 0, source: 3, run });
    }
    items.push({ id: `report:${run.id}`, kind: 'report', title: run.report ? 'Сохранённый отчёт' : 'Диагностика', text: '', run,
      at: run.finished_at ?? '', time: time(run.finished_at ?? ''), attempt, sequence: 0, source: 4 });
  });
  return items.sort((a, b) => b.time - a.time || b.attempt - a.attempt || b.source - a.source || b.sequence - a.sequence);
}
