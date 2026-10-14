import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskView } from '../src/client/taskView.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as jsx from 'react/jsx-runtime';
import * as shared from '../src/shared.js';
import * as stageHistory from '../src/client/stageHistory.js';
import { TaskMarkdown } from '../src/client/TaskMarkdown.js';

function taskCard(api = async (..._args: any[]): Promise<any> => ({})) {
  const values: any[] = [];
  let index = 0, effects: (() => void)[] = [], draft: any;
  const source = readFileSync(new URL('../src/client/main.tsx', import.meta.url), 'utf8');
  const module = { exports: {} as any };
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': jsx,
    react: {
      useState(initial: unknown) {
        const slot = index++;
        if (!(slot in values)) values[slot] = initial;
        return [values[slot], (value: unknown) => { values[slot] = value; }];
      },
      useRef(current: unknown) { return values[index++] ??= { current }; },
      useEffect(callback: () => void) { effects.push(callback); },
    },
    '../shared.js': shared, './stageHistory.js': stageHistory,
    './theme.js': { applyTheme() {}, readTheme() {} },
    './style.css': {}, './models.js': {}, './api.js': { api }, 'react-dom/client': {},
    './TaskMarkdown.js': { TaskMarkdown },
    './taskView.js': {}, './chat.js': { Composer() {}, Message() {}, RunConversation() {} },
    './output.js': { AgentOutput() {}, RunProgress() {} },
  };
  runInNewContext(transformSync(source.replace(/createRoot\(document[^\n]+/, 'export { TaskCard, ArchivedTask, History };'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
    module, require(name: string) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
  });
  const props = {
    task: { id: 'task', project_id: 'project', description: 'Original requirements', stage: 'build', run_state: 'idle', state_version: 1, revision: 1 },
    project: { host: 'github.com', repository: 'owner/repo', checkout: '/test' },
    runs: [{ id: 'run', config: { models: { ...shared.defaultModels }, instructions: '' }, role: 'build', status: 'completed', outcome: 'READY', description_revision: 1 }],
    questions: [], active: false, cursor: 0, refresh: async () => {}, notify() {},
    setDraft(value: unknown) { draft = value; },
  };
  return { props, render(component = 'TaskCard', extraProps = {}) {
    index = 0; effects = [];
    const tree = module.exports[component]({ ...props, draft, ...extraProps });
    return { tree, commit: () => effects.forEach(effect => effect()) };
  }, get draft() { return draft; } };
}

function elements(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node?.props) return [];
  return [node, ...elements(node.props.children)];
}

test('task, archive and revision views share the renderer without changing their sources', async () => {
  const description = '# Requirements\n\n- [x] Saved  \n\n```txt\n  exact source\n```\n';
  const revision = { revision: 1, description, created_at: '2026-10-14T00:00:00Z' };
  const current = taskCard();
  current.props.task.description = description;
  assert.equal(elements(current.render().tree).find(node => node.type === TaskMarkdown).props.children, description);
  const history = taskCard();
  assert.equal(elements(history.render('History', { revisions: [revision] }).tree).find(node => node.type === TaskMarkdown).props.children, description);
  const archive = taskCard(async () => ({ revisions: [revision], messages: [], runs: [] }));
  archive.props.task.description = description;
  archive.render('ArchivedTask', { expanded: true }).commit();
  await new Promise(resolve => setImmediate(resolve));
  const sources = elements(archive.render('ArchivedTask', { expanded: true }).tree).filter(node => node.type === TaskMarkdown);
  assert.equal(sources.length, 2);
  assert.ok(sources.every(node => node.props.children === description));
});

test('editing, saving and reopening requirements use the exact Markdown source', async () => {
  const original = '  # Original\n\n- [x] Ready  \n';
  const updated = original + '\n```txt\n  keep <code> & spaces  \n```\n';
  const calls: any[][] = [];
  const card = taskCard(async (...args) => { calls.push(args); });
  card.props.task.description = original;
  const open = () => elements(card.render().tree).find(node => node.type === 'button' && node.props.children === 'Изменить требования').props.onClick();
  open();
  let textarea = elements(card.render().tree).find(node => node.type === 'textarea');
  assert.equal(textarea.props.value, original);
  textarea.props.onChange({ target: { value: updated } });
  const form = elements(card.render().tree).find(node => node.type === 'form');
  await form.props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/projects/project/tasks/task');
  assert.equal(calls[0][1], 'PATCH');
  assert.equal(calls[0][2].description, updated);
  card.props.task.description = calls[0][2].description;
  card.props.task.state_version++;
  assert.equal(elements(card.render().tree).find(node => node.type === TaskMarkdown).props.children, updated);
  open();
  textarea = elements(card.render().tree).find(node => node.type === 'textarea');
  assert.equal(textarea.props.value, updated);
});

