import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { transformSync } from 'esbuild';
import * as jsx from 'react/jsx-runtime';
import * as shared from '../src/shared.js';
import * as stageHistory from '../src/client/stageHistory.js';
import { TaskMarkdown } from '../src/client/TaskMarkdown.js';

test('requirements form preserves both drafts on cancel, reopen and conflicts, and clears only after saving', async () => {
  const appState: any[] = [], cardState: any[] = [];
  let state = appState, index = 0, App!: () => any;
  let fail = false;
  const calls: any[][] = [];
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': jsx,
    'react': {
      useState(initial: unknown) {
        const values = state, slot = index++;
        if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial;
        return [values[slot], (value: unknown) => { values[slot] = typeof value === 'function' ? value(values[slot]) : value; }];
      },
      useRef(current: unknown) { const slot = index++; return state[slot] ??= { current }; },
      useEffect() {},
    },
    'react-dom/client': { createRoot: () => ({ render: (element: { type: () => any }) => { App = element.type; App(); } }) },
    './api.js': { api: async (...args: any[]) => { calls.push(args); if (fail) throw new Error('Conflict'); return snapshot; } },
    './theme.js': { readTheme: () => 'system', applyTheme: () => {} },
    '../shared.js': shared, './stageHistory.js': stageHistory,
    './TaskMarkdown.js': { TaskMarkdown }, './windows.js': {},
    './models.js': {}, './chat.js': {}, './output.js': {}, './taskView.js': {}, './style.css': {},
  };
  const source = readFileSync(new URL('../src/client/main.tsx', import.meta.url), 'utf8');
  runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
    require(name: string) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
    URLSearchParams, location: { pathname: '/', search: '?task=t', hash: '' },
    document: { getElementById: () => ({}) },
  });
  function elements(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    return node?.props ? [node, ...elements(node.props.children)] : [];
  }
  const task = { id: 't', project_id: 'p', description: 'Original', stage: 'backlog', run_state: 'idle', state_version: 1, revision: 1 };
  const snapshot = { projects: [{ id: 'p', hosting: 'github' }], tasks: [task], runs: [], human_requests: [], cursor: 1 };
  const snapshotIndex = appState.findIndex(value => value && typeof value === 'object' && 'cursor' in value);
  appState[snapshotIndex] = snapshot;
  function card() {
    state = appState; index = 0;
    const element = elements(App()).find(element => element.type?.name === 'TaskCard');
    assert.ok(element);
    state = cardState; index = 0;
    return elements(element.type(element.props));
  }
  const button = (label: string) => {
    const found = card().find(node => node.type === 'button' && node.props.children === label);
    assert.ok(found, label); return found;
  };
  const field = () => card().find(node => node.type === 'textarea');
  const type = (text: string) => field().props.onChange({ target: { value: text } });
  const submit = () => card().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });

  button('Изменить требования').props.onClick();
  type('Replacement draft');
  button('Добавить уточнения').props.onClick();
  type('Clarification draft');
  button('Отмена').props.onClick();
  assert.equal(field(), undefined, 'cancel closes the form');
  assert.equal(calls.length, 0, 'cancel does not save requirements');
  button('Изменить требования').props.onClick();
  assert.equal(field().props.value, 'Clarification draft');
  assert.equal(field().props['aria-label'], 'Уточнения требований', 'reopen preserves the selected mode');
  button('Заменить описание').props.onClick();
  assert.equal(field().props.value, 'Replacement draft', 'the other mode also keeps its draft');
  button('Добавить уточнения').props.onClick();
  button('Отмена').props.onClick();
  task.state_version++;
  button('Изменить требования').props.onClick();
  assert.equal(field().props.value, 'Clarification draft');
  assert.equal(button('Сохранить').props.disabled, true, 'reopen does not silently accept a changed state_version');
  button('Заменить описание').props.onClick();
  assert.equal(field().props.value, 'Replacement draft');
  assert.equal(button('Сохранить').props.disabled, true, 'switching to replacement cannot bypass the conflict');
  button('Добавить уточнения').props.onClick();
  assert.equal(field().props.value, 'Clarification draft');
  assert.equal(button('Сохранить').props.disabled, true, 'switching back keeps the original draft version');
  button('Использовать актуальное состояние').props.onClick();
  assert.equal(button('Сохранить').props.disabled, false);
  fail = true; await submit();
  assert.equal(field().props.value, 'Clarification draft', 'save errors retain the draft');
  const form = card().find(node => node.type === 'form');
  assert.ok(elements(form).some(node => node.props.role === 'alert' && node.props.children === 'Conflict'), 'save error is inside the requirements form');
  assert.equal(card().filter(node => node.props.role === 'alert' && node.props.children === 'Conflict').length, 1, 'save error is not repeated below history');
  button('Отмена').props.onClick();
  task.run_state = 'running'; task.stage = 'spec';
  button('Изменить требования').props.onClick();
  assert.equal(field().props.value, 'Clarification draft', 'running still allows the saved clarification');
  fail = false; await submit();
  const request = calls.at(-2);
  assert.ok(request);
  assert.equal(request[0], '/projects/p/tasks/t/messages');
  assert.equal(request[2].kind, 'requirements');
  assert.equal(request[2].text, 'Clarification draft');
  assert.equal(request[2].state_version, 2);
  assert.equal(field(), undefined, 'successful save closes the form');
  button('Изменить требования').props.onClick();
  assert.equal(field().props.value, '', 'success clears the submitted clarification');
});

