import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { SpecResult, BuildResult, ReviewResult, ReviewRole } from '../shared.js';
import { parseTitle } from './title.js';
import { Problem } from './store.js';
import { saveArtifact } from './artifacts.js';

const list = { type: 'array', items: { type: 'string' } };
export const specSchema = {
  type: 'object', additionalProperties: false,
  properties: { title: { type: 'string' }, outcome: { enum: ['READY', 'NEEDS_INPUT'] }, summary: { type: 'string' },
    requirements: list, acceptance_criteria: list, assumptions: list, out_of_scope: list, questions: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string' }, context: { type: 'string' }, impact: { type: 'string' }, options: list, required: { type: 'boolean' } },
      required: ['text', 'context', 'impact', 'options', 'required'],
    } } },
  required: ['title', 'outcome', 'summary', 'requirements', 'acceptance_criteria', 'assumptions', 'out_of_scope', 'questions'],
};
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function validQuestions(value: unknown) {
  return Array.isArray(value) && value.length <= 20 && value.every(q =>
    q && typeof q === 'object' && Object.keys(q).sort().join() === 'context,impact,options,required,text'
    && nonempty(q.text) && nonempty(q.context) && nonempty(q.impact) && typeof q.required === 'boolean'
    && Array.isArray(q.options) && q.options.every(nonempty));
}
export function validateSpec(value: unknown): SpecResult {
  const result = value as SpecResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join() !== [...specSchema.required].sort().join()
    || !['READY', 'NEEDS_INPUT'].includes(result.outcome) || !nonempty(result.summary)
    || !['requirements', 'acceptance_criteria', 'assumptions', 'out_of_scope'].every(key => {
      const values = result[key as keyof SpecResult];
      return Array.isArray(values) && values.every(nonempty);
    }) || !validQuestions(result.questions) || (result.outcome === 'READY' && (!result.requirements.length || !result.acceptance_criteria.length || result.questions.length))
    || (result.outcome === 'NEEDS_INPUT' && !result.questions.length)) throw new Problem(422, 'Codex вернул невалидный результат. Переход заблокирован.');
  try { parseTitle({ title: result.title }); }
  catch { throw new Problem(422, 'Codex вернул невалидный заголовок Spec. Переход заблокирован.'); }
  return { ...result, title: result.title.trim() };
}
export type CodexInput = { cwd: string; directory: string; model: string; prompt: string };
export type ExecuteSpec = (input: CodexInput) => Promise<SpecResult>;

export function executeSpec(input: CodexInput, executable = 'codex') {
  return executeResult(input, specSchema, validateSpec, executable);
}
export type ExecuteBuild = (input: CodexInput) => Promise<BuildResult>;
export function executeBuild(input: CodexInput, executable = 'codex') {
  return executeResult(input, buildSchema, validateBuild, executable);
}
async function executeResult<T>(input: CodexInput, schema: object, validate: (value: unknown) => T, executable: string): Promise<T> {
  saveArtifact(input.directory, 'schema.json', JSON.stringify(schema));
  const stdout = openSync(join(input.directory, 'events.jsonl'), 'wx', 0o600);
  let stderr: number;
  try { stderr = openSync(join(input.directory, 'stderr.log'), 'wx', 0o600); }
  catch (error) { closeSync(stdout); throw error; }
  try {
    return await new Promise<T>((resolve, reject) => {
      const child = spawn(executable, ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox',
        '--model', input.model, '--output-schema', join(input.directory, 'schema.json'), '--color', 'never', '-'],
      { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      let buffer = '', message = '', started = false, completed = false, thread = false, failed: Error | undefined;
      // shortcut: logs are capped at 32 MiB per run; add rotation for larger workloads.
      let bytes = 0;
      function fail(error: Error) { failed ??= error; child.kill('SIGTERM'); }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (failed) return;
        try {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 32 * 1024 * 1024) throw new Problem(422, 'Поток Codex превысил 32 MiB. Нужна ручная проверка.');
          writeSync(stdout, chunk);
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (typeof event?.type !== 'string' || completed) throw new Error('Invalid stream');
            if (event.type === 'thread.started') thread = true;
            if (event.type === 'turn.started') { if (started || !thread) throw new Error('Invalid turn'); started = true; }
            if (event.type === 'error' || event.type === 'turn.failed') throw new Problem(422, `Codex не выполнил запрос модели ${input.model}. Проверьте доступ к модели, авторизацию и локальный stderr.log; замены модели нет.`);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text;
            if (event.type === 'turn.completed') { if (!started || !message) throw new Error('Incomplete turn'); completed = true; }
          }
          if (buffer.length > 2 * 1024 * 1024) throw new Error('Oversized event');
        } catch (error) { fail(error instanceof Problem ? error : new Problem(422, 'Невалидный JSONL stream Codex. Переход заблокирован.')); }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (failed) return;
        try { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error(); writeSync(stderr, chunk); }
        catch { fail(new Problem(422, 'Не удалось сохранить лог Codex или превышен лимит 32 MiB.')); }
      });
      child.on('error', () => { failed = new Problem(422, 'Не удалось запустить Codex. Проверьте CLI и checkout.'); });
      child.stdin.on('error', () => { failed ??= new Problem(422, 'Codex не принял prompt. Проверьте CLI и локальные логи.'); });
      child.on('close', code => {
        if (failed) return reject(failed);
        if (code !== 0 || !completed || buffer.trim()) return reject(new Problem(422, `Codex завершился с ошибкой или неполным stream (модель ${input.model}). Проверьте CLI, доступ к модели и локальные логи. Переход заблокирован.`));
        try { resolve(validate(JSON.parse(message))); }
        catch { reject(new Problem(422, 'Codex вернул невалидный результат. Переход заблокирован.')); }
      });
      child.stdin.end(input.prompt);
    });
  } finally { closeSync(stdout); closeSync(stderr); }
}