test('opening requirements focuses its textarea once in idle, queued and running states', () => {
  for (const runState of ['idle', 'queued', 'running']) {
    const card = taskCard();
    card.props.task.run_state = runState;
    let focused = 0;
    let view = card.render(); view.commit();
    elements(view.tree).find(element => element.type === 'button' && element.props.children === 'Изменить требования').props.onClick();
    view = card.render();
    const textarea = elements(view.tree).find(element => element.type === 'textarea');
    assert.equal(textarea.props['aria-label'], runState === 'idle' ? 'Описание' : 'Уточнения требований');
    assert.ok(textarea.props.ref, 'the opening effect needs the mounted textarea');
    textarea.props.ref.current = { focus() { focused++; } };
    view.commit();
    assert.equal(focused, 1, `${runState}: opening focuses the form`);
    textarea.props.onChange({ target: { value: 'Draft requirements' } });
    view = card.render(); view.commit();
    assert.equal(focused, 1, `${runState}: editing must not steal focus`);
    card.props.task.state_version++;
    view = card.render(); view.commit();
    assert.equal(focused, 1, `${runState}: snapshot updates must not steal focus`);
  }
});

test('requirements cancellation restores focus to its opener and keeps the draft', () => {
  const card = taskCard();
  let focused = 0;
  const button = { focus() { focused++; } };
  const opener = (tree: unknown) => elements(tree).find(element => element.type === 'button' && element.props.children === 'Изменить требования');
  let view = card.render();
  opener(view.tree).props.ref.current = button; view.commit();
  assert.equal(focused, 0, 'mounting the card must not take focus');
  opener(view.tree).props.onClick();
  view = card.render(); view.commit();
  elements(view.tree).find(element => element.type === 'textarea').props.onChange({ target: { value: 'Unsaved requirements' } });
  view = card.render(); view.commit();
  elements(view.tree).find(element => element.type === 'button' && element.props.children === 'Отмена').props.onClick();
  view = card.render(); opener(view.tree).props.ref.current = button; view.commit();
  assert.equal(focused, 1);
  assert.equal(card.draft.description, 'Unsaved requirements');
  view = card.render(); view.commit();
  assert.equal(focused, 1, 'ordinary updates must not take focus');
  opener(view.tree).props.onClick();
  view = card.render(); view.commit();
  assert.equal(elements(view.tree).find(element => element.type === 'textarea').props.value, 'Unsaved requirements');
});

test('overview omits reports while stage history retains access to them', () => {
  const card = taskCard();
  const { tree } = card.render();
  const overview = elements(tree).find(element => element.props.id === 'task-panel-overview');
  assert.ok(overview);
  assert.equal(elements(overview).filter(element => element.type?.name === 'RunReport').length, 0);
  const stage = elements(tree).find(element => element.props.id === 'task-panel-build');
  const conversation = elements(stage).find(element => element.type?.name === 'RunConversation');
  assert.ok(conversation);
  const report = conversation.props.report(card.props.runs[0]);
  assert.equal(report.type.name, 'RunReport');
  assert.equal(report.props.run.id, 'run');
});

