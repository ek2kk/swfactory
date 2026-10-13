import { Problem } from './store.js';
import type { FailureKind } from '../shared.js';

export class CodexFailure extends Problem {
  finished = false;
  constructor(public kind: FailureKind, public resetAt: string | null = null) {
    super(422, ({ authentication: 'Authentication: выполните codex login.', model_unavailable: 'Модель недоступна: проверьте доступ к выбранной модели.',
      rate_limit: 'Rate limit: новые запуски приостановлены до reset time или ручного продолжения.',
      interrupted: 'Этап прерван пользователем. Частичные изменения сохранены; результат не засчитан.',
      protocol_error: 'Protocol error: проверьте CLI version и локальные логи.', missing_artifact: 'Missing artifact: обязательный результат отсутствует.' })[kind]);
  }
}
// Only classify CLI error envelopes/stderr, never agent messages or tool output.
export function classifyFailure(value: unknown): CodexFailure {
  if (typeof value === 'string') {
    // exec stderr includes banners and the user's prompt; only the final diagnostic is evidence.
    const lines = [value, ...value.split('\n').reverse()];
    value = {};
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && (parsed.error || parsed.code || parsed.status || parsed.status_code || ['error', 'turn.failed'].includes(parsed.type))) { value = parsed; break; }
      } catch { /* Not a structured diagnostic. */ }
      const message = /^ERROR:\s*(.*)$/i.exec(line.trim())?.[1];
      if (message !== undefined) {
        try { value = JSON.parse(message); } catch { value = { message }; }
        break;
      }
    }
  }
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const nested = data.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : data;
  const text = typeof nested.message === 'string' ? nested.message : typeof data.error === 'string' ? data.error : '';
  const codes: Record<string, FailureKind> = { rate_limit_exceeded: 'rate_limit', usage_limit_reached: 'rate_limit', insufficient_quota: 'rate_limit',
    invalid_api_key: 'authentication', authentication_error: 'authentication', unauthorized: 'authentication',
    model_not_found: 'model_unavailable', model_not_available: 'model_unavailable', unsupported_model: 'model_unavailable' };
  const code = typeof nested.code === 'string' ? nested.code : typeof nested.type === 'string' ? nested.type : '';
  const status = nested.status ?? nested.status_code ?? data.status ?? data.status_code
    ?? /^(?:(?:unexpected )?status(?: code)?[:=]?\s+|HTTP(?:\/\d(?:\.\d)?)?\s+)?(401|403|429)\b/i.exec(text)?.[1];
  const kind = Object.hasOwn(codes, code) ? codes[code]
    : status === 401 || status === '401' || status === 403 || status === '403' ? 'authentication'
    : status === 429 || status === '429' ? 'rate_limit'
    : /authentication|unauthorized|invalid_api_key|not authenticated|please (?:log|sign) in/i.test(text) ? 'authentication'
    : /model.{0,100}(?:not available|not supported|does not exist)/i.test(text) ? 'model_unavailable'
    : /rate_limit_exceeded|usage_limit_reached|rate limit (?:reached|exceeded)|(?:hit|reached|exceeded) (?:your |the )?(?:usage|rate) limit|usage limit (?:reached|exceeded)|quota exceeded/i.test(text) ? 'rate_limit' : 'protocol_error';
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
    .replace(/((?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED]$2')
    .replace(/((?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}

// Redact decoded values, never JSON syntax; agent_message.text may itself be JSON.
export function redactStructured(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      const nested: unknown = JSON.parse(value);
      if (nested && typeof nested === 'object') return JSON.stringify(redactStructured(nested));
    } catch { /* Ordinary text, including quoted configuration examples. */ }
    return redact(value);
  }
  if (Array.isArray(value)) return value.map(redactStructured);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /(?:password|secret|token|api[_-]?key)$/i.test(key) && typeof item === 'string' ? '[REDACTED]' : redactStructured(item)]));
  return value;
}
