import { spawn } from './processes.js';
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultModels, type ModelOption, type ModelCatalog } from '../shared.js';

export function normalizeModels(value: unknown): ModelOption[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error('invalid catalog');
  const models = new Map<string, ModelOption>();
  for (const entry of value) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(entry.id)
      || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 256 || /[\x00-\x1f\x7f]/.test(entry.name)) throw new Error('invalid model');
    const model: ModelOption = { id: entry.id, name: entry.name };
    if (entry.reasoning_efforts !== undefined) {
      if (!Array.isArray(entry.reasoning_efforts) || entry.reasoning_efforts.length > 32
        || entry.reasoning_efforts.some((option: any) => !option || typeof option.effort !== 'string'
          || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(option.effort)
          || typeof option.description !== 'string' || option.description.length > 1024 || /[\x00-\x1f\x7f]/.test(option.description))
        || new Set(entry.reasoning_efforts.map((option: any) => option.effort)).size !== entry.reasoning_efforts.length) throw new Error('invalid reasoning efforts');
      model.reasoning_efforts = entry.reasoning_efforts.map((option: any) => ({ effort: option.effort, description: option.description }));
    }
    if (entry.default_reasoning_effort != null) {
      if (!model.reasoning_efforts?.some(option => option.effort === entry.default_reasoning_effort)) throw new Error('invalid default effort');
      model.default_reasoning_effort = entry.default_reasoning_effort;
    }
    if (entry.fast !== undefined) {
      if (typeof entry.fast?.supported !== 'boolean' || typeof entry.fast.reason !== 'string' || entry.fast.reason.length > 1024
        || !['chatgpt', 'apiKey', 'unknown'].includes(entry.fast.auth)) throw new Error('invalid fast metadata');
      model.fast = { supported: entry.fast.supported, reason: entry.fast.reason, auth: entry.fast.auth };
    }
    models.set(entry.id, model);
  }
  return [...models.values()];
}

