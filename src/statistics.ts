import type { AgentRun, RunDiagnostic } from './shared.js';
import { normalizeUsage, observedUsage, type TokenUsage } from './usage.js';

export type StatisticsRun = Pick<AgentRun, 'id' | 'task_id' | 'project_id' | 'role' | 'status' | 'started_at' | 'finished_at'> & {
  usage: TokenUsage; execution: 'observed' | 'unknown';
};
export function statisticsRun(run: Pick<AgentRun, 'id' | 'task_id' | 'project_id' | 'role' | 'status' | 'started_at' | 'finished_at'> & { diagnostic?: RunDiagnostic }): StatisticsRun | null {
  const d = run.diagnostic;
  if (d?.result_run_id || run.status === 'queued') return null;
  const observed = !!(d?.model_started_at || d?.session_id || d?.usage);
  if (!observed && !run.started_at) return null;
  return { id: run.id, task_id: run.task_id, project_id: run.project_id, role: run.role, status: run.status,
    started_at: run.started_at, finished_at: run.finished_at, usage: observedUsage(d), execution: observed ? 'observed' : 'unknown' };
}
export type Period = 'today' | 'week' | 'all';
// Browser-local calendar arithmetic deliberately preserves midnight across DST changes.
export function periodBounds(period: Period, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - 6);
  return { start: period === 'all' ? null : start.getTime(), end: now.getTime() };
}
export const timestamp = (value?: string | null): number | null => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
export type Metric = { sum: bigint; known: number };
export function summarizeRuns(records: StatisticsRun[], bounds = { start: null as number | null, end: Date.now() }) {
  const runs = [...new Map(records.map(run => [run.id, { ...run, usage: normalizeUsage(run.usage) }])).values()];
  const running = runs.filter(run => run.execution === 'observed' && run.status === 'running');
  const terminal = runs.filter(run => run.status !== 'running' && run.status !== 'queued');
  const selected = terminal.filter(run => {
    const end = timestamp(run.finished_at);
    return end === null ? bounds.start === null : (bounds.start === null || end >= bounds.start) && end < bounds.end;
  });
  const completed = selected.filter(run => run.execution === 'observed');
  const metric = (values: (number | undefined | null)[]): Metric => {
    const known = values.filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
    return { sum: known.reduce((sum, value) => sum + BigInt(value), 0n), known: known.length };
  };
  const input = metric(completed.map(run => run.usage.input_tokens));
  const output = metric(completed.map(run => run.usage.output_tokens));
  const cached = metric(completed.map(run => run.usage.cached_input_tokens));
  const pairs = completed.filter(run => run.usage.input_tokens !== undefined && run.usage.output_tokens !== undefined);
  const total: Metric = { known: completed.filter(run => run.usage.input_tokens !== undefined || run.usage.output_tokens !== undefined).length, sum: input.sum + output.sum };
  const duration = metric(completed.map(run => {
    const start = timestamp(run.started_at), end = timestamp(run.finished_at);
    return start !== null && end !== null ? end - start : undefined;
  }));
  const calendarRuns = [...completed, ...running];
  const starts = calendarRuns.map(run => timestamp(run.started_at)).filter((v): v is number => v !== null);
  const ends = calendarRuns.map(run => run.status === 'running' ? bounds.end : timestamp(run.finished_at)).filter((v): v is number => v !== null);
  return { completed, selected, running, count: completed.length, usageKnown: pairs.length, input, output, cached, total, duration,
    excludedUnknownTime: bounds.start === null ? 0 : terminal.filter(run => run.execution === 'observed' && timestamp(run.finished_at) === null).length,
    unknownTime: completed.filter(run => timestamp(run.finished_at) === null).length,
    unknownExecution: selected.filter(run => run.execution === 'unknown').length,
    calendar: starts.length && ends.length ? { start: starts.reduce((min, value) => Math.min(min, value)), end: ends.reduce((max, value) => Math.max(max, value)), partial: starts.length !== calendarRuns.length || ends.length !== calendarRuns.length } : null };
}
export function formatDuration(ms: bigint | number) {
  let seconds = BigInt(ms) / 1000n;
  const days = seconds / 86400n; seconds %= 86400n;
  const hours = seconds / 3600n; seconds %= 3600n;
  const minutes = seconds / 60n; seconds %= 60n;
  return [days ? `${days} д` : '', hours ? `${hours} ч` : '', minutes ? `${minutes} мин` : '', `${seconds} с`].filter(Boolean).join(' ');
}