test('App reports unavailable live updates and restores active status and current data on snapshot', async () => {
  const initial = { projects: [], tasks: [], human_requests: [], cursor: 1,
    runs: [{ id: 'run', status: 'running', output_preview: 'old output' }] };
  const values: unknown[] = [], effects: (() => void | (() => void))[] = [];
  const sources: Source[] = [];
  class Source {
    handlers = new Map<string, (event: { data: string }) => void>();
    onerror?: () => void;
    closes = 0;
    constructor(readonly url: string) { sources.push(this); }
    addEventListener(type: string, handler: (event: { data: string }) => void) { this.handlers.set(type, handler); }
    close() { this.closes++; }
  }
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': jsx,
    'react': {
      useState(initial: unknown) {
        const index = values.length;
        values.push(typeof initial === 'function' ? initial() : initial);
        return [values[index], (value: unknown) => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
      },
      useRef: (current: unknown) => ({ current }),
      useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    },
    'react-dom/client': { createRoot: () => ({ render: (element: { type: () => unknown }) => element.type() }) },
    './api.js': { api: async () => structuredClone(initial) },
    './theme.js': { readTheme: () => 'system', applyTheme: () => {} },
    '../shared.js': shared, './stageHistory.js': stageHistory,
    './TaskMarkdown.js': { TaskMarkdown }, './windows.js': {},
    './models.js': {}, './chat.js': {}, './output.js': {}, './taskView.js': {}, './style.css': {},
  };
  // Run the real App with hook/module doubles; no browser or extra runtime dependency.
  const source = readFileSync(new URL('../src/client/main.tsx', import.meta.url), 'utf8');
  runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
    require(name: string) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
    EventSource: Source, URLSearchParams,
    location: { pathname: '/', search: '', hash: '' },
    document: { getElementById: () => ({}) },
    window: {}, addEventListener() {}, removeEventListener() {},
  });
  const cleanups = effects.map(effect => effect());
  try {
    await setImmediate();
    assert.equal(sources.length, 1);
    const events = sources[0];
    assert.equal(events.url, '/api/events');
    const connectionIndex = values.indexOf('Подключаемся к backend…');
    const snapshotIndex = values.findIndex(value => !!value && typeof value === 'object' && 'cursor' in value);
    assert.ok(connectionIndex >= 0 && snapshotIndex >= 0);
    const before = values[snapshotIndex];
    events.onerror!();
    assert.equal(values[connectionIndex], 'Live-обновления недоступны. Переподключаемся. Это само по себе не означает остановку задачи. Обновите страницу, чтобы получить актуальное состояние');
    assert.equal(values[snapshotIndex], before, 'channel error does not change run state');
    assert.equal(events.closes, 0, 'EventSource stays open for automatic reconnect');
    const updated = { ...initial, cursor: 9, runs: [{ ...initial.runs[0], output_preview: 'current output' }] };
    events.handlers.get('snapshot')!({ data: JSON.stringify(updated) });
    assert.equal(values[connectionIndex], 'Сохранено локально · Соединение активно');
    assert.equal(JSON.stringify(values[snapshotIndex]), JSON.stringify(updated));
    assert.equal(events.closes, 0);
    const change = { id: 10, type: 'task.archived', task_id: 'task', payload: '{"state_version":4}', created_at: '' };
    const receive = (event: object) => events.handlers.get('change')!({ data: JSON.stringify(event) });
    receive(change); receive(change); receive({ ...change, id: 9 }); receive({ ...change, id: 11 });
    const notices = values.find(value => Array.isArray(value) && value.some(item => item.text?.startsWith('Карточка скрыта.'))) as { text: string }[];
    assert.equal(notices.length, 1, 'duplicate event IDs and archive action keys do not announce twice');
  } finally { for (const cleanup of cleanups) cleanup?.(); }
  assert.equal(sources[0].closes, 1, 'unmount closes the connection');
});

