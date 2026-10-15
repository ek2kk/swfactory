import { useEffect, useState } from 'react';
import type { AgentRun, Snapshot } from '../shared.js';
import { formatDuration, periodBounds, statisticsRun, summarizeRuns, timestamp, type Metric, type Period, type StatisticsRun } from '../statistics.js';
import { stageNames } from './stageHistory.js';

const number = (value: bigint | number) => value.toLocaleString('ru-RU');
const date = (value: number) => new Date(value).toLocaleString('ru-RU');
function metric(value: Metric, count: number, duration = false, partial = false) {
  if (!value.known) return 'неизвестно';
  return `${duration ? formatDuration(value.sum) : number(value.sum)}${value.known < count || partial ? ' · частично' : ''}`;
}
function useClock(running: boolean, active: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running || !active) return;
    const timer = setInterval(() => tick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running, active]);
  return Date.now();
}
function Totals({ summary }: { summary: ReturnType<typeof summarizeRuns> }) {
  return <>
    <dl className="statistics-totals">
      {([['Input', summary.input], ['Output', summary.output], ['Cached input (в составе input)', summary.cached], ['Input + output', summary.total], ['Суммарная длительность runs', summary.duration]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{metric(value, summary.count, value === summary.duration, value === summary.total && summary.usageKnown < summary.count)}</dd></div>)}
    </dl>
    <p className="meta">Завершённых запусков: {summary.count}. Usage известно для {summary.usageKnown} из {summary.count}; cached — {summary.cached.known} из {summary.count}; длительность — {summary.duration.known} из {summary.count}.</p>
    {!!summary.unknownTime && <p className="meta">Время завершения неизвестно для {summary.unknownTime} runs; они доступны только во «Всё время».</p>}
  </>;
}
export function StatisticsNotes() {
  return <details className="statistics-notes"><summary>Что учитывается</summary>
    <p className="meta">Наблюдаемые AgentRun всех попыток, revisions и этапов, включая failed/interrupted и chat guidance внутри измеряемого turn. Reused PASS и продолжение по сохранённому результату не создают расход. Cached входит в input и не прибавляется повторно. Неподтверждённые исторические метрики неизвестны.</p>
    <p className="meta">Длительность run может включать внутренние паузы, работу tools и backend; это не активное время модели. При параллельных reviews сумма длительностей может быть больше календарного интервала. Очередь между runs и ожидание ответа человека между запусками не входят в сумму.</p>
    <p className="meta">Источник — доступные сохранённые runs, включая архив. Очистка результатов и удаление задач меняют статистику: это не неизменяемый учёт за всё время, не стоимость и не остаток лимита подписки.</p>
    <p className="meta">Не учтены генерация title, автоматический выбор Spec, LLM-вызовы диагностики и проверки зависимостей через generateText и другие служебные расходы без сбора usage.</p>
  </details>;
}
export function RunStatistics({ records, active = true, calendar = false, breakdown = false, bounds }: {
  records?: StatisticsRun[]; active?: boolean; calendar?: boolean; breakdown?: boolean; bounds?: { start: number | null; end: number };
}) {
  const now = useClock(!!records?.some(run => run.status === 'running' && run.execution === 'observed'), active);
  if (!records) return <p role="status">Статистика недоступна: нет сохранённых метрик. Обновите подключение к backend.</p>;
  const summary = summarizeRuns(records, bounds ?? { start: null, end: now });
  return <section className="run-statistics" aria-label="Расход токенов и времени">
    {summary.count ? <Totals summary={summary} /> : <p className="empty">За выбранный период нет завершённых наблюдаемых запусков.</p>}
    {!!summary.excludedUnknownTime && <p className="meta">Не включены в период: {summary.excludedUnknownTime} runs с неизвестным finished_at. Они доступны во «Всё время».</p>}
    {!!summary.unknownExecution && <p className="meta">Ещё {summary.unknownExecution} записей без подтверждения запуска CLI: не включены в число runs и totals.</p>}
    {calendar && (summary.calendar ? <p className="meta">Календарный интервал наблюдаемых запусков: {date(summary.calendar.start)} — {date(summary.calendar.end)} · {formatDuration(Math.max(0, summary.calendar.end - summary.calendar.start))}{summary.calendar.partial ? ' · границы частичные' : ''}.</p> : <p className="meta">Календарный интервал наблюдаемых запусков неизвестен.</p>)}
    {!!summary.running.length && <div className="statistics-running"><h4>Выполняются сейчас · вне завершённых totals</h4>{summary.running.map(run => {
      const start = timestamp(run.started_at);
      const partial = summarizeRuns([{ ...run, status: 'completed', finished_at: null }]);
      return <div key={run.id}><p>{stageNames[run.role]} · {run.id.slice(0, 8)} · elapsed {start === null ? 'неизвестен' : formatDuration(Math.max(0, now - start))}</p><p className="meta">Предварительно: input {metric(partial.input, 1)}, output {metric(partial.output, 1)}, cached {metric(partial.cached, 1)}, input + output {metric(partial.total, 1, false, partial.usageKnown < 1)}.</p></div>;
    })}</div>}
    {breakdown && !!summary.completed.length && <details><summary>Разбивка по этапам</summary>{[...new Set(summary.completed.map(run => run.role))].map(role => <section key={role}><h4>{stageNames[role]}</h4><Totals summary={summarizeRuns(summary.completed.filter(run => run.role === role), bounds ?? { start: null, end: now })} /></section>)}</details>}
  </section>;
}
export function TaskStatistics({ runs, active }: { runs: AgentRun[]; active: boolean }) {
  return <div className="task-statistics"><h4>Токены и время · все попытки</h4><RunStatistics records={runs.flatMap(run => { const record = statisticsRun(run); return record ? [record] : []; })} active={active} calendar breakdown /><StatisticsNotes /></div>;
}
export function StatisticsWindow({ snapshot, initialProject }: { snapshot: Snapshot; initialProject: string }) {
  const [project, setProject] = useState(initialProject);
  const [period, setPeriod] = useState<Period>('today');
  useEffect(() => { if (project && !snapshot.projects.some(item => item.id === project)) setProject(''); }, [project, snapshot.projects]);
  const records = snapshot.statistics_runs?.filter(run => !project || run.project_id === project);
  const now = useClock(!!records?.some(run => run.status === 'running'), true);
  const bounds = periodBounds(period, new Date(now));
  const selected = records && summarizeRuns(records, bounds);
  const tasks = [...snapshot.tasks, ...(snapshot.archived_tasks ?? [])].filter(task => (!project || task.project_id === project)
    && (selected?.selected.some(run => run.task_id === task.id) || selected?.running.some(run => run.task_id === task.id)));
  return <div className="statistics-window">
    <div className="statistics-filters"><label>Проект<select data-initial-focus value={project} onChange={event => setProject(event.target.value)}><option value="">Все проекты</option>{snapshot.projects.map(item => <option key={item.id} value={item.id}>{item.host}/{item.repository} · {item.checkout}</option>)}</select></label>
      <label>Период<select value={period} onChange={event => setPeriod(event.target.value as Period)}><option value="today">Сегодня</option><option value="week">Последние 7 дней</option><option value="all">Всё время</option></select></label></div>
    <p className="meta">Timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Интервал [{bounds.start === null ? 'без нижней границы' : date(bounds.start)}, {date(bounds.end)}). Завершённый run целиком относится к finished_at; поминутный расход не рассчитывается.</p>
    <RunStatistics records={records} bounds={bounds} />
    {!!tasks.length && <div><h3>По задачам</h3>{tasks.map(task => <details key={task.id} className="statistics-task"><summary>{task.title ?? `Задача ${task.id.slice(0, 8)}`}{task.archived ? ' · архив' : ''} · {snapshot.projects.find(item => item.id === task.project_id)?.repository}</summary><RunStatistics records={records?.filter(run => run.task_id === task.id)} bounds={bounds} calendar breakdown /></details>)}</div>}
    <StatisticsNotes />
  </div>;
}
