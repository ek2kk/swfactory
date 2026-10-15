import type { FastifyServerOptions } from 'fastify';
import type { Writable } from 'node:stream';
import { CodexFailure } from './diagnostics.js';

// Error messages, stacks and child_process fields can contain the entire prompt.
export function errorKind(error: unknown): string {
  if (error instanceof CodexFailure) return error.kind;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && ['ENOENT', 'EACCES', 'ENOSPC', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_BUSY', 'ABORT_ERR'].includes(code)
    ? code : 'internal_error';
}

export function loggerOptions(secrets: string[], stream?: Writable): FastifyServerOptions['logger'] {
  function redact(value: string) {
    const known = [...secrets, ...Object.entries(process.env)
      .filter(([key]) => /token|secret|password|credential|api_?key|private_?key/i.test(key)).map(([, value]) => value ?? '')];
    for (const secret of known.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(secret).join('[REDACTED]');
    return value.replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, '[REDACTED]')
      .replace(/(token|password|secret|api_key)=\S+/gi, '$1=[REDACTED]');
  }
  const allowed = new Set(['event', 'project_id', 'task_id', 'run_id', 'role', 'http_request_id', 'request_id',
    'method', 'route', 'status', 'duration_ms', 'queue_wait_ms', 'active', 'queued', 'limit', 'reason',
    'outcome', 'error_kind', 'stage', 'run_state', 'execution_finished', 'pid', 'pgid', 'exit_code', 'signal',
    'reset_at', 'state_confirmed', 'publication_status']);
  function fields(value: object) {
    return Object.fromEntries(Object.entries(value).filter(([key, value]) => allowed.has(key)
      && (value === null || ['string', 'number', 'boolean'].includes(typeof value)))
      .map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value]));
  }
  return {
    level: process.env.LOG_LEVEL ?? 'info', ...(stream ? { stream } : {}),
    // Defence in depth; callers only supply allowlisted scalar metadata.
    redact: ['req', 'res', 'headers', 'body', 'token', 'password', 'prompt', 'config'],
    serializers: {
      // Pino resets the bindings formatter in children; serializers also protect child fields.
      ...Object.fromEntries([...allowed].map(key => [key, (value: unknown) => typeof value === 'string' ? redact(value)
        : value === null || typeof value === 'number' || typeof value === 'boolean' ? value : undefined])),
      req: () => ({}), res: () => ({}), err: error => ({ type: errorKind(error), message: '', stack: '' }),
    },
    formatters: { log: fields, bindings: fields },
    // Fastify may supply a raw error as msg even with safe serializers.
    hooks: { logMethod(args, method) { method.call(this, fields(typeof args[0] === 'object' && args[0] !== null ? args[0] : {})); } },
  };
}
