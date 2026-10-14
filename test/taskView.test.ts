import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskView } from '../src/client/taskView.js';

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
