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
    './statistics.js': { TaskStatistics() {}, RunStatistics() {}, StatisticsWindow() {} }, './TaskMarkdown.js': { TaskMarkdown }, './windows.js': {},
    './taskView.js': {}, './chat.js': { Composer() {}, Message() {}, RunConversation() {} },
    './output.js': { AgentOutput() {}, RunProgress() {} },
  };
  runInNewContext(transformSync(source.replace(/createRoot\(document[^\n]+/, 'export { TaskCard, ArchivedTask, History, TaskResultsReset, TaskResultsRestart, ResetHistory, TaskDisposition, DependencyStatus };'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
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

test('dependency UI keeps keyboard target while pending, shows evidence/errors and guards repeats', async () => {
  const calls: unknown[][] = [];
  const view = taskCard(async (...args) => { calls.push(args); });
  view.props.task.stage = 'needs-human'; view.props.task.run_state = 'interrupted';
  const dependency = { kind: 'code', issue_url: 'https://github.com/owner/repo/issues/10', pr_url: 'https://github.com/owner/repo/pull/11', reason: 'API missing', condition: 'Merged API in main' };
  const check = { id: 'check', status: 'pending', reason: 'Checking', started_at: '2026-10-15T00:00:00Z', questions: [], results: [] };
  const origin = { ...view.props.runs[0], outcome: 'BLOCKED', diagnostic: { dependency_block: { reason: 'Needs API', dependencies: [dependency] }, dependency_checks: [check] } };
  let tree = elements(view.render('DependencyStatus', { runs: [origin], executionPaused: false }).tree);
  const button = tree.find(e => e.type === 'button');
  assert.equal(button.props.disabled, undefined); assert.equal(button.props['aria-disabled'], true); assert.equal(button.props['aria-busy'], true);
  await button.props.onClick(); assert.equal(calls.length, 0);
  assert.ok(tree.some(e => e.props.role === 'status' && e.props['aria-live'] === 'polite'));
  assert.equal(tree.filter(e => e.type === 'a').length, 2);
  Object.assign(check, { status: 'error', reason: 'GitHub timeout', finished_at: '2026-10-15T00:01:00Z' });
  tree = elements(view.render('DependencyStatus', { runs: [origin], executionPaused: false }).tree);
  assert.equal(tree.find(e => e.props.role === 'alert').props.children, 'GitHub timeout');
  await tree.find(e => e.type === 'button').props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['/projects/project/tasks/task/check-dependencies', 'POST', { state_version: 1, confirmation: '' }]);
  tree = elements(view.render('DependencyStatus', { runs: [origin], executionPaused: true }).tree);
  assert.equal(tree.find(e => e.type === 'button').props['aria-disabled'], true);
  const interrupted = { ...origin, id: 'resumed-run', outcome: null, status: 'interrupted', diagnostic: { dependency_resume: { blocked_run_id: origin.id, preserved_worktree: null } } };
  tree = elements(view.render('DependencyStatus', { runs: [origin, interrupted], executionPaused: false }).tree);
  assert.equal(tree.find(e => e.type === 'button').props['aria-disabled'], false);
});

test('non-code dependency presents a concrete required question and records human evidence separately', async () => {
  const calls: any[] = [], view = taskCard(async (...args) => { calls.push(args); });
  view.props.task.stage = 'needs-human'; view.props.task.run_state = 'interrupted';
  const d = { kind: 'condition', issue_url: 'https://github.com/owner/repo/issues/10', pr_url: null, reason: 'Approval', condition: 'Team approval' };
  const q = { text: 'Who approved and when?', context: 'Missing approval evidence', impact: 'Task remains stopped', options: [], required: true };
  const run = { ...view.props.runs[0], outcome: 'BLOCKED', diagnostic: { dependency_block: { reason: 'Need approval', dependencies: [d] }, dependency_checks: [{ id: 'check', status: 'blocked', questions: [q], results: [] }] } };
  let tree = elements(view.render('DependencyStatus', { runs: [run] }).tree);
  assert.ok(tree.some(e => e.type === 'strong' && e.props.children === q.text));
  tree.find(e => e.type === 'textarea').props.onChange({ target: { value: 'Team approved on 2026-10-15, meeting #10' } });
  tree = elements(view.render('DependencyStatus', { runs: [run] }).tree);
  await tree.find(e => e.type === 'button').props.onClick();
  assert.equal(calls[0][2].confirmation, 'Team approved on 2026-10-15, meeting #10');
});

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

test('reset confirmation previews exact cascade, focuses cancel and performs only an explicit reset', async () => {
  const plan = { state_version: 1, role: 'build', runs: [{ id: 'build-id', role: 'build' }, { id: 'review-id', role: 'review-code' }], restart: { role: 'build', reason: 'Новый worktree' } };
  const calls: any[][] = [], card = taskCard(async (...args) => { calls.push(args); return plan; });
  Object.assign(card.props.task, { has_results: 1 });
  const render = () => card.render('TaskResultsReset', { role: 'build' });
  const button = (tree: unknown, label: string) => elements(tree).find(node => node.type === 'button' && node.props.children === label);
  let returnedFocus = 0;
  const opener = button(render().tree, 'Сбросить результаты этапа');
  opener.props.ref.current = { focus() { returnedFocus++; } };
  await opener.props.onClick();
  const view = render(), dialog = elements(view.tree).find(node => node.type === 'dialog');
  let opened = 0, closed = 0, focused = 0;
  dialog.props.ref.current = { showModal() { opened++; }, close() { closed++; } };
  button(view.tree, 'Отмена').props.ref.current = { focus() { focused++; } };
  view.commit(); assert.equal(opened, 1); assert.equal(focused, 1);
  const text = JSON.stringify(dialog.props.children);
  for (const expected of ['build-id', 'review-id', 'PASS', 'sessions', 'Git worktrees', 'отдельный PR', 'GitHub issue', 'Markdown', 'автоматически', 'из чата']) assert.ok(text.includes(expected), expected);
  assert.ok(calls.every(call => call.length === 1), 'preview never mutates state');
  button(view.tree, 'Отмена').props.onClick(); assert.equal(closed, 1); assert.equal(returnedFocus, 1);
  await button(render().tree, 'Сбросить результаты этапа').props.onClick();
  await button(render().tree, 'Подтвердить сброс').props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['/projects/project/tasks/task/reset-results', 'POST', { state_version: 1, stage: 'build' }]);
  assert.ok(!elements(render().tree).some(node => node.type === 'dialog'));
});

test('reset UI explains barriers and invalidates a stale cascade confirmation', async () => {
  const button = (tree: unknown) => elements(tree).find(node => node.type === 'button' && node.props.children === 'Сбросить все результаты');
  for (const flags of [{ archived: 1 }, { execution_unverified: 1 }, { stop_unverified: 1 }, { deletion_state: 'stopping' }, { run_state: 'running' }, { run_state: 'queued' }, { publication_status: 'unknown' }, { publication_status: 'pending' }]) {
    const card = taskCard(); Object.assign(card.props.task, { has_results: 1 }, flags);
    const tree = card.render('TaskResultsReset').tree;
    assert.equal(button(tree).props.disabled, true, JSON.stringify(flags));
    const hint = elements(tree).find(node => node.props.id === 'reset-hint-task-all'); assert.ok(hint.props.children.length > 30);
  }
  const card = taskCard(async () => ({ state_version: 1, role: 'spec', runs: [], restart: { reason: 'Spec required' } }));
  Object.assign(card.props.task, { has_results: 1 });
  await button(card.render('TaskResultsReset').tree).props.onClick(); card.props.task.state_version++;
  const tree = card.render('TaskResultsReset').tree;
  assert.equal(elements(tree).find(node => node.type === 'button' && node.props.children === 'Подтвердить сброс').props.disabled, true);
  assert.ok(elements(tree).some(node => node.props.role === 'status' && node.props.children.includes('Карточка изменилась')));
});

test('every populated stage offers reset; restart uses a separate action and respects execution pause', async () => {
  const calls: any[][] = [], card = taskCard(async (...args) => { calls.push(args); });
  Object.assign(card.props.task, { results_restart: { role: 'build', reason: 'Fresh worktree' } });
  const resets = elements(card.render().tree).filter(node => node.type.name === 'TaskResultsReset' && node.props.role);
  assert.equal(resets.length, 6);
  assert.deepEqual(resets.filter(node => node.props.hasResults).map(node => node.props.role), ['build']);
  const restart = taskCard(async (...args) => { calls.push(args); });
  Object.assign(restart.props.task, { results_restart: { role: 'build', reason: 'Fresh worktree' } });
  let tree = restart.render('TaskResultsRestart', { executionPaused: true }).tree;
  assert.equal(elements(tree).find(node => node.type === 'button').props.disabled, true);
  tree = restart.render('TaskResultsRestart', { executionPaused: false }).tree;
  await elements(tree).find(node => node.type === 'button').props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/projects/project/tasks/task/restart-results', 'POST', { state_version: 1 }]]);
});

test('Stop is a single explicit action without observations, separate from archive and remote warning', async () => {
  for (const publication_status of ['pending', 'unknown', 'confirmed', null]) {
    const calls: any[][] = [], card = taskCard(async (...args) => { calls.push(args); return { deleted: true }; });
    Object.assign(card.props.task, { publication_status, title_state: 'completed' });
    const render = () => card.render('TaskDisposition');
    const button = (tree: unknown, label: string) => elements(tree).find(node => node.type === 'button' && (node.props.children === label || node.props['aria-label'] === label));
    let view = render();
    assert.ok(!elements(view.tree).some(node => node.type === 'textarea' || node.type === 'dialog'));
    assert.ok(button(view.tree, 'Архивировать'));
    await button(view.tree, 'Остановить').props.onClick();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/projects/project/tasks/task/stop', 'POST', { state_version: 1 }]]);
    button(render().tree, 'Архивировать').props.onClick(); view = render();
    await button(view.tree, 'Подтвердить архивирование').props.onClick();
    assert.equal(calls[1][0], '/projects/project/tasks/task/archive');
  }
  const card = taskCard(); Object.assign(card.props.task, { execution_warning: 'Known execution is still running' });
  assert.ok(elements(card.render('TaskDisposition').tree).some(node => node.type === 'button' && node.props.children === 'Повторить остановку'));
});

test('reset history exposes the previous PR identity without links to deleted run results', async () => {
  const calls: string[] = [];
  const card = taskCard(async (path: string) => {
    calls.push(path);
    return { resets: [{ id: 42, created_at: '2026-10-15T10:00:00Z', payload: JSON.stringify({ removed_runs: 6, previous_pr: { number: 73, url: 'https://github.com/owner/repo/pull/73', host: 'github.com', repository: 'owner/repo' } }) }] };
  });
  const details = elements(card.render('ResetHistory').tree).find(node => node.type === 'details');
  const target = { open: true }; details.props.onToggle({ target, currentTarget: target });
  card.render('ResetHistory').commit(); await new Promise(resolve => setImmediate(resolve));
  const links = elements(card.render('ResetHistory').tree).filter(node => node.type === 'a');
  assert.deepEqual(calls, ['/projects/project/tasks/task/history']);
  assert.equal(links.length, 1); assert.equal(links[0].props.href, 'https://github.com/owner/repo/pull/73');
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

test('pending Stop keeps its keyboard target and ignores a second activation', async () => {
  let finish!: (value: unknown) => void, calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const card = taskCard(async () => { calls++; return pending; });
  const stop = (tree: unknown) => elements(tree).find(node => node.type === 'button' && (node.props.children === 'Остановить' || node.props.children === 'Останавливаем…'));
  const request = stop(card.render('TaskDisposition').tree).props.onClick();
  const waiting = stop(card.render('TaskDisposition').tree);
  assert.equal(waiting.props.disabled, false); assert.equal(waiting.props['aria-disabled'], true); assert.equal(waiting.props['aria-busy'], true);
  await waiting.props.onClick(); assert.equal(calls, 1);
  finish({ deleted: true }); await request;
  assert.equal(stop(card.render('TaskDisposition').tree).props['aria-disabled'], false);
});