test('GitHub refresh controls follow project snapshots, prevent double clicks and show request errors', async () => {
  const github = { id: 'github-project', hosting: 'github', host: 'github.com', repository: 'owner/repo' };
  const gitlab = { ...github, id: 'gitlab-project', hosting: 'gitlab' };
  const appState: any[] = [], buttonState: any[] = [];
  let state = appState, index = 0, App!: () => any;
  let resolve!: () => void, reject!: (error: Error) => void;
  let request: Promise<void>;
  const pending = () => { request = new Promise<void>((done, fail) => { resolve = done; reject = fail; }); };
  const calls: unknown[][] = [];
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': jsx,
    'react': {
      useState(initial: unknown) {
        const values = state, slot = index++;
        if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial;
        return [values[slot], (value: unknown) => { values[slot] = typeof value === 'function' ? value(values[slot]) : value; }];
      },
      useRef(current: unknown) {
        const slot = index++;
        return state[slot] ??= { current };
      },
      useEffect() {},
    },
    'react-dom/client': { createRoot: () => ({ render: (element: { type: () => any }) => { App = element.type; App(); } }) },
    './api.js': { api: (...args: unknown[]) => { calls.push(args); return request; } },
    './theme.js': { readTheme: () => 'system', applyTheme: () => {} },
    '../shared.js': shared, './stageHistory.js': stageHistory,
    './TaskMarkdown.js': { TaskMarkdown }, './windows.js': {},
    './models.js': {}, './chat.js': {}, './output.js': {}, './taskView.js': {}, './style.css': {},
  };
  const source = readFileSync(new URL('../src/client/main.tsx', import.meta.url), 'utf8');
  runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
    require(name: string) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
    URLSearchParams, location: { pathname: '/', search: '', hash: '' }, document: { getElementById: () => ({}) },
  });
  function elements(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    return node?.props ? [node, ...elements(node.props.children)] : [];
  }
  const snapshotIndex = appState.findIndex(value => value && typeof value === 'object' && 'cursor' in value);
  appState[snapshotIndex] = { ...appState[snapshotIndex], projects: [github, gitlab] };
  function control(syncing: string[] = []) {
    appState[snapshotIndex].issue_syncing = syncing;
    state = appState; index = 0;
    const controls = elements(App()).filter(element => element.type?.name === 'IssueRefresh');
    assert.equal(controls.length, 1, 'GitLab has no refresh action');
    assert.equal(controls[0].props.project.id, github.id);
    state = buttonState; index = 0;
    return elements(controls[0].type(controls[0].props));
  }
  const button = (nodes: any[]) => nodes.find(node => node.type === 'button');
  const status = (nodes: any[]) => nodes.find(node => node.props.role === 'status').props.children;
  assert.equal(button(control()).props.children, 'Обновить задачи из GitHub');
  const automatic = control([github.id]);
  assert.equal(button(automatic).props.disabled, true);
  assert.equal(status(automatic), 'Обновляем…');
  await button(automatic).props.onClick(); assert.equal(calls.length, 0);
  assert.equal(button(control([gitlab.id])).props.disabled, false, 'another project does not block this control');
  pending();
  const click = button(control()).props.onClick;
  const first = click(); await click();
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(['/projects/github-project/issues/refresh', 'POST']));
  assert.equal(button(control()).props.disabled, true);
  assert.equal(status(control()), 'Обновляем…');
  resolve(); await first;
  assert.equal(button(control([github.id])).props.disabled, true, 'request completion still respects backend state');
  assert.equal(button(control()).props.disabled, false, 'completion snapshot unlocks the control');
  pending();
  const failed = button(control()).props.onClick();
  reject(new Error('Backend недоступен')); await failed;
  const failure = control();
  assert.equal(button(failure).props.disabled, false);
  const alert = failure.find(node => node.props.role === 'alert');
  assert.ok(alert.props.children.join('').includes('github.com/owner/repo: Backend недоступен'));
  pending();
  const retry = button(control()).props.onClick();
  assert.ok(!control().some(node => node.props.role === 'alert'), 'retry clears the request error');
  resolve(); await retry;
  assert.equal(status(control()), '');
});