// 0.162.1 is the oldest protocol verified here to acknowledge serviceTier and its explicit default.
export function supportsFast(version: string | undefined) {
  const match = version?.match(/(?:codex[- ]cli |\/)(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  return !!match && (Number(match[1]) > 0 || Number(match[2]) > 162 || (Number(match[2]) === 162 && Number(match[3]) >= 1));
}

// Read-only discovery: no thread, inference, credentials parsing or tool execution.
export function discoverModels(cwd: string, executable = 'codex', timeout = 10_000): Promise<ModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', bytes = 0, id = 1, pages = 0, done = false;
    let method = 'initialize', version: string | undefined, auth: 'chatgpt' | 'apiKey' | 'unknown' = 'unknown';
    let result: ModelOption[] | undefined;
    const models: ModelOption[] = [], cursors = new Set<string>();
    let error: Error | undefined, kill: ReturnType<typeof setTimeout> | undefined;
    const finish = (failure?: Error) => {
      if (done) return;
      done = true; error = failure;
      child.stdin.end(); child.kill('SIGTERM');
      kill = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => finish(new Error('Discovery timeout')), timeout);
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) return;
      try {
        bytes += Buffer.byteLength(chunk); if (bytes > 2 * 1024 * 1024) throw new Error('Catalog limit');
        buffer += chunk;
        let newline: number;
        while (!done && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.method && event.id !== undefined) throw new Error('Unexpected server request');
          if (event.id !== id) continue;
          if (method === 'account/read') {
            const type = event.result?.account?.type;
            auth = type === 'chatgpt' || type === 'apiKey' ? type : 'unknown';
            method = 'model/list';
            send({ id: ++id, method, params: { limit: 100, includeHidden: false } });
            continue;
          }
          if (event.error || !event.result) throw new Error('Discovery failed');
          if (method === 'initialize') {
            version = event.result.userAgent;
            send({ method: 'initialized', params: {} });
            method = 'account/read';
            send({ id: ++id, method, params: {} });
            continue;
          } else {
            const page = event.result;
            if (!Array.isArray(page.data) || ++pages > 100) throw new Error('Invalid page');
            models.push(...page.data.filter((m: any) => !m?.hidden).map((m: any) => {
              const tier = Array.isArray(m?.serviceTiers) && m.serviceTiers.some((tier: any) => tier?.id === 'priority');
              const reason = !supportsFast(version) ? 'Версия Codex не подтверждает управление Fast; требуется CLI 0.162.1 или новее.'
                : auth !== 'chatgpt' ? 'Fast подтверждён только для входа через ChatGPT; текущая авторизация не поддержана.'
                : !tier ? 'Каталог Codex не подтверждает Fast для этой модели.'
                : 'Доступность аккаунта и фактический режим проверяются исполнителем при запуске.';
              return { id: m?.model, name: m?.displayName,
                reasoning_efforts: m?.supportedReasoningEfforts?.map((option: any) => ({ effort: option?.reasoningEffort, description: option?.description })),
                default_reasoning_effort: m?.defaultReasoningEffort,
                ...(Array.isArray(m?.serviceTiers) ? { fast: { supported: supportsFast(version) && auth === 'chatgpt' && !!tier, auth, reason } } : {}),
              };
            }));
            if (models.length > 1000) throw new Error('Catalog limit');
            if (page.nextCursor == null) { result = normalizeModels(models); finish(); break; }
            if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) throw new Error('Invalid cursor');
            cursors.add(page.nextCursor);
          }
          send({ id: ++id, method: 'model/list', params: { limit: 100, includeHidden: false, cursor: event.result.nextCursor } });
        }
      } catch { finish(new Error('Invalid Codex model catalog')); }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('Codex unavailable')));
    child.stdin.on('error', () => { if (!done) finish(new Error('Codex connection failed')); });
    child.on('close', () => {
      clearTimeout(timer); clearTimeout(kill);
      if (error || !result) reject(error ?? new Error('Codex closed before catalog'));
      else resolve(result);
    });
    send({ id, method: 'initialize', params: { clientInfo: { name: 'swfactory', version: '0.1.0' } } });
  });
}

export class ModelCatalogs {
  private pending = new Map<string, Promise<ModelCatalog>>();
  constructor(private directory: string, private discover = discoverModels) {}
  get(projectId: string, cwd: string) {
    const prior = this.pending.get(projectId);
    if (prior) return prior;
    const work = this.load(projectId, cwd).finally(() => this.pending.delete(projectId));
    this.pending.set(projectId, work); return work;
  }
  private async load(projectId: string, cwd: string): Promise<ModelCatalog> {
    const path = join(this.directory, `models-${projectId}.json`);
    let cached: ModelCatalog | undefined;
    try {
      if (statSync(path).size > 1024 * 1024) throw new Error();
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof saved.updated_at !== 'string' || !Number.isFinite(Date.parse(saved.updated_at))) throw new Error();
      cached = { models: normalizeModels(saved.models), updated_at: saved.updated_at, source: 'cache' };
    } catch { /* Missing/corrupt cache falls back to project defaults. */ }
    try {
      const models = normalizeModels(await this.discover(cwd));
      const catalog: ModelCatalog = { models, source: 'codex', updated_at: new Date().toISOString() };
      try {
        writeFileSync(path + '.tmp', JSON.stringify(catalog), { mode: 0o600 });
        renameSync(path + '.tmp', path);
      } catch { catalog.error = 'Каталог получен, но не сохранён для следующего запуска backend.'; }
      return catalog;
    } catch {
      return { ...(cached ?? { models: [...new Set(Object.values(defaultModels))].map(id => ({ id, name: id })), source: 'defaults', updated_at: null }),
        error: 'Codex не вернул непустой корректный каталог. Используется резервный список; можно повторить обновление или указать другую модель.' };
    }
  }
}
