import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { transformSync } from 'esbuild';
import * as jsx from 'react/jsx-runtime';
import * as shared from '../src/shared.js';
import * as stageHistory from '../src/client/stageHistory.js';
import { ModelPicker, ReasoningPicker } from '../src/client/models.js';
import { TaskMarkdown } from '../src/client/TaskMarkdown.js';

// Exercise the real components with the same hook/module doubles as the other client tests.
function hooks() {
  const values: any[] = [], effects: { deps?: unknown[]; cleanup?: () => void }[] = [];
  let index = 0, dirty = false, pending: (() => void)[] = [];
  const react = {
    useState(initial: any) {
      const slot = index++;
      if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial;
      return [values[slot], (value: any) => {
        const next = typeof value === 'function' ? value(values[slot]) : value;
        if (!Object.is(next, values[slot])) { values[slot] = next; dirty = true; }
      }];
    },
    useRef(current: unknown) { return values[index++] ??= { current }; },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const slot = index++, previous = effects[slot];
      if (!previous || !deps || deps.some((dep, i) => !Object.is(dep, previous.deps?.[i]))) {
        pending.push(() => { previous?.cleanup?.(); effects[slot] = { deps, cleanup: effect() || undefined }; });
      }
    },
  };
  return { react, render(component: () => any) {
    let tree: any;
    for (let attempt = 0; attempt < 20; attempt++) {
      index = 0; dirty = false; pending = []; tree = component();
      pending.forEach(effect => effect());
      if (!dirty) return tree;
    }
    assert.fail('effects did not settle');
  }, dispose() { effects.forEach(effect => effect.cleanup?.()); } };
}

function load(name: 'main' | 'windows' | 'models', modules: Record<string, unknown>, globals = {}) {
  const module = { exports: {} as any };
  const code = transformSync(readFileSync(new URL(`../src/client/${name}.tsx`, import.meta.url), 'utf8') + (name === 'main' ? '\nexport { ModelSettings };' : ''), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
  runInNewContext(code, { module, ...globals, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), name); return modules[name];
  } });
  return module.exports;
}

function elements(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return node?.props ? [node, ...elements(node.props.children)] : [];
}
function button(tree: any, text: string) {
  const found = elements(tree).find(node => node.type === 'button' && (Array.isArray(node.props.children) ? node.props.children.includes(text) : node.props.children === text));
  assert.ok(found, text); return found;
}
function modal(tree: any, title: string) {
  const found = elements(tree).find(node => node.type?.name === 'Modal' && node.props.title === title);
  assert.ok(found, title); return found;
}
function submit(dialog: any, currentTarget = {}) {
  return elements(dialog).find(node => node.type === 'form').props.onSubmit({ preventDefault() {}, currentTarget });
}
const project = (id: string) => ({ id, host: 'github.com', repository: `owner/${id}`, checkout: `/tmp/${id}`, hosting: 'github', target_branch: 'main', state_version: 1 });
const snapshot = (projects: any[] = []) => ({ projects, tasks: [], runs: [], human_requests: [], cursor: 1 });

async function app(t: TestContext, initial = snapshot()) {
  const runtime = hooks();
  const calls: any[][] = [];
  let current = initial, App!: () => any;
  let request = async (..._args: any[]): Promise<any> => { throw new Error('unexpected request'); };
  let source!: Source;
  class Source {
    handlers = new Map<string, (event: { data: string }) => void>();
    constructor() { source = this; }
    addEventListener(type: string, handler: (event: { data: string }) => void) { this.handlers.set(type, handler); }
    close() {}
  }
  const modules = {
    react: runtime.react, 'react/jsx-runtime': jsx,
    'react-dom/client': { createRoot: () => ({ render: (element: any) => { App = element.type; } }) },
    './api.js': { api: async (...args: any[]) => { if (args[0] === '/snapshot') return current; calls.push(args); return request(...args); } },
    './theme.js': { readTheme: () => 'system', applyTheme() {} },
    '../shared.js': shared, './stageHistory.js': stageHistory, './TaskMarkdown.js': { TaskMarkdown },
    './windows.js': load('windows', { react: runtime.react, 'react/jsx-runtime': jsx }),
    './models.js': {}, './chat.js': {}, './output.js': {}, './taskView.js': {}, './style.css': {},
  };
  load('main', modules, {
    EventSource: Source, URLSearchParams, location: { pathname: '/', search: '', hash: '' },
    document: { getElementById: () => ({}) }, window: {}, addEventListener() {}, removeEventListener() {},
    FormData: class { constructor(form: { fields: Record<string, string> }) { return Object.entries(form.fields); } },
  });
  t.after(() => runtime.dispose());
  const render = () => runtime.render(App);
  render(); await setImmediate(); render();
  return { render, calls, respond(handler: typeof request) { request = handler; }, snapshot(next: typeof initial) {
    current = next; source.handlers.get('snapshot')!({ data: JSON.stringify(next) });
  } };
}

