import type { RunDiagnostic } from './shared.js';

export type TokenUsage = { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
export const tokenFields = ['input_tokens', 'output_tokens', 'cached_input_tokens'] as const;
export type UsageAccounting = { version: 1; source: 'exec-turn' } | {
  version: 1; source: 'thread-total';
  baseline?: { session_id: string; usage: TokenUsage };
  latest?: { session_id: string; usage: TokenUsage };
  high_water?: TokenUsage;
  invalid?: boolean;
};
export function normalizeUsage(value: unknown): TokenUsage {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(tokenFields.filter(key => typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0).map(key => [key, usage[key]]));
}
export function threadUsageSnapshot(previous: Extract<UsageAccounting, { source: 'thread-total' }>, session_id: string, value: unknown): Extract<UsageAccounting, { source: 'thread-total' }> {
  const usage = normalizeUsage(value);
  const peak = normalizeUsage(previous.high_water ?? previous.latest?.usage ?? previous.baseline?.usage);
  const invalid = previous.invalid || previous.baseline?.session_id !== session_id
    || (previous.latest && previous.latest.session_id !== session_id)
    || tokenFields.some(key => usage[key] !== undefined && peak[key] !== undefined && usage[key]! < peak[key]!);
  const high_water = { ...peak, ...usage };
  return { ...previous, latest: { session_id, usage }, high_water, ...(invalid ? { invalid: true } : {}) };
}
export function observedUsage(diagnostic?: RunDiagnostic): TokenUsage {
  const accounting = diagnostic?.usage_accounting;
  // Historical snapshots have no proven source/baseline; never treat them as per-run totals.
  if (accounting?.version !== 1) return {};
  if (accounting.source === 'exec-turn') return normalizeUsage(diagnostic?.usage);
  const { baseline, latest } = accounting;
  if (accounting.invalid || !baseline || !latest || baseline.session_id !== latest.session_id) return {};
  const before = normalizeUsage(baseline.usage), after = normalizeUsage(latest.usage);
  if (tokenFields.some(key => before[key] !== undefined && after[key] !== undefined && after[key]! < before[key]!)) return {};
  return Object.fromEntries(tokenFields.filter(key => before[key] !== undefined && after[key] !== undefined)
    .map(key => [key, after[key]! - before[key]!]));
}
