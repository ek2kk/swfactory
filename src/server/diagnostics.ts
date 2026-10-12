import { Problem } from './store.js';
import type { FailureKind } from '../shared.js';

export class CodexFailure extends Problem {
  finished = false;
  constructor(public kind: FailureKind, public resetAt: string | null = null) {
    super(422, ({ authentication: 'Authentication: выполните codex login.', model_unavailable: 'Модель недоступна: проверьте доступ к выбранной модели.',
      rate_limit: 'Rate limit: новые запуски приостановлены до reset time или ручного продолжения.',
      protocol_error: 'Protocol error: проверьте CLI version и локальные логи.', missing_artifact: 'Missing artifact: обязательный результат отсутствует.' })[kind]);
  }
}
// Only classify CLI error envelopes/stderr, never agent messages or tool output.
export function classifyFailure(value: unknown): CodexFailure {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const kind = /rate_limit_exceeded|usage_limit_reached|rate limit|usage limit|quota exceeded|\b429\b/i.test(text) ? 'rate_limit'
    : /authentication|unauthorized|invalid_api_key|not authenticated|please (?:log|sign) in|\b401\b/i.test(text) ? 'authentication'
    : /model_not_found|model_not_available|unsupported_model|model.{0,100}(?:not available|not supported|does not exist)/i.test(text) ? 'model_unavailable' : 'protocol_error';
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const nested = data.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : data;
  const reset = nested.reset_at;
  const time = typeof reset === 'number' ? reset * 1000 : typeof reset === 'string' ? Date.parse(reset) : NaN;
  const retry = nested.retry_after;
  const at = Number.isFinite(time) ? time : typeof retry === 'number' && retry >= 0 ? Date.now() + retry * 1000 : NaN;
  return new CodexFailure(kind, kind === 'rate_limit' && Number.isFinite(new Date(at).getTime()) ? new Date(at).toISOString() : null);
}
export function redact(text: string) {
  for (const [name, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i.test(name) && value && value.length >= 4) text = text.split(value).join('[REDACTED]');
  }
  return text.replace(/(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
    .replace(/((?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}
