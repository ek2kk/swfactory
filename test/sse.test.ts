import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { SavedEvent, Snapshot } from '../src/shared.js';
import { subscribe } from '../src/server/sse.js';

class Response extends EventEmitter {
  chunks: string[] = [];
  blockAt = 0;
  destroyed = false;
  writableEnded = false;
  write(chunk: string) {
    assert.equal(this.destroyed, false, 'no writes after disconnect');
    this.chunks.push(chunk);
    return this.chunks.length !== this.blockAt;
  }
  destroy() { this.destroyed = true; this.emit('close'); }
}
function fixture(count = 2, cursor = 0) {
  const response = new Response();
  const state: Snapshot = { cursor: 0, projects: [], tasks: [], runs: [], human_requests: [] };
  const events: SavedEvent[] = [];
  function add() {
    events.push({ id: ++state.cursor, type: 'test.change', task_id: null, payload: '{}', created_at: '' });
  }
  for (let i = 0; i < count; i++) add();
  let snapshots = 0, batches = 0, closed = 0;
  const store = { events(after: number) { batches++; return events.filter(event => event.id > after).slice(0, 500); } };
  const snapshot = () => { snapshots++; return structuredClone(state); };
  const subscription = subscribe(response as unknown as ServerResponse, cursor, store, snapshot, () => closed++);
  return { response, state, add, store, snapshot, subscription, counts: () => ({ snapshots, batches, closed }) };
}
function frames(response: Response) {
  return response.chunks.filter(chunk => !chunk.startsWith(':')).map(chunk => {
    const match = chunk.match(/^id: (\d+)\nevent: (\w+)\ndata: (.+)\n\n$/s)!;
    return { id: Number(match[1]), event: match[2], data: JSON.parse(match[3]) };
  });
}

for (const [kind, blockAt] of [['change', 1], ['snapshot', 3], ['heartbeat', 4]] as const) {
  test(`SSE backpressure on ${kind} waits for drain without duplicating the accepted chunk`, t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const f = fixture(); t.after(() => f.subscription.close());
    f.response.blockAt = blockAt;
    f.subscription.update();
    if (kind === 'heartbeat') t.mock.timers.tick(15_000);
    assert.equal(f.response.chunks.length, blockAt);
    assert.equal(f.response.destroyed, false);
    const accepted = f.response.chunks.at(-1)!;
    f.add();
    for (let i = 0; i < 1000; i++) f.subscription.update();
    assert.equal(f.response.chunks.length, blockAt, 'no writes before drain');
    assert.equal(f.counts().snapshots, 1, 'notifications do not create queued snapshots');
    assert.equal(f.response.listenerCount('drain'), 1);
    f.response.emit('drain');
    assert.equal(f.response.chunks.filter(chunk => chunk === accepted).length, 1);
    const sent = frames(f.response);
    assert.deepEqual(sent.filter(frame => frame.event === 'change').map(frame => frame.id), [1, 2, 3]);
    assert.deepEqual(sent.filter(frame => frame.event === 'snapshot').map(frame => frame.id), [2, 3]);
    assert.deepEqual(sent.map(frame => frame.id), sent.map(frame => frame.id).toSorted((a, b) => a - b));
    assert.equal(f.counts().snapshots, 2);
  });
}

test('SSE updates during the initial snapshot are sent after drain', t => {
  const f = fixture(2, 2); t.after(() => f.subscription.close());
  f.response.blockAt = 1;
  f.subscription.update();
  f.add(); f.subscription.update();
  assert.equal(f.response.chunks.length, 1);
  f.response.emit('drain');
  assert.deepEqual(frames(f.response).map(frame => [frame.event, frame.id]), [['snapshot', 2], ['change', 3], ['snapshot', 3]]);
});

test('SSE bounds every replay batch by its snapshot cursor across drain and the 500-event boundary', t => {
  const f = fixture(1100); t.after(() => f.subscription.close());
  f.response.blockAt = 1; f.subscription.update();
  f.add(); f.subscription.update();
  f.response.blockAt = 501; f.response.emit('drain');
  assert.equal(f.response.chunks.length, 501);
  assert.equal(f.counts().batches, 2);
  f.add(); f.subscription.update();
  f.response.emit('drain');
  const sent = frames(f.response);
  assert.deepEqual(sent.filter(frame => frame.event === 'change').map(frame => frame.id), Array.from({ length: 1102 }, (_, i) => i + 1));
  assert.deepEqual(sent.filter(frame => frame.event === 'snapshot').map(frame => frame.id), [1100, 1102]);
  assert.deepEqual(sent.map(frame => frame.id), sent.map(frame => frame.id).toSorted((a, b) => a - b));
  assert.equal(f.counts().batches, 4);
});

test('SSE coalesces publish and heartbeat while preserving errors without a new event ID and serving another client', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const slow = fixture(2, 2); t.after(() => slow.subscription.close());
  const response = new Response();
  const fast = subscribe(response as unknown as ServerResponse, 2, slow.store, slow.snapshot, () => {});
  t.after(() => fast.close());
  slow.response.blockAt = 1; slow.subscription.update(); fast.update();
  for (let i = 0; i < 1000; i++) {
    slow.state.execution_error = `Service error ${i}`;
    slow.subscription.update(); fast.update();
    t.mock.timers.tick(15_000);
  }
  assert.equal(slow.response.chunks.length, 1);
  for (const event of ['drain', 'close', 'error']) assert.equal(slow.response.listenerCount(event), 1);
  assert.equal(frames(response).at(-1)!.data.execution_error, 'Service error 999');
  slow.response.emit('drain');
  assert.equal(slow.response.chunks.length, 3, 'one latest snapshot and one coalesced heartbeat');
  assert.equal(frames(slow.response).at(-1)!.data.execution_error, 'Service error 999');
  assert.deepEqual(frames(slow.response).map(frame => frame.id), [2, 2]);
});

for (const reason of ['disconnect', 'error', 'shutdown'] as const) {
  test(`SSE ${reason} during backpressure releases the sender and timer without waiting for drain`, t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const f = fixture();
    f.response.blockAt = 1; f.subscription.update(); f.subscription.update();
    if (reason === 'disconnect') f.response.destroy();
    else if (reason === 'error') f.response.emit('error', new Error('connection failed'));
    else f.subscription.close();
    const counts = f.counts();
    assert.equal(counts.closed, 1);
    assert.equal(f.response.destroyed, true);
    for (const event of ['drain', 'close', 'error']) assert.equal(f.response.listenerCount(event), 0);
    f.response.emit('drain'); f.subscription.update(); t.mock.timers.tick(60_000); f.subscription.close();
    assert.equal(f.response.chunks.length, 1);
    assert.deepEqual(f.counts(), counts, 'no Store access or repeated cleanup after close');
  });
}

test('SSE write failure closes the client and does not escape into publish', t => {
  const f = fixture(); t.after(() => f.subscription.close());
  t.mock.method(f.response, 'write', () => { throw new Error('socket closed'); });
  assert.doesNotThrow(() => f.subscription.update());
  assert.equal(f.response.destroyed, true);
  assert.equal(f.counts().closed, 1);
});
