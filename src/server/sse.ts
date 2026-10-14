import type { ServerResponse } from 'node:http';
import type { Snapshot } from '../shared.js';
import type { Store } from './store.js';

export function subscribe(response: ServerResponse, cursor: number, store: Pick<Store, 'events'>,
  snapshot: () => Snapshot, onClose: () => void) {
  let closed = false, sending = false, blocked = false, pending = false, heartbeatPending = false;
  let current: Generator<string> | undefined;

  function* update() {
    const state = snapshot();
    while (cursor < state.cursor) {
      // Mutations during drain belong to the next snapshot, never this replay.
      const events = store.events(cursor).filter(event => event.id <= state.cursor);
      if (!events.length) break;
      for (const event of events) {
        cursor = event.id;
        yield `id: ${event.id}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`;
      }
    }
    cursor = state.cursor;
    yield `id: ${state.cursor}\nevent: snapshot\ndata: ${JSON.stringify(state)}\n\n`;
  }
  function stop() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    response.off('drain', drain);
    response.off('close', stop);
    response.off('error', close);
    current?.return(undefined);
    current = undefined;
    pending = heartbeatPending = false;
    onClose();
  }
  function close() { stop(); response.destroy(); }
  function pump() {
    if (closed || sending || blocked) return;
    if (response.destroyed || response.writableEnded) { close(); return; }
    sending = true;
    try {
      while (!closed && !blocked) {
        if (!current && pending) { pending = false; current = update(); }
        let chunk: string;
        if (current) {
          const next = current.next();
          if (next.done) { current = undefined; continue; }
          chunk = next.value;
        } else if (heartbeatPending) {
          heartbeatPending = false;
          chunk = ': heartbeat\n\n';
        } else break;
        // false accepts this chunk; only subsequent writes wait for drain.
        blocked = !response.write(chunk);
      }
    } catch { close(); }
    finally { sending = false; }
  }
  function drain() { blocked = false; pump(); }
  const heartbeat = setInterval(() => { heartbeatPending = true; pump(); }, 15_000);
  response.on('drain', drain);
  response.on('close', stop);
  response.on('error', close);
  return {
    update() { if (!closed) { pending = true; pump(); } },
    close,
  };
}
