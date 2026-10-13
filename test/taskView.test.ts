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
      const restoreFocus = view.getSnapshotBeforeUpdate(previous);
      activeElement = outside; // Removal loses focus before componentDidUpdate.
      view.componentDidUpdate(previous, {}, restoreFocus);
      assert.equal(activeElement, heading);
      assert.equal(view.getSnapshotBeforeUpdate(previous), false, 'focus elsewhere is left alone');
      activeElement = input;
      assert.equal(view.getSnapshotBeforeUpdate(view.props), false, 'ordinary SSE updates keep focus');
      activeElement = body; disabled = true;
      assert.equal(view.getSnapshotBeforeUpdate(previous), true, 'disabling a busy dialog button must not lose focus');
      disabled = false; connected = false;
      assert.equal(view.getSnapshotBeforeUpdate(previous), true, 'closing a dialog before SSE must not lose focus');
      connected = true;
      assert.equal(view.getSnapshotBeforeUpdate(previous), false, 'a connected enabled control does not justify taking focus from the page');
      const hidden = new TaskView({ ...view.props, hidden: true });
      hidden.container.current = view.container.current;
      assert.equal(hidden.getSnapshotBeforeUpdate(previous), false, 'a background card never takes focus');
    }
    assert.equal(focused, 2);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