export const buildSchema = {
  type: 'object', additionalProperties: false,
  properties: { outcome: { enum: ['READY', 'NEEDS_INPUT', 'BLOCKED'] }, summary: { type: 'string' },
    changed_paths: list, actions: list, checks: list, questions: specSchema.properties.questions },
  required: ['outcome', 'summary', 'changed_paths', 'actions', 'checks', 'questions'],
};
export function validateBuild(value: unknown): BuildResult {
  const result = value as BuildResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join() !== [...buildSchema.required].sort().join()
    || !['READY', 'NEEDS_INPUT', 'BLOCKED'].includes(result.outcome) || !nonempty(result.summary)
    || !validQuestions(result.questions) || (result.outcome === 'NEEDS_INPUT' ? !result.questions.length : result.questions.length > 0)
    || !['changed_paths', 'actions', 'checks'].every(key => {
      const items = result[key as 'changed_paths'];
      return Array.isArray(items) && items.every(v => typeof v === 'string' && v.trim().length > 0);
    }) || (result.outcome === 'READY' && (!result.changed_paths.length || !result.actions.length || !result.checks.length))
    || new Set(result.changed_paths).size !== result.changed_paths.length) throw new Problem(422, 'Невалидный Build.');
  return result;
}

export const reviewSchema = {
  type: 'object', additionalProperties: false,
  properties: { outcome: { enum: ['PASS', 'CHANGES', 'NEEDS_INPUT', 'BLOCKED'] }, summary: { type: 'string' },
    findings: list, evidence: list, applicable: { type: 'boolean' }, applicability: { type: 'string' }, questions: specSchema.properties.questions },
  required: ['outcome', 'summary', 'findings', 'evidence', 'applicable', 'applicability', 'questions'],
};
export function validateReview(value: unknown, role?: ReviewRole): ReviewResult {
  const result = value as ReviewResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join() !== [...reviewSchema.required].sort().join()
    || !['PASS', 'CHANGES', 'NEEDS_INPUT', 'BLOCKED'].includes(result.outcome) || !nonempty(result.summary)
    || !validQuestions(result.questions) || (result.outcome === 'NEEDS_INPUT' ? !result.questions.length : result.questions.length > 0)
    || !['findings', 'evidence'].every(key => Array.isArray(result[key as 'findings']) && result[key as 'findings'].every(nonempty))
    || typeof result.applicable !== 'boolean' || typeof result.applicability !== 'string'
    || (!result.applicable && (!nonempty(result.applicability) || (role && !['review-ui', 'review-ux'].includes(role))))
    || (result.outcome === 'PASS' && (result.findings.length > 0 || (result.applicable && !result.evidence.length)))
    || (result.outcome === 'CHANGES' && !result.findings.length)) throw new Problem(422, 'Невалидный Review.');
  return result;
}
export type ExecuteReview = (input: CodexInput) => Promise<ReviewResult>;
export function executeReview(input: CodexInput, executable = 'codex') {
  return executeResult(input, reviewSchema, validateReview, executable);
}
