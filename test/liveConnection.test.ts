import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { transformSync } from 'esbuild';
import * as jsx from 'react/jsx-runtime';
import * as shared from '../src/shared.js';

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
        return [values[index], (value: unknown) => { values[index] = value; }];
      },
      useRef: (current: unknown) => ({ current }),
      useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    },
    'react-dom/client': { createRoot: () => ({ render: (element: { type: () => unknown }) => element.type() }) },
    './api.js': { api: async () => structuredClone(initial) },
    './theme.js': { readTheme: () => 'system', applyTheme: () => {} },
    '../shared.js': shared,
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
  } finally { for (const cleanup of cleanups) cleanup?.(); }
  assert.equal(sources[0].closes, 1, 'unmount closes the connection');
});
