import { normalizeUsage } from '../usage.js';
import { prepareFast } from './fast.js';
import { dependenciesSchema, validateDependencies } from './dependencies.js';
import { executeInteractive, type Steer } from './interactive.js';
import { execFile, spawn } from './processes.js';
import { openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { ApproveResult, SpecResult, BuildResult, ReviewResult, ReviewRole } from '../shared.js';
import { CodexFailure, classifyFailure } from './diagnostics.js';
import type { RunDiagnostic } from '../shared.js';
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
export type CodexInput = { reviewRole?: ReviewRole; signal?: AbortSignal; interrupt?: (interrupt: (() => void) | null) => void; control?: (steer: Steer | null) => void; cwd: string; directory: string; model: string; reasoningEffort?: string; fast?: boolean; prompt: string; output?: (text: string) => void; metadata?: (value: RunDiagnostic) => void };
export type ExecuteSpec = (input: CodexInput) => Promise<SpecResult>;

export function executeSpec(input: CodexInput, executable = 'codex') {
  return executeResult(input, specSchema, validateSpec, executable);
}
export type ExecuteBuild = (input: CodexInput) => Promise<BuildResult>;
export function executeBuild(input: CodexInput, executable = 'codex') {
  return executeResult(input, buildSchema, validateBuild, executable);
}
async function executeResult<T>(input: CodexInput, schema: object, validate: (value: unknown) => T, executable: string): Promise<T> {
  if (input.control) return executeInteractive(input, schema, validate, executable);
  const version = await new Promise<string | undefined>(resolve => {
    const child = execFile(executable, ['--version'], { cwd: input.cwd, timeout: 2000, maxBuffer: 4096 }, (error, output) => resolve(!error && /^codex[- ]cli [\w.+-]+\s*$/.test(output) ? output.trim() : undefined));
    child.stdin?.end();
  });
  input.metadata?.({ cli_version: version });
  const fastArgs = await prepareFast(input, version, executable);
  saveArtifact(input.directory, 'schema.json', JSON.stringify(schema));
  const stdout = openSync(join(input.directory, 'events.jsonl'), 'wx', 0o600);
  let stderr: number;
  try { stderr = openSync(join(input.directory, 'stderr.log'), 'wx', 0o600); }
  catch (error) { closeSync(stdout); throw error; }
  try {
    return await new Promise<T>((resolve, reject) => {
      const child = spawn(executable, ['exec', ...fastArgs, '--json', '--dangerously-bypass-approvals-and-sandbox',
        '--model', input.model, ...(input.reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`] : []), '--output-schema', join(input.directory, 'schema.json'), '--color', 'never', '-'],
      { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      child.once('spawn', () => input.metadata?.({ model_started_at: new Date().toISOString() }));
      let stderrBuffer = '', stderrTail = '';
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
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            let event;
            try { event = JSON.parse(line); }
            catch { writeSync(stdout, '[Invalid JSONL event omitted]\n'); throw new Error('Invalid JSONL'); }
            writeSync(stdout, JSON.stringify(event) + '\n');
            if (typeof event?.type !== 'string' || completed) throw new Error('Invalid stream');
            if (event.type === 'thread.started') { thread = true; if (typeof event.thread_id === 'string' && event.thread_id.length <= 256) input.metadata?.({ session_id: event.thread_id }); }
            if (event.type === 'turn.started') { if (started || !thread) throw new Error('Invalid turn'); started = true; }
            if (event.type === 'error' || event.type === 'turn.failed') throw classifyFailure(event);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
              if (typeof event.item.text !== 'string') throw new Error('Invalid agent message');
              message = event.item.text;
              if (message.trim()) input.output?.(message);
            }
            if (event.type === 'turn.completed') { if (!started) throw new Error('Incomplete turn'); if (event.usage) input.metadata?.({ usage: normalizeUsage(event.usage), usage_accounting: { version: 1, source: 'exec-turn' } });
              if (!message) throw new CodexFailure('missing_artifact'); completed = true; }
          }
          if (buffer.length > 2 * 1024 * 1024) throw new Error('Oversized event');
        } catch (error) { fail(error instanceof Problem ? error : new CodexFailure('protocol_error')); }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (failed) return;
        try { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error(); stderrBuffer += chunk.toString('utf8'); stderrTail = (stderrTail + chunk.toString('utf8')).slice(-65536);
          let newline: number; while ((newline = stderrBuffer.indexOf('\n')) >= 0) { writeSync(stderr, stderrBuffer.slice(0, newline) + '\n'); stderrBuffer = stderrBuffer.slice(newline + 1); } }
        catch { fail(new Problem(422, 'Не удалось сохранить лог Codex или превышен лимит 32 MiB.')); }
      });
      child.on('error', () => { failed = new Problem(422, 'Не удалось запустить Codex. Проверьте CLI и checkout.'); });
      child.stdin.on('error', () => { failed ??= new Problem(422, 'Codex не принял prompt. Проверьте CLI и локальные логи.'); });
      child.on('close', code => {
        try { if (stderrBuffer) writeSync(stderr, stderrBuffer); if (buffer) writeSync(stdout, '[Incomplete JSONL event omitted]\n'); } catch { failed = new Problem(422, 'Не удалось сохранить локальный лог.'); }
        if (failed instanceof CodexFailure) failed.finished = true;
        if (failed) return reject(failed);
        if (code !== 0 || !completed || buffer.trim()) { const error = code !== 0 ? classifyFailure(stderrTail) : new CodexFailure(message ? 'protocol_error' : 'missing_artifact'); error.finished = true; return reject(error); }
        try { resolve(validate(JSON.parse(message))); }
        catch { const error = new CodexFailure('protocol_error'); error.finished = true; reject(error); }
      });
      child.stdin.end(input.prompt);
    });
  } finally { closeSync(stdout); closeSync(stderr); }
}

export const buildSchema = {
  type: 'object', additionalProperties: false,
  properties: { outcome: { enum: ['READY', 'NEEDS_INPUT', 'BLOCKED'] }, summary: { type: 'string' },
    changed_paths: list, actions: list, checks: list, questions: specSchema.properties.questions, dependencies: dependenciesSchema },
  required: ['outcome', 'summary', 'changed_paths', 'actions', 'checks', 'questions', 'dependencies'],
};
export function validateBuild(value: unknown): BuildResult {
  const result = value as BuildResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join() !== buildSchema.required.filter(k => k !== 'dependencies' || result.dependencies !== undefined).sort().join()
    || !['READY', 'NEEDS_INPUT', 'BLOCKED'].includes(result.outcome) || !nonempty(result.summary)
    || !validQuestions(result.questions) || (result.outcome === 'NEEDS_INPUT' ? !result.questions.length : result.questions.length > 0)
    || !['changed_paths', 'actions', 'checks'].every(key => {
      const items = result[key as 'changed_paths'];
      return Array.isArray(items) && items.every(v => typeof v === 'string' && v.trim().length > 0);
    }) || (result.outcome === 'READY' && (!result.changed_paths.length || !result.actions.length || !result.checks.length))
    || new Set(result.changed_paths).size !== result.changed_paths.length) throw new Problem(422, 'Невалидный Build.');
  if (result.dependencies !== undefined && (validateDependencies(result.dependencies).length && result.outcome !== 'BLOCKED')) throw new Problem(422, 'Dependencies допустимы только для BLOCKED.');
  return result;
}

export const reviewSchema = {
  type: 'object', additionalProperties: false,
  properties: { outcome: { enum: ['PASS', 'CHANGES', 'NEEDS_INPUT', 'BLOCKED'] }, summary: { type: 'string' },
    findings: list, evidence: list, applicable: { type: 'boolean' }, applicability: { type: 'string' }, questions: specSchema.properties.questions, dependencies: dependenciesSchema },
  required: ['outcome', 'summary', 'findings', 'evidence', 'applicable', 'applicability', 'questions', 'dependencies'],
};
const reviewSectionSchema = {
  type: 'object', additionalProperties: false,
  properties: { summary: { type: 'string' }, findings: list, evidence: list },
  required: ['summary', 'findings', 'evidence'],
};
export const visualReviewSchema = {
  ...reviewSchema, properties: { ...reviewSchema.properties, ui: reviewSectionSchema, ux: reviewSectionSchema },
  required: [...reviewSchema.required, 'ui', 'ux'],
};
export function validateReview(value: unknown, role?: ReviewRole): ReviewResult {
  const result = value as ReviewResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join() !== (role === 'review-ui-ux' ? visualReviewSchema : reviewSchema).required.filter(k => k !== 'dependencies' || result.dependencies !== undefined).sort().join()
    || !['PASS', 'CHANGES', 'NEEDS_INPUT', 'BLOCKED'].includes(result.outcome) || !nonempty(result.summary)
    || !validQuestions(result.questions) || (result.outcome === 'NEEDS_INPUT' ? !result.questions.length : result.questions.length > 0)
    || !['findings', 'evidence'].every(key => Array.isArray(result[key as 'findings']) && result[key as 'findings'].every(nonempty))
    || typeof result.applicable !== 'boolean' || typeof result.applicability !== 'string'
    || (!result.applicable && (!nonempty(result.applicability) || (role && !['review-ui', 'review-ux', 'review-ui-ux'].includes(role))))
    || (result.outcome === 'PASS' && (result.findings.length > 0 || (result.applicable && !result.evidence.length)))
    || (result.outcome === 'CHANGES' && !result.findings.length)
    || (role === 'review-ui-ux' && ![result.ui, result.ux].every(section => section
      && Object.keys(section).sort().join() === 'evidence,findings,summary' && nonempty(section.summary)
      && Array.isArray(section.findings) && section.findings.every(nonempty)
      && Array.isArray(section.evidence) && section.evidence.every(nonempty)
      && (result.outcome !== 'PASS' || (!section.findings.length && (!result.applicable || section.evidence.length)))
      && section.findings.every(finding => result.findings.includes(finding))))) throw new Problem(422, 'Невалидный Review.');
  if (result.dependencies !== undefined && (validateDependencies(result.dependencies).length && result.outcome !== 'BLOCKED')) throw new Problem(422, 'Dependencies допустимы только для BLOCKED.');
  return result;
}
export type ExecuteReview = (input: CodexInput) => Promise<ReviewResult>;
export function executeReview(input: CodexInput, executable = 'codex') {
  return executeResult(input, input.reviewRole === 'review-ui-ux' ? visualReviewSchema : reviewSchema, value => validateReview(value, input.reviewRole), executable);
}

export const approveSchema = {
  type: 'object', additionalProperties: false,
  properties: { outcome: { enum: ['APPROVE', 'ESCALATE', 'NEEDS_INPUT'] }, summary: { type: 'string' },
    risks: list, affected_paths: list, questions: specSchema.properties.questions },
  required: ['outcome', 'summary', 'risks', 'affected_paths', 'questions'],
};
export function validateApprove(value: unknown): ApproveResult {
  const result = value as ApproveResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join() !== [...approveSchema.required].sort().join()
    || !['APPROVE', 'ESCALATE', 'NEEDS_INPUT'].includes(result.outcome) || !nonempty(result.summary)
    || !['risks', 'affected_paths'].every(key => Array.isArray(result[key as 'risks']) && result[key as 'risks'].every(nonempty))
    || !validQuestions(result.questions) || (result.outcome === 'NEEDS_INPUT' ? !result.questions.length : result.questions.length > 0)
    || (result.outcome === 'ESCALATE' && !result.risks.length)) throw new Problem(422, 'Невалидный Approve.');
  return result;
}
export type ExecuteApprove = (input: CodexInput) => Promise<ApproveResult>;
export function executeApprove(input: CodexInput, executable = 'codex') {
  return executeResult(input, approveSchema, validateApprove, executable);
}
