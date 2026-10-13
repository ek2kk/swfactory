import { execFile, spawn } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { saveArtifact } from './artifacts.js';
import { CodexFailure, classifyFailure, redact, redactStructured } from './diagnostics.js';
import type { CodexInput } from './codex.js';

export class DeliveryError extends Error {
  constructor(public status: 'failed' | 'unknown', message: string) { super(message); }
}
export type Steer = (id: string, text: string) => Promise<void>;

// One app-server and one turn occupy the existing scheduler slot until process close.
export async function executeInteractive<T>(input: CodexInput, schema: object, validate: (value: unknown) => T, executable: string): Promise<T> {
  const version = await new Promise<string | undefined>(resolve => {
    const child = execFile(executable, ['--version'], { cwd: input.cwd, timeout: 2000, maxBuffer: 4096 }, (error, out) => resolve(!error && /^codex[- ]cli [\w.+-]+\s*$/.test(out) ? out.trim() : undefined));
    child.stdin?.end();
  });
  input.metadata?.({ cli_version: version });
  saveArtifact(input.directory, 'schema.json', JSON.stringify(schema));
  const out = openSync(join(input.directory, 'events.jsonl'), 'wx', 0o600);
  let err: number;
  try { err = openSync(join(input.directory, 'stderr.log'), 'wx', 0o600); }
  catch (error) { closeSync(out); throw error; }
  try {
    saveArtifact(input.directory, 'log-format.json', JSON.stringify({ format: 'redacted-v1' }));
    return await new Promise<T>((resolve, reject) => {
      const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      let sequence = 0, buffer = '', stderr = '', bytes = 0, threadId = '', turnId = '', message = '';
      let finished = false, failure: Error | undefined, result: T;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; method: string }>();
      function stop(error?: Error) {
        failure ??= error;
        input.control?.(null);
        if (!killTimer) {
          child.stdin.end();
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
        }
      }
      function send(value: unknown) { child.stdin.write(JSON.stringify(value) + '\n'); }
      function rpc(method: string, params: object): Promise<any> {
        if (finished || failure || child.stdin.destroyed) return Promise.reject(new DeliveryError('failed', 'Активный turn завершён. Сообщение не передано.'));
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new DeliveryError('unknown', 'Нет подтверждения CLI. Не повторяем доставку автоматически.')); }, 30_000);
          pending.set(id, { resolve, reject, timer, method });
          send({ id, method, params });
        });
      }
      const steer: Steer = async (id, text) => {
        if (!turnId || finished) throw new DeliveryError('failed', 'Активный turn завершён. Сообщение не передано.');
        const expectedTurnId = turnId;
        const response = await rpc('turn/steer', { threadId, expectedTurnId, clientUserMessageId: id, input: [{ type: 'text', text }] });
        if (response.turnId !== expectedTurnId) throw new DeliveryError('unknown', 'CLI подтвердил другой turn. Нужна сверка.');
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (failure) return;
        try {
          bytes += Buffer.byteLength(chunk);
          // shortcut: keep the existing 32 MiB run limit; add rotation for larger transcripts.
          if (bytes > 32 * 1024 * 1024) throw new Error('Log limit');
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            // RPC replies may contain full configuration. Persist notifications only.
            if (['item/started', 'item/completed', 'turn/started', 'turn/completed', 'error'].includes(event.method) && event.id === undefined) writeSync(out, JSON.stringify({ ...redactStructured(event) as object, recorded_at: new Date().toISOString() }) + '\n');
            if (event.id !== undefined && !event.method) {
              const request = pending.get(event.id);
              if (request) {
                clearTimeout(request.timer); pending.delete(event.id);
                if (event.error) request.reject(request.method === 'turn/steer' ? new DeliveryError('failed', 'CLI отклонил сообщение. Активный turn мог завершиться.') : classifyFailure(event.error));
                else request.resolve(event.result);
              }
              continue;
            }
            if (event.id !== undefined && event.method) {
              send({ id: event.id, error: { code: -32601, message: 'Interactive approvals are not supported by this runner' } });
              throw new Error('Unexpected server request');
            }
            const p = event.params;
            if (p?.threadId !== threadId) continue;
            if (event.method === 'thread/tokenUsage/updated' && p.tokenUsage?.total) {
              const usage = p.tokenUsage.total;
              input.metadata?.({ usage: Object.fromEntries([['input_tokens', usage.inputTokens], ['output_tokens', usage.outputTokens], ['cached_input_tokens', usage.cachedInputTokens]].filter(([, value]) => Number.isSafeInteger(value) && Number(value) >= 0)) });
            }
            if (event.method === 'turn/started') {
              turnId = p.turn.id;
              input.control?.(steer);
            }
            if (event.method === 'item/completed' && p.item?.type === 'agentMessage') {
              message = p.item.text;
              if (typeof message !== 'string') throw new Error('Invalid message');
              if (message.trim()) input.output?.(message);
            }
            if (event.method === 'error' && !p.willRetry) throw classifyFailure(p.error);
            if (event.method === 'turn/completed') {
              if (p.turn.id !== turnId) throw new Error('Wrong turn');
              finished = true;
              if (p.turn.status !== 'completed') throw classifyFailure(p.turn.error);
              if (!message) throw new CodexFailure('missing_artifact');
              result = validate(JSON.parse(message));
              stop();
            }
          }
          if (buffer.length > 2 * 1024 * 1024) throw new Error('Event limit');
        } catch (error) { stop(error instanceof CodexFailure ? error : new CodexFailure('protocol_error')); }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        try {
          bytes += Buffer.byteLength(chunk); if (bytes > 32 * 1024 * 1024) throw new Error('Log limit');
          stderr += chunk;
          let newline: number;
          while ((newline = stderr.indexOf('\n')) >= 0) { writeSync(err, redact(stderr.slice(0, newline)) + '\n'); stderr = stderr.slice(newline + 1); }
        } catch { stop(new CodexFailure('protocol_error')); }
      });
      child.on('error', () => stop(new CodexFailure('protocol_error')));
      child.stdin.on('error', () => { if (!finished) stop(new CodexFailure('protocol_error')); });
      child.on('close', () => {
        clearTimeout(killTimer); input.control?.(null);
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new DeliveryError('unknown', 'Соединение с CLI закрыто без подтверждения доставки.')); }
        pending.clear();
        try { if (stderr) writeSync(err, redact(stderr)); } catch { failure = new CodexFailure('protocol_error'); }
        if (!finished || buffer.trim()) failure ??= new CodexFailure('protocol_error');
        if (failure instanceof CodexFailure) failure.finished = true;
        if (failure) reject(failure); else resolve(result!);
      });
      void (async () => {
        await rpc('initialize', { clientInfo: { name: 'swfactory', title: 'SW Factory', version: '0.1.0' } });
        send({ method: 'initialized', params: {} });
        const response = await rpc('thread/start', { cwd: input.cwd, model: input.model, approvalPolicy: 'never', sandbox: 'danger-full-access' });
        threadId = response.thread.id;
        input.metadata?.({ session_id: threadId });
        await rpc('turn/start', { threadId, input: [{ type: 'text', text: input.prompt }], outputSchema: schema });
      })().catch(error => { if (!finished) stop(error instanceof CodexFailure ? error : new CodexFailure('protocol_error')); });
    });
  } finally { closeSync(out); closeSync(err); }
}