test('task presentation transfers focus on archive and unblock only from the replaced card', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let disabled = false, connected = true;
  const input = { get isConnected() { return connected; }, matches: () => disabled }, outside = {}, body = {};
  let activeElement: unknown = input, focused = 0;
  const heading = { focus() { activeElement = heading; focused++; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body, get activeElement() { return activeElement; } } });
  try {
    for (const blocked of [true, false]) {
      const previous = { blocked: !blocked, hidden: false, children: null };
      const view = new TaskView({ ...previous, blocked });
      view.container.current = {
        contains: (element: unknown) => element === input,
        querySelector: () => heading,
      } as unknown as HTMLDivElement;
      activeElement = input;
      const rendered = view.render();
      rendered.props.onFocusCapture({ target: input });
      const restoreFocus = view.getSnapshotBeforeUpdate();
      activeElement = outside; // Removal loses focus before componentDidUpdate.
      view.componentDidUpdate(previous, {}, restoreFocus);
      assert.equal(activeElement, heading);
      assert.equal(view.getSnapshotBeforeUpdate(), null, 'focus elsewhere is left alone');
      activeElement = input;
      view.componentDidUpdate(view.props, {}, view.getSnapshotBeforeUpdate());
      assert.equal(activeElement, input, 'ordinary SSE updates keep focus');
      activeElement = body; disabled = true;
      assert.equal(view.getSnapshotBeforeUpdate(), input, 'disabling a busy dialog button must not lose focus');
      disabled = false; connected = false;
      assert.equal(view.getSnapshotBeforeUpdate(), input, 'closing a dialog before SSE must not lose focus');
      connected = true;
      assert.equal(view.getSnapshotBeforeUpdate(), null, 'a connected enabled control does not justify taking focus from the page');
      const hidden = new TaskView({ ...view.props, hidden: true });
      hidden.container.current = view.container.current;
      assert.equal(hidden.getSnapshotBeforeUpdate(), null, 'a background card never takes focus');
    }
    assert.equal(focused, 2);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('manual archive of a restored blocked card focuses its summary when the dialog or opener disappears', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let connected = true, disabled = false, focused = 0;
  const button = { get isConnected() { return connected; }, matches: () => disabled }, body = {}, outside = {};
  let activeElement: unknown = button;
  const summary = { focus() { activeElement = summary; focused++; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body, get activeElement() { return activeElement; } } });
  try {
    const view = new TaskView({ blocked: true, hidden: false, children: null });
    view.container.current = { contains: (element: unknown) => element === button, querySelector: () => summary } as unknown as HTMLDivElement;
    view.render().props.onFocusCapture({ target: button });
    // The dialog's busy update must leave keyboard context alone.
    disabled = true; activeElement = body;
    view.componentDidUpdate(view.props, {}, view.getSnapshotBeforeUpdate());
    assert.equal(activeElement, body); assert.equal(focused, 0);
    disabled = false; activeElement = button;
    const snapshot = view.getSnapshotBeforeUpdate();
    connected = false; activeElement = body;
    view.componentDidUpdate(view.props, {}, snapshot);
    assert.equal(activeElement, summary, 'removal during an SSE update restores focus even though blocked stays true');
    activeElement = body;
    view.componentDidUpdate(view.props, {}, view.getSnapshotBeforeUpdate());
    assert.equal(activeElement, summary, 'closing the dialog before refresh also restores focus');
    activeElement = outside;
    assert.equal(view.getSnapshotBeforeUpdate(), null, 'focus outside the task is preserved');
    assert.equal(focused, 2);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('history prepends preserve a visible event even when the start of the flow is on screen', async () => {
  const { HistoryFlow } = await import('../src/client/taskView.js');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const scrolls: number[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerHeight: 800, scrollBy: (_x: number, y: number) => scrolls.push(y) } });
  let top = -400, eventTop = -20;
  const old = { dataset: { historyId: 'old' }, getBoundingClientRect: () => ({ top: eventTop, bottom: eventTop + 100 }) };
  const above = { dataset: { historyId: 'above' }, getBoundingClientRect: () => ({ top: -300, bottom: -100 }) };
  const view = new HistoryFlow({ children: null });
  view.element.current = { getBoundingClientRect: () => ({ top }), querySelectorAll: () => [above, old] } as unknown as HTMLDivElement;
  try {
    const anchor = view.getSnapshotBeforeUpdate();
    assert.deepEqual(anchor, { id: 'old', top: -20 });
    eventTop += 200;
    view.componentDidUpdate({}, {}, anchor);
    assert.deepEqual(scrolls, [200]);
    top = 100; eventTop = 100;
    const visibleStart = view.getSnapshotBeforeUpdate();
    assert.deepEqual(visibleStart, { id: 'old', top: 100 });
    eventTop += 600;
    view.componentDidUpdate({}, {}, visibleStart);
    assert.deepEqual(scrolls, [200, 600], 'a tall new message must not push the old fragment out of view');
    eventTop = 900;
    assert.equal(view.getSnapshotBeforeUpdate(), null, 'offscreen history does not move the page');
    eventTop = -100;
    assert.equal(view.getSnapshotBeforeUpdate(), null, 'events completely above the viewport are not anchors');
    eventTop = 0;
    old.getBoundingClientRect = () => ({ top: 0, bottom: 0 });
    assert.equal(view.getSnapshotBeforeUpdate(), null, 'hidden history does not move the page');
    view.componentDidUpdate({}, {}, null);
    assert.deepEqual(scrolls, [200, 600]);
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});


test('new UI/UX tab and historical separate UI/UX tabs expose the corresponding reports', () => {
  const card = taskCard();
  const original = card.props.runs[0];
  card.props.runs = [{ ...original, id: 'combined', role: 'review-ui-ux', outcome: 'PASS' }];
  let tree = card.render().tree;
  assert.ok(elements(tree).some(element => element.props.id === 'task-tab-review-ui-ux'));
  assert.ok(!elements(tree).some(element => element.props.id === 'task-tab-review-ui'));
  const legacy = { models: { ...shared.defaultModels, 'review-ui': 'old-ui', 'review-ux': 'old-ux' }, instructions: '' };
  delete legacy.models['review-ui-ux'];
  card.props.runs = ['review-ui', 'review-ux'].map(role => ({ ...original, config: legacy, id: role, role, outcome: 'PASS' }));
  tree = card.render().tree;
  assert.ok(!elements(tree).some(element => element.props.id === 'task-tab-review-ui-ux'));
  for (const role of ['review-ui', 'review-ux']) {
    const tab = elements(tree).find(element => element.props.id === `task-tab-${role}`);
    assert.ok(tab); tab.props.onClick();
    const panel = elements(card.render().tree).find(element => element.props.id === `task-panel-${role}`);
    assert.equal(panel.props.hidden, false);
    const conversation = elements(panel).find(element => element.type?.name === 'RunConversation');
    assert.equal(conversation.props.role, role);
    assert.equal(conversation.props.report(card.props.runs.find(run => run.role === role)).props.run.id, role);
  }
});

test('review tabs show skipped roles with reasons rather than successful PASS', () => {
  const card = taskCard();
  const build = card.props.runs[0];
  card.props.runs.unshift({ ...build, id: 'old-pass', role: 'review-security', outcome: 'PASS' });
  Object.assign(build, { review_plan: { build_id: build.id, revision: card.props.task.revision, checks: [
    { role: 'review-code', required: false, reason: 'CSS only' },
    { role: 'review-security', required: true, reuse_run_id: 'old-pass', reason: 'Trust boundary unchanged' },
    { role: 'review-ui-ux', required: true, reason: 'Recheck layout finding' },
  ] } });
  const nodes = elements(card.render().tree);
  const code = nodes.find(node => node.props.id === 'task-tab-review-code');
  assert.match(code.props['aria-label'], /Не требуется/); assert.equal(code.props.title, 'CSS only');
  assert.ok(!code.props.className.includes('success'));
  const security = nodes.find(node => node.props.id === 'task-tab-review-security');
  assert.match(security.props['aria-label'], /Предыдущий PASS применим/);
  assert.equal(security.props.title, 'Trust boundary unchanged');
});

test('partial CHANGES names blocking reviewer and exposes report and manual repair; other stops do not', () => {
  const card = taskCard();
  Object.assign(card.props.task, { stage: 'needs-human', run_state: 'interrupted' });
  const run = card.props.runs[0];
  Object.assign(run, { role: 'review-code', outcome: 'CHANGES', repair_attempt: 2, report: 1, stale: 0 });
  const nodes = elements(card.render().tree);
  assert.ok(nodes.some(n => n.type === 'p' && JSON.stringify(n.props.children).includes('Review · Code')));
  assert.ok(nodes.some(n => n.type?.name === 'RunReport' && n.props.run === run));
  assert.ok(nodes.some(n => n.type === 'button' && n.props.children === 'Доработать: новый цикл (до двух доработок)'));
  for (const outcome of ['NEEDS_INPUT', 'BLOCKED', null]) {
    Object.assign(run, { outcome });
    assert.ok(!elements(card.render().tree).some(n => n.type === 'button' && n.props.children === 'Доработать: новый цикл (до двух доработок)'));
  }
});
