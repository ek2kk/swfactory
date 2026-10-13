import { ModelCatalogs, discoverModels } from './models.js';
import { readTranscript } from './transcript.js';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Store, Problem } from './store.js';
import { generateTitle } from './title.js';
import { inspectProject } from './git.js';
import { chooseProjectFolder } from './folder-dialog.js';
import { GithubIssues, type IssueCommand } from './issues.js';
import { roles, type ProjectInput, type Project, type Settings, type AgentRun } from '../shared.js';
import { realpathSync } from 'node:fs';
import { SpecController } from './spec.js';
import { readLog, readReport } from './artifacts.js';
import type { Run } from './git.js';
import type { ExecuteApprove, ExecuteSpec, ExecuteBuild, ExecuteReview } from './codex.js';

const text = { type: 'string', minLength: 1, maxLength: 4096 };
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const version = { type: 'integer', minimum: 1 };
const description = { type: 'string', minLength: 1, maxLength: 100_000, pattern: '\\S' };
function object(properties: Record<string, unknown>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
function equal(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

type Action = { request_id: string; state_version: number; description: string };
export async function createApp(options: {
  discoverModels?: typeof discoverModels;
  directory: string; origin: string; staticRoot?: string; inspect?: typeof inspectProject; command?: Run; execute?: ExecuteSpec; executeBuild?: ExecuteBuild; executeReview?: ExecuteReview; executeApprove?: ExecuteApprove; generateTitle?: typeof generateTitle;
  chooseFolder?: () => Promise<string | null>;
  issueCommand?: IssueCommand;
}) {
  const store = new Store(options.directory);
  const directory = realpathSync(options.directory);
  const catalogs = new ModelCatalogs(directory, options.discoverModels);
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const token = randomBytes(32).toString('hex');
  const session = randomBytes(32).toString('hex');
  const clients = new Map<ServerResponse, number>();
  const origin = new URL(options.origin);
  const cookieName = `swfactory_${origin.port}`;
  function sendUpdate(client: ServerResponse, cursor: number) {
    const snapshot = { ...store.snapshot(), issue_errors: issues.errors, execution_error: controller.error ?? controller.chat.error, title_error: titles.error };
    while (cursor < snapshot.cursor) {
      const events = store.events(cursor);
      if (!events.length) break;
      for (const event of events) {
        if (!client.write(`id: ${event.id}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`)) { client.destroy(); return; }
        cursor = event.id;
      }
    }
    if (!client.write(`id: ${snapshot.cursor}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)) { client.destroy(); return; }
    return snapshot.cursor;
  }
  function publish() {
    for (const [client, cursor] of clients) {
      const sent = sendUpdate(client, cursor);
      if (sent !== undefined) clients.set(client, sent);
    }
  }
  const controller = new SpecController(store, directory, publish, options.command, options.execute, options.generateTitle, options.executeBuild, options.executeReview, options.executeApprove);
  const titles = controller.titles;
  const issues = new GithubIssues(store, publish, options.issueCommand, taskId => controller.deleteTask(taskId));
  app.addHook('onRequest', async (request, reply) => {
    reply.headers({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
    });
    if (request.headers.host !== origin.host || (request.headers.origin && request.headers.origin !== origin.origin)
      || request.headers['sec-fetch-site'] === 'cross-site') throw new Problem(403, 'Запрос с чужого Origin или Host запрещён.');
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin.origin) throw new Problem(403, 'Для изменения нужен Origin приложения.');
    if (request.url.startsWith('/api/') && request.url !== '/api/session') {
      const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
      if (!equal(cookie, session)) throw new Problem(401, 'Откройте URL с bootstrap token из терминала backend.');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number; validation?: unknown };
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    reply.code(status).send({ message: err.validation ? 'Проверьте поля формы: формат или значение не подходят.'
      : status === 500 ? 'Не удалось сохранить или прочитать данные. Действие не продолжено; проверьте доступ к data directory и свободное место.' : err.message });
  });
  app.post<{ Body: { token: string } }>('/api/session', { schema: { body: object({ token: { type: 'string', maxLength: 128 } }) } }, async (request, reply) => {
    if (!equal(request.body.token, token)) throw new Problem(401, 'Неверный bootstrap token. Откройте URL из терминала backend.');
    reply.header('Set-Cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`);
    return { ok: true };
  });
  app.get('/api/snapshot', async () => {
    await controller.refreshReviewState();
    return { ...store.snapshot(), issue_errors: issues.errors, execution_error: controller.error ?? controller.chat.error, title_error: titles.error };
  });
  let choosingFolder = false;
  app.post('/api/projects/choose-folder', async (_request, reply) => {
    if (choosingFolder) throw new Problem(409, 'Диалог выбора папки уже открыт. Выберите папку или отмените выбор.');
    choosingFolder = true;
    try { return { checkout: await (options.chooseFolder ?? chooseProjectFolder)() }; }
    catch { return reply.code(503).send({ message: 'Не удалось открыть диалог выбора папки. Повторите попытку или введите абсолютный путь вручную.' }); }
    finally { choosingFolder = false; }
  });
  app.post<{ Body: ProjectInput & { request_id: string; state_version: number } }>('/api/projects', {
    schema: { body: object({ checkout: text, remote: text, hosting: { enum: ['github', 'gitlab'] }, target_branch: text, request_id: uuid, state_version: { const: 0 } }) },
  }, async request => {
    const { request_id, state_version, ...input } = request.body;
    const fingerprint = JSON.stringify(['project.connect', input, state_version]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    const inspected = await (options.inspect ?? inspectProject)(input);
    let connected = false;
    const result = store.mutate(request_id, fingerprint, () => { connected = true; return store.addProject(inspected); }) as Project;
    if (connected) issues.connect(result);
    publish();
    return result;
  });
  const projectParams = object({ projectId: uuid });
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/models', { schema: { params: projectParams } }, async request => {
    const project = store.project(request.params.projectId);
    return catalogs.get(project.id, project.checkout);
  });
  const taskParams = object({ projectId: uuid, taskId: uuid });
  const actionBody = object({ request_id: uuid, state_version: version, description });
  app.post<{ Params: { projectId: string }; Body: Action }>('/api/projects/:projectId/tasks', { schema: { params: projectParams, body: actionBody } }, async request => {
    const { request_id, description, state_version } = request.body;
    let changed = false;
    const result = store.mutate(request_id, JSON.stringify(['task.create', request.params.projectId, description, state_version]),
      () => { changed = true; return store.createTask(request.params.projectId, description, state_version); });
    if (changed) setImmediate(() => titles.kick());
    publish();
    return result;
  });
  app.post<{ Params: { projectId: string; taskId: string }; Body: { request_id: string; state_version: number } }>('/api/projects/:projectId/tasks/:taskId/archive', {
    schema: { params: taskParams, body: object({ request_id: uuid, state_version: version }) },
  }, async request => {
    const { projectId, taskId } = request.params;
    const { request_id, state_version } = request.body;
    const result = store.mutate(request_id, JSON.stringify(['task.archive', projectId, taskId, state_version]),
      () => store.archiveTask(projectId, taskId, state_version));
    if (store.rawTask(projectId, taskId).deletion_state === 'stopping') {
      void controller.deleteTask(taskId).catch(() => { controller.error = 'Не удалось сохранить результат остановки. Проверьте архив и backend.'; publish(); });
    }
    publish();
    return result;
  });
  app.get<{ Params: { projectId: string; taskId: string } }>('/api/projects/:projectId/tasks/:taskId/history', { schema: { params: taskParams } }, async request => {
    const { projectId, taskId } = request.params;
    store.rawTask(projectId, taskId);
    return { revisions: store.revisions(projectId, taskId), messages: controller.chat.messages(taskId), runs: store.runs().filter(run => run.task_id === taskId) };
  });
  function deletionResult(projectId: string, taskId: string) {
    const task = store.rawTask(projectId, taskId);
    return {
      deleted: task.deletion_state === 'deleted', error: task.deletion_error,
      warning: task.publication_status === 'unknown' ? 'Remote операция могла завершиться. Проверьте hosting вручную; автоматического повтора публикации нет.' : null,
      verification: { task_id: taskId, repository: store.project(projectId).repository, pr_url: task.pr_url,
        processes: store.db.prepare("SELECT payload, created_at FROM events WHERE task_id = ? AND type = 'execution.process-started'").all(taskId),
        remote_operations: store.db.prepare("SELECT payload, created_at FROM events WHERE task_id = ? AND type = 'publication.remote-operation'").all(taskId),
        runs: store.runs().filter(r => r.task_id === taskId).map(r => ({ run_id: r.id, branch: r.branch, worktree: r.worktree, head_sha: r.head_sha })) },
    };
  }
  app.get<{ Params: { projectId: string; taskId: string } }>('/api/projects/:projectId/tasks/:taskId/deletion', { schema: { params: taskParams } }, async request => deletionResult(request.params.projectId, request.params.taskId));
  for (const action of ['delete', 'stop']) app.post<{ Params: { projectId: string; taskId: string }; Body: { request_id: string; state_version: number; reconciliation?: string } }>(`/api/projects/:projectId/tasks/:taskId/${action}`, {
    schema: { params: taskParams, body: { ...object({ request_id: uuid, state_version: version, reconciliation: { type: 'string', minLength: 20, maxLength: 4096 } }), required: ['request_id', 'state_version'] } },
  }, async request => {
    const { projectId, taskId } = request.params;
    const { request_id, state_version, reconciliation } = request.body;
    const fingerprint = JSON.stringify([`task.${action}`, projectId, taskId, state_version, reconciliation ?? null]);
    store.rawTask(projectId, taskId);
    const prior = store.replay(request_id, fingerprint) as { stopping?: boolean } | undefined;
    if (prior && !prior.stopping) return prior;
    if (action === 'stop') {
      const task = store.rawTask(projectId, taskId);
      if (!task.archived && !task.deletion_state) throw new Problem(409, 'Нет остановленного исполнения для сверки.');
    }
    if (!prior) {
      store.mutate(request_id, fingerprint, () => {
        const task = store.beginDeletion(projectId, taskId, state_version, reconciliation);
        if (action === 'delete') store.db.prepare("UPDATE tasks SET archive_source = 'manual', archive_reason = NULL WHERE id = ?").run(taskId);
        return { stopping: task.deletion_state !== 'deleted' };
      });
      publish();
    }
    let task = store.rawTask(projectId, taskId);
    if (task.deletion_state === 'stopping') await controller.deleteTask(taskId);
    task = store.rawTask(projectId, taskId);
    const result = deletionResult(projectId, taskId);
    if (action === 'stop') store.releaseStoppedTask(projectId, taskId);
    store.db.prepare('UPDATE requests SET response = ? WHERE id = ?').run(JSON.stringify(result), request_id);
    publish();
    return result;
  });
  app.patch<{ Params: { projectId: string; taskId: string }; Body: Action }>('/api/projects/:projectId/tasks/:taskId', { schema: { params: taskParams, body: actionBody } }, async request => {
    const { request_id, description, state_version } = request.body;
    const { projectId, taskId } = request.params;
    let changed = false;
    const result = store.mutate(request_id, JSON.stringify(['task.edit', projectId, taskId, description, state_version]),
      () => { changed = true; return store.editTask(projectId, taskId, description, state_version); });
    if (changed) setImmediate(() => titles.kick());
    publish();
    return result;
  });
  app.get<{ Params: { projectId: string; taskId: string } }>('/api/projects/:projectId/tasks/:taskId/messages', { schema: { params: taskParams } }, async request => {
    store.task(request.params.projectId, request.params.taskId);
    return controller.chat.messages(request.params.taskId);
  });
  app.post<{ Params: { projectId: string; taskId: string }; Body: { request_id: string; state_version: number; text: string; kind: 'guidance' | 'requirements' } }>('/api/projects/:projectId/tasks/:taskId/messages', {
    schema: { params: taskParams, body: object({ request_id: uuid, state_version: version, text: { ...text, pattern: '\\S' }, kind: { enum: ['guidance', 'requirements'] } }) },
  }, async request => {
    const { projectId, taskId } = request.params;
    const { request_id, state_version, text, kind } = request.body;
    const result = store.mutate(request_id, JSON.stringify(['chat', projectId, taskId, state_version, text, kind]), () => controller.chat.add(projectId, taskId, state_version, text, kind));
    controller.chat.flush(taskId);
    if (kind === 'requirements') setImmediate(() => titles.kick());
    publish(); return result;
  });
  app.get<{ Params: { projectId: string; taskId: string } }>('/api/projects/:projectId/tasks/:taskId/revisions', { schema: { params: taskParams } }, async request => store.revisions(request.params.projectId, request.params.taskId));
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/settings', { schema: { params: projectParams } }, async request => store.settings(request.params.projectId));
  app.put<{ Params: { projectId: string }; Body: Settings & { request_id: string; state_version: number } }>('/api/projects/:projectId/settings', {
    schema: { params: projectParams, body: { ...object({ request_id: uuid, state_version: version,
      instructions: { type: 'string', maxLength: 30000 },
      models: object(Object.fromEntries(roles.map(role => [role, { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$' }]))),
      reasoning_efforts: { ...object(Object.fromEntries(roles.map(role => [role, { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' }]))), required: [] },
    }), required: ['request_id', 'state_version', 'instructions', 'models'] } },
  }, async request => {
    const { request_id, state_version, ...config } = request.body;
    const projectId = request.params.projectId;
    const fingerprint = JSON.stringify(['project.settings', projectId, state_version, config]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    const project = store.project(projectId);
    if (project.state_version !== state_version) throw new Problem(409, 'Настройки изменились. Загрузите актуальную версию.');
    const saved = store.settings(projectId);
    const changed = roles.filter(role => config.reasoning_efforts?.[role] !== undefined
      && (config.models[role] !== saved.models[role] || config.reasoning_efforts[role] !== saved.reasoning_efforts?.[role]));
    if (changed.length) {
      const catalog = await catalogs.get(projectId, project.checkout);
      for (const role of changed) {
        if (!catalog.models.find(model => model.id === config.models[role])?.reasoning_efforts?.some(option => option.effort === config.reasoning_efforts![role])) {
          throw new Problem(422, `Глубина рассуждений для ${role} не подтверждена каталогом Codex. Обновите список или выберите «По умолчанию Codex».`);
        }
      }
    }
    const result = store.mutate(request_id, fingerprint, () => store.saveSettings(projectId, config, state_version));
    publish(); return result;
  });
  app.post<{ Params: { projectId: string; taskId: string }; Body: { request_id: string; state_version: number } }>('/api/projects/:projectId/tasks/:taskId/start', {
    schema: { params: taskParams, body: object({ request_id: uuid, state_version: version }) },
  }, async request => {
    const { projectId, taskId } = request.params;
    const { request_id, state_version } = request.body;
    const fingerprint = JSON.stringify(['spec.start', projectId, taskId, state_version]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    if (controller.error || titles.error) throw new Problem(503, controller.error ?? titles.error!);
    const result = store.mutate(request_id, fingerprint, () => store.queueSpec(projectId, taskId, state_version, directory)) as AgentRun;
    controller.enqueue(result);
    publish(); return result;
  });
  app.post<{ Params: { projectId: string; taskId: string }; Body: { request_id: string; state_version: number } }>('/api/projects/:projectId/tasks/:taskId/build', {
    schema: { params: taskParams, body: object({ request_id: uuid, state_version: version }) },
  }, async request => {
    const { projectId, taskId } = request.params;
    const { request_id, state_version } = request.body;
    const fingerprint = JSON.stringify(['build.start', projectId, taskId, state_version]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    if (controller.error || titles.error) throw new Problem(503, controller.error ?? titles.error!);
    const result = store.mutate(request_id, fingerprint, () => store.queueBuild(projectId, taskId, state_version)) as AgentRun;
    controller.enqueue(result);
    publish(); return result;
  });
  app.post<{ Params: { projectId: string; taskId: string }; Body: { request_id: string; state_version: number } }>('/api/projects/:projectId/tasks/:taskId/review', {
    schema: { params: taskParams, body: object({ request_id: uuid, state_version: version }) },
  }, async request => {
    const { projectId, taskId } = request.params;
    const { request_id, state_version } = request.body;
    const fingerprint = JSON.stringify(['review.start', projectId, taskId, state_version]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    if (controller.error || titles.error) throw new Problem(503, controller.error ?? titles.error!);
    const result = store.mutate(request_id, fingerprint, () => store.queueReview(projectId, taskId, state_version)) as AgentRun;
    controller.enqueue(result);
    publish(); return result;
  });
  app.post<{ Params: { projectId: string; taskId: string }; Body: { request_id: string; state_version: number } }>('/api/projects/:projectId/tasks/:taskId/publish', {
    schema: { params: taskParams, body: object({ request_id: uuid, state_version: version }) },
  }, async request => {
    const { projectId, taskId } = request.params;
    const { request_id, state_version } = request.body;
    const fingerprint = JSON.stringify(['publication.start', projectId, taskId, state_version]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    if (controller.error || titles.error) throw new Problem(503, controller.error ?? titles.error!);
    const run = store.mutate(request_id, fingerprint, () => store.beginPublication(projectId, taskId, state_version)) as AgentRun;
    controller.enqueuePublication(run);
    publish(); return run;
  });
  app.post<{ Params: { projectId: string; taskId: string }; Body: { request_id: string; state_version: number } }>('/api/projects/:projectId/tasks/:taskId/approve', {
    schema: { params: taskParams, body: object({ request_id: uuid, state_version: version }) },
  }, async request => {
    const { projectId, taskId } = request.params;
    const { request_id, state_version } = request.body;
    const fingerprint = JSON.stringify(['approve.start', projectId, taskId, state_version]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    if (controller.error || titles.error) throw new Problem(503, controller.error ?? titles.error!);
    const result = store.mutate(request_id, fingerprint, () => store.queueApprove(projectId, taskId, state_version)) as AgentRun;
    controller.enqueue(result);
    publish(); return result;
  });
  app.post<{ Params: { projectId: string; taskId: string }; Body: { request_id: string; state_version: number } }>('/api/projects/:projectId/tasks/:taskId/repair', {
    schema: { params: taskParams, body: object({ request_id: uuid, state_version: version }) },
  }, async request => {
    const { projectId, taskId } = request.params;
    const { request_id, state_version } = request.body;
    const fingerprint = JSON.stringify(['repair.restart', projectId, taskId, state_version]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    if (controller.error || titles.error) throw new Problem(503, controller.error ?? titles.error!);
    const result = store.mutate(request_id, fingerprint, () => store.queueRepair(projectId, taskId, state_version, true)) as AgentRun;
    controller.enqueue(result);
    publish(); return result;
  });
  app.post<{ Params: { projectId: string; taskId: string; humanId: string }; Body: { request_id: string; state_version: number; answers: string[] } }>('/api/projects/:projectId/tasks/:taskId/questions/:humanId/answer', {
    schema: { params: object({ projectId: uuid, taskId: uuid, humanId: uuid }), body: object({ request_id: uuid, state_version: version,
      answers: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 4096 } } }) },
  }, async request => {
    const { projectId, taskId, humanId } = request.params;
    const { request_id, state_version, answers } = request.body;
    const fingerprint = JSON.stringify(['human.answer', projectId, taskId, humanId, state_version, answers]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    if (controller.error || titles.error) throw new Problem(503, controller.error ?? titles.error!);
    const result = store.mutate(request_id, fingerprint, () => store.answer(projectId, taskId, humanId, state_version, answers)) as { run: AgentRun | null };
    if (result.run) controller.enqueue(result.run);
    publish(); return result;
  });
  app.post<{ Params: { projectId: string; taskId: string; humanId: string }; Body: { request_id: string; state_version: number; decision: 'publish' | 'repair'; feedback: string } }>('/api/projects/:projectId/tasks/:taskId/decisions/:humanId', {
    schema: { params: object({ projectId: uuid, taskId: uuid, humanId: uuid }), body: object({ request_id: uuid, state_version: version,
      decision: { enum: ['publish', 'repair'] }, feedback: { type: 'string', maxLength: 4096 } }) },
  }, async request => {
    const { projectId, taskId, humanId } = request.params;
    const { request_id, state_version, decision, feedback } = request.body;
    const fingerprint = JSON.stringify(['approve.decide', projectId, taskId, humanId, state_version, decision, feedback]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    if (controller.error || titles.error) throw new Problem(503, controller.error ?? titles.error!);
    const human = store.humanRequests().find(r => r.id === humanId && r.task_id === taskId);
    if (!human) throw new Problem(404, 'Запрос не найден.');
    await controller.verifyReviewSource(store.specRun(projectId, taskId, human.run_id));
    let changed = false;
    const result = store.mutate(request_id, fingerprint, () => {
      changed = true; return store.decide(projectId, taskId, humanId, state_version, decision, feedback);
    }) as { run: AgentRun | null };
    if (changed && result.run) controller.enqueue(result.run);
    publish(); return result;
  });
  app.get<{ Params: { projectId: string; taskId: string; runId: string } }>('/api/projects/:projectId/tasks/:taskId/runs/:runId/report', {
    schema: { params: object({ projectId: uuid, taskId: uuid, runId: uuid }) },
  }, async request => {
    const { projectId, taskId, runId } = request.params;
    const run = store.readRun(projectId, taskId, runId);
    if (!run.report) throw new Problem(404, 'Сохранённый отчёт пока отсутствует.');
    return { text: readReport(directory, runId) };
  });
  app.get<{ Params: { projectId: string; taskId: string; runId: string } }>('/api/projects/:projectId/tasks/:taskId/runs/:runId/output', {
    schema: { params: object({ projectId: uuid, taskId: uuid, runId: uuid }) },
  }, async request => {
    const { projectId, taskId, runId } = request.params;
    store.readRun(projectId, taskId, runId);
    return store.output(runId) ?? { text: '', updated_at: null, version: 0 };
  });
  app.get<{ Params: { projectId: string; taskId: string; runId: string }; Querystring: { offset: string } }>('/api/projects/:projectId/tasks/:taskId/runs/:runId/transcript', {
    schema: { params: object({ projectId: uuid, taskId: uuid, runId: uuid }), querystring: object({ offset: { type: 'string', pattern: '^[0-9]{1,10}$' } }) },
  }, async request => {
    const { projectId, taskId, runId } = request.params;
    store.readRun(projectId, taskId, runId);
    return readTranscript(directory, runId, Number(request.query.offset));
  });
  app.get<{ Params: { projectId: string; taskId: string; runId: string }; Querystring: { name: 'events.jsonl' | 'stderr.log'; offset: string } }>('/api/projects/:projectId/tasks/:taskId/runs/:runId/log', {
    schema: { params: object({ projectId: uuid, taskId: uuid, runId: uuid }), querystring: object({ name: { enum: ['events.jsonl', 'stderr.log'] }, offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,8})$' } }) },
  }, async request => {
    const { projectId, taskId, runId } = request.params;
    store.readRun(projectId, taskId, runId);
    return readLog(directory, runId, request.query.name, Number(request.query.offset));
  });
  app.post<{ Body: { request_id: string; state_version: number } }>('/api/execution/resume', {
    schema: { body: object({ request_id: uuid, state_version: version }) },
  }, async request => {
    const { request_id, state_version } = request.body;
    const result = store.mutate(request_id, JSON.stringify(['execution.resume', state_version]), () => store.resumeExecution(state_version));
    controller.resume(); publish(); return result;
  });
  app.post<{ Params: { projectId: string; taskId: string }; Body: { request_id: string; state_version: number } }>('/api/projects/:projectId/tasks/:taskId/retry', {
    schema: { params: taskParams, body: object({ request_id: uuid, state_version: version }) },
  }, async request => {
    const { projectId, taskId } = request.params;
    const { request_id, state_version } = request.body;
    const fingerprint = JSON.stringify(['run.retry', projectId, taskId, state_version]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    if (controller.error || titles.error) throw new Problem(503, controller.error ?? titles.error!);
    const result = store.mutate(request_id, fingerprint, () => store.retryRun(projectId, taskId, state_version)) as AgentRun;
    controller.enqueue(result); publish(); return result;
  });
  app.post<{ Params: { projectId: string; taskId: string; runId: string }; Body: { request_id: string; state_version: number } }>('/api/projects/:projectId/tasks/:taskId/runs/:runId/interrupt', {
    schema: { params: object({ projectId: uuid, taskId: uuid, runId: uuid }), body: object({ request_id: uuid, state_version: version }) },
  }, async request => {
    const { projectId, taskId, runId } = request.params;
    const { request_id, state_version } = request.body;
    const fingerprint = JSON.stringify(['run.interrupt', projectId, taskId, runId, state_version]);
    const prior = store.replay(request_id, fingerprint);
    if (prior !== undefined) return prior;
    store.specRun(projectId, taskId, runId);
    if (!controller.canInterrupt(runId)) throw new Problem(409, 'Активная сессия недоступна. Нужна ручная сверка.');
    const run = store.mutate(request_id, fingerprint, () => store.requestInterrupt(projectId, taskId, runId, state_version)) as AgentRun;
    controller.interrupt(run); publish(); return run;
  });
  app.get('/api/events', async (request, reply) => {
    await controller.refreshReviewState();
    const lastId = request.headers['last-event-id'];
    if (lastId !== undefined && (typeof lastId !== 'string' || !/^\d{1,15}$/.test(lastId))) throw new Problem(400, 'Некорректный курсор событий.');
    const snapshot = { ...store.snapshot(), issue_errors: issues.errors, execution_error: controller.error ?? controller.chat.error, title_error: titles.error };
    const cursor = Number(lastId ?? snapshot.cursor);
    if (cursor > snapshot.cursor) throw new Problem(400, 'Курсор событий новее базы.');
    reply.hijack();
    const client = reply.raw;
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) client.setHeader(name, value);
    }
    client.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    // Replay and snapshot are synchronous: no mutation can fall between them and subscription.
    const sent = sendUpdate(client, cursor);
    if (sent === undefined) return;
    clients.set(client, sent);
    const heartbeat = setInterval(() => { if (!client.write(': heartbeat\n\n')) client.destroy(); }, 15_000);
    client.on('close', () => { clearInterval(heartbeat); clients.delete(client); });
  });
  app.addHook('preClose', async () => { for (const client of clients.keys()) client.end(); await issues.close(); });
  app.addHook('onClose', async () => { await issues.close(); await controller.close(); store.close(); });
  try {
    if (options.staticRoot) await app.register(staticFiles, { root: options.staticRoot, index: 'index.html', dotfiles: 'deny' });
    await app.ready();
  } catch (error) { await app.close(); throw error; }
  issues.start();
  return { app, store, token, issues };
}
