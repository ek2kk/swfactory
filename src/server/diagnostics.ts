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
  if (kind !== 'rate_limit' && /service[_ ]?tier|fast mode/i.test(code + ' ' + text)) {
    const error = new CodexFailure(kind);
    error.message = /account|plan|not allowed|permission|workspace/i.test(text) ? 'Codex отклонил Fast: режим недоступен аккаунту или workspace. Запуск остановлен без fallback.'
      : /model/i.test(text) ? 'Codex отклонил Fast: модель не поддерживает выбранный режим. Запуск остановлен без fallback.'
      : 'Codex отклонил service tier: версия CLI или конфигурация не поддерживает выбранный режим. Запуск остановлен без fallback.';
    return error;
  }
  const reset = nested.reset_at;
  const time = typeof reset === 'number' ? reset * 1000 : typeof reset === 'string' ? Date.parse(reset) : NaN;
  const retry = nested.retry_after;
  const at = Number.isFinite(time) ? time : typeof retry === 'number' && retry >= 0 ? Date.now() + retry * 1000 : NaN;
  return new CodexFailure(kind, kind === 'rate_limit' && Number.isFinite(new Date(at).getTime()) ? new Date(at).toISOString() : null);
}