test('create → connect → create preserves description, validates project and retains connection errors', async t => {
  const page = await app(t);
  button(page.render(), 'Создать задачу').props.onClick();
  let create = modal(page.render(), 'Новая задача');
  assert.equal(create.props.open, true);
  elements(create).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Draft before connecting' } });
  create = modal(page.render(), 'Новая задача');
  assert.equal(button(create, 'Добавить в Backlog').props.disabled, true);
  await submit(create); assert.equal(page.calls.length, 0, 'no project cannot submit even through the handler');
  button(create, 'Подключить проект').props.onClick();
  const connect = () => modal(page.render(), 'Подключить проект');
  assert.equal(connect().props.open, true);
  assert.equal(modal(page.render(), 'Новая задача').props.open, false);
  elements(connect()).find(node => node.props.name === 'checkout').props.onChange({ target: { value: '/tmp/connected' } });
  const fields = { checkout: '/tmp/connected', remote: 'origin', target_branch: 'main', hosting: 'github' };
  const form = { fields, reset() { resets++; } };
  let resets = 0;
  page.respond(async () => { throw new Error('CLI auth failed'); });
  await submit(connect(), form);
  assert.equal(resets, 0);
  assert.equal(elements(connect()).find(node => node.props.name === 'checkout').props.value, fields.checkout);
  assert.ok(elements(connect()).some(node => node.props.role === 'alert' && node.props.children === 'CLI auth failed'));
  const p = project('connected');
  page.respond(async () => { page.snapshot(snapshot([p])); return p; });
  await submit(connect(), form);
  assert.equal(resets, 1);
  assert.equal(connect().props.open, false);
  create = modal(page.render(), 'Новая задача');
  assert.equal(create.props.open, true);
  assert.equal(elements(create).find(node => node.type === 'textarea').props.value, 'Draft before connecting');
  assert.equal(elements(create).find(node => node.type === 'select').props.value, p.id);
  assert.equal(button(create, 'Добавить в Backlog').props.disabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(page.calls[1])), ['/projects', 'POST', { ...fields, state_version: 0 }]);
  elements(create).find(node => node.type === 'textarea').props.onChange({ target: { value: '   ' } });
  create = modal(page.render(), 'Новая задача');
  assert.equal(button(create, 'Добавить в Backlog').props.disabled, true);
  await submit(create); assert.equal(page.calls.length, 2, 'whitespace description is rejected');
});

test('task failure survives reopening; duplicate submit is blocked and retry preserves request identity', async t => {
  const page = await app(t, snapshot([project('one')]));
  button(page.render(), 'Создать задачу').props.onClick();
  const create = () => modal(page.render(), 'Новая задача');
  elements(create()).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Keep exact draft\n' } });
  let reject!: (error: Error) => void;
  page.respond(() => new Promise((_resolve, fail) => { reject = fail; }));
  const before = create(), pending = submit(before);
  await submit(before); await submit(create());
  assert.equal(page.calls.length, 1, 'ref blocks repeated calls both before and after render');
  assert.equal(elements(create()).find(node => node.type === 'fieldset').props.disabled, true);
  reject(new Error('Response lost')); await pending;
  create().props.close();
  assert.equal(create().props.open, false);
  button(page.render(), 'Создать задачу').props.onClick();
  assert.equal(elements(create()).find(node => node.type === 'textarea').props.value, 'Keep exact draft\n');
  assert.ok(elements(create()).some(node => node.props.role === 'alert' && node.props.children === 'Response lost'));
  assert.equal(button(create(), 'Добавить в Backlog').props.disabled, false);
  page.respond(async () => ({}));
  await submit(create());
  assert.equal(page.calls.length, 2);
  assert.deepEqual(page.calls[1], page.calls[0], 'lost response retry keeps the backend idempotency inputs');
  assert.equal(page.calls[1][0], '/projects/one/tasks');
  assert.equal(page.calls[1][2].state_version, 1);
  assert.equal(create().props.open, false);
  button(page.render(), 'Создать задачу').props.onClick();
  assert.equal(elements(create()).find(node => node.type === 'textarea').props.value, '');
  assert.ok(!elements(create()).some(node => node.props.role === 'alert'));
});

test('project deletion snapshot clears filter and draft project without losing description', async t => {
  const one = project('one'), two = project('two');
  const page = await app(t, snapshot([one, two]));
  const selector = () => elements(page.render()).find(node => node.props.id === 'project-selector');
  elements(selector()).find(node => node.type === 'select').props.onChange({ target: { value: two.id } });
  button(page.render(), 'Создать задачу').props.onClick();
  const create = () => modal(page.render(), 'Новая задача');
  assert.equal(elements(create()).find(node => node.type === 'select').props.value, two.id);
  elements(create()).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Keep after deletion' } });
  page.snapshot(snapshot([one]));
  const choice = elements(create()).find(node => node.type === 'select');
  assert.equal(choice.props.value, '');
  assert.ok(!elements(choice).some(node => node.type === 'option' && node.props.value === two.id));
  assert.equal(elements(selector()).find(node => node.type === 'select').props.value, '');
  assert.ok(button(page.render(), 'Удалить проект').props.disabled);
  assert.equal(button(create(), 'Добавить в Backlog').props.disabled, true);
  await submit(create()); assert.equal(page.calls.length, 0);
  create().props.close(); button(page.render(), 'Создать задачу').props.onClick();
  assert.equal(elements(create()).find(node => node.type === 'textarea').props.value, 'Keep after deletion');
  assert.equal(elements(create()).find(node => node.type === 'select').props.value, '', 'reopening cannot resurrect a deleted ID');
  elements(create()).find(node => node.type === 'select').props.onChange({ target: { value: one.id } });
  page.respond(async () => ({})); await submit(create());
  assert.equal(page.calls[0][0], '/projects/one/tasks');
  assert.equal(page.calls[0][2].description, 'Keep after deletion');
});

test('toast expires at 5 seconds, pauses on hover/focus, and persistent notices require dismissal', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  for (const scenario of ['expiry', 'hover', 'focus', 'persistent']) {
    const runtime = hooks();
    const { Toast } = load('windows', { react: runtime.react, 'react/jsx-runtime': jsx }, { Date, setTimeout, clearTimeout });
    let dismissed = 0;
    const notice = { id: 1, text: 'Notice', persistent: scenario === 'persistent' };
    const render = () => runtime.render(() => Toast({ notice, dismiss: () => { dismissed++; } }));
    try {
      let tree = render();
      assert.equal(elements(tree).find(node => node.type === 'p').props.role, notice.persistent ? 'alert' : 'status');
      t.mock.timers.tick(2000); assert.equal(dismissed, 0);
      tree = render(); // App supplies a new dismiss callback on each render; elapsed time must survive.
      if (scenario === 'hover' || scenario === 'focus') {
        if (scenario === 'hover') tree.props.onMouseEnter(); else tree.props.onFocusCapture();
        tree = render(); t.mock.timers.tick(10000); assert.equal(dismissed, 0, `${scenario} pauses expiration`);
        if (scenario === 'focus') {
          tree.props.onBlurCapture({ currentTarget: { contains: () => true }, relatedTarget: {} });
          tree = render(); t.mock.timers.tick(10000); assert.equal(dismissed, 0, 'focus within toast remains paused');
          tree.props.onBlurCapture({ currentTarget: { contains: () => false }, relatedTarget: null });
        } else tree.props.onMouseLeave();
        render();
      }
      if (notice.persistent) {
        t.mock.timers.tick(60000); assert.equal(dismissed, 0, 'important notices never auto-dismiss');
      } else {
        t.mock.timers.tick(2999); assert.equal(dismissed, 0);
        t.mock.timers.tick(1); assert.equal(dismissed, 1, `${scenario}: only unpaused time counts`);
      }
      button(tree, '×').props.onClick();
      assert.equal(dismissed, notice.persistent ? 1 : 2, 'manual dismissal remains available');
    } finally { runtime.dispose(); }
  }
});


test('settings drafts retain values on failure/conflict, guard duplicate sends and reset only the changed role', async t => {
  const runtime = hooks(); t.after(() => runtime.dispose());
  const initial = { models: { ...shared.defaultModels }, instructions: 'Original', reasoning_efforts: { spec: 'high', build: 'low' } };
  let saved: shared.Settings = initial, state_version = 1, failure = '', sends = 0, release: (() => void) | undefined;
  const api = async (path: string, method: string, payload: any) => {
    if (path.endsWith('/models')) return { source: 'codex', updated_at: null, models: [] };
    if (method !== 'PUT') return { ...saved, state_version };
    sends++; await new Promise<void>(resolve => { release = resolve; });
    if (failure) throw new Error(failure);
    const { state_version: version, ...config } = payload;
    assert.equal(version, state_version); saved = config; state_version++; return saved;
  };
  const { ModelSettings } = load('main', {
    react: runtime.react, 'react/jsx-runtime': jsx, 'react-dom/client': { createRoot: () => ({ render() {} }) },
    './api.js': { api }, './theme.js': { readTheme: () => 'system', applyTheme() {} },
    '../shared.js': shared, './stageHistory.js': stageHistory, './TaskMarkdown.js': { TaskMarkdown },
    './windows.js': {}, './models.js': { ModelPicker, ReasoningPicker }, './chat.js': {}, './output.js': {}, './taskView.js': {}, './style.css': {},
  }, { document: { getElementById: () => ({}) } });
  const current = project('one');
  const render = () => runtime.render(() => ModelSettings({ project: current, refresh: async () => { current.state_version = state_version; } }));
  render(); await setImmediate();
  const picker = (role: string) => elements(render()).find(node => node.type === ModelPicker && node.props.role === role);
  const effort = (role: string) => elements(render()).find(node => node.type === ReasoningPicker && node.props.role === role);
  picker('spec').props.onChange('manual-model');
  assert.equal(effort('spec').props.value, ''); assert.equal(effort('build').props.value, 'low');
  effort('spec').props.onChange('medium');
  elements(render()).find(node => node.props['aria-label'] === 'Fast · spec').props.onChange({ target: { checked: true } });
  assert.equal(effort('spec').props.value, 'medium'); assert.equal(picker('spec').props.value, 'manual-model');
  elements(render()).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Draft \nunchanged' } });
  failure = 'Network unavailable';
  const pending = submit(render()); await submit(render()); assert.equal(sends, 1); release!(); await pending;
  assert.equal(elements(render()).find(node => node.type === 'textarea').props.value, 'Draft \nunchanged');
  assert.match(elements(render()).find(node => node.props.role === 'alert' && node.props.className === 'error').props.children, /Network/);
  failure = 'Настройки изменились';
  const conflicted = submit(render()); release!(); await conflicted;
  assert.equal(effort('spec').props.value, 'medium');
  current.state_version = 2; state_version = 2;
  assert.equal(button(render(), 'Сохранить настройки').props.disabled, true);
  await button(render(), 'Отменить / загрузить сохранённые').props.onClick();
  assert.equal(picker('spec').props.value, initial.models.spec);
  assert.equal(effort('spec').props.value, 'high');
  assert.equal(elements(render()).find(node => node.props['aria-label'] === 'Fast · spec').props.checked, false);
  assert.equal(button(render(), 'Сохранить настройки').props.disabled, false);
  failure = '';
  const successful = submit(render()); release!(); await successful;
  assert.equal(saved.fast_modes, undefined, 'saving instructions must not materialize legacy false');
  assert.equal(button(render(), 'Сохранить настройки').props.disabled, false);
});

test('effort stops contain only catalog states and expose current/default/unconfirmed values', () => {
  for (const options of [undefined, [], [{ effort: 'medium', description: 'Only medium' }], [{ effort: 'low', description: '' }, { effort: 'max', description: 'Max' }]]) {
    let selected = 'saved-unknown';
    const tree = ReasoningPicker({ role: 'build', value: selected, model: { id: 'm', name: 'M', reasoning_efforts: options }, onChange: value => { selected = value; } });
    const radios = elements(tree).filter(node => node.type === 'input');
    assert.deepEqual(radios.map(radio => radio.props.value), ['', ...(options?.map(option => option.effort) ?? [])]);
    assert.ok(radios.every(radio => radio.props['aria-label'].includes('build')));
    assert.match(elements(tree).find(node => node.props['aria-live'] === 'polite').props.children.join(''), /saved-unknown/);
    elements(tree).find(node => node.type === 'button').props.onClick(); assert.equal(selected, '');
    radios.at(-1)!.props.onChange(); assert.equal(selected, options?.at(-1)?.effort ?? '');
  }
});


test('manual Model ID uses a valid HTML Unicode Sets pattern', () => {
  const runtime = hooks();
  const { ModelPicker: Picker } = load('models', { react: runtime.react, 'react/jsx-runtime': jsx });
  const render = () => runtime.render(() => Picker({ role: 'spec', value: 'custom/model-v1', catalog: [], onChange() {} }));
  elements(render()).find(node => node.type === 'select').props.onChange({ target: { value: '' } });
  const pattern = elements(render()).find(node => node.type === 'input').props.pattern;
  const regex = new RegExp(`^(?:${pattern})$`, 'v');
  assert.equal(regex.test('custom/model-v1:2026_10.15'), true);
  for (const invalid of ['bad model', '-model', 'model?key=value']) assert.equal(regex.test(invalid), false);
  runtime.dispose();
});
