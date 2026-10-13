import type { TranscriptEntry } from '../shared.js';
import { readLog } from './artifacts.js';
import { Problem } from './store.js';
import { formatOutput } from './output.js';

export function transcriptEntry(event: any, id: string): TranscriptEntry | null {
  const method = event?.method ?? event?.type;
  const item = event?.params?.item ?? event?.item;
  const text = (value: unknown): string => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  const at = typeof event?.recorded_at === 'string' ? event.recorded_at : '';
  const done = ['item/completed', 'item.completed'].includes(method);
  if (!item || !['item/started', 'item/completed', 'item.started', 'item.completed'].includes(method)) {
    if (['turn/completed', 'turn.completed', 'turn.failed', 'error'].includes(method)) return { id, at, kind: 'event', title: method, text: text(event.params?.turn?.status ?? event.params?.error?.message ?? event.error?.message) };
    return null;
  }
  if (['agentMessage', 'agent_message'].includes(item.type)) return done ? { id, at, kind: 'agent', title: 'Агент', text: formatOutput(text(item.text)) } : null;
  if (['userMessage', 'user_message'].includes(item.type)) return null;
  if (item.type === 'reasoning') return done && item.summary?.length ? { id, at, kind: 'agent', title: 'Краткое пояснение', text: text(item.summary) } : null;
  const titles: Record<string, string> = { commandExecution: 'Команда', command_execution: 'Команда', fileChange: 'Изменения файлов', file_change: 'Изменения файлов', mcpToolCall: 'Вызов инструмента', mcp_tool_call: 'Вызов инструмента', webSearch: 'Поиск', web_search: 'Поиск' };
  const content = [item.command, item.query, item.tool, item.arguments, item.aggregatedOutput ?? item.aggregated_output ?? item.output, item.result, item.changes, item.error].filter(v => v != null).map(text).join('\n\n');
  return { id, at, kind: 'tool', title: titles[item.type] ?? text(item.type), status: done ? text(item.status) || 'completed' : 'in_progress', text: content };
}

export function readTranscript(directory: string, runId: string, offset: number) {
  let raw = '', cursor = offset, more = false;
  // One event can cross log pages. Never advance past an incomplete JSONL line.
  do {
    const page = readLog(directory, runId, 'events.jsonl', cursor);
    raw += page.text; cursor = page.next_offset; more = page.more;
  } while (!raw.includes('\n') && more && raw.length <= 2 * 1024 * 1024);
  if (!raw.includes('\n') && more) throw new Problem(422, 'Событие превышает 2 MiB. Полный лог доступен в отчёте запуска.');
  const end = raw.lastIndexOf('\n') + 1;
  const complete = raw.slice(0, end);
  let position = offset;
  const entries: TranscriptEntry[] = [];
  for (const line of complete.split('\n')) {
    if (!line) continue;
    const id = `${runId}:${position}`;
    position += Buffer.byteLength(line + '\n');
    try { const entry = transcriptEntry(JSON.parse(line), id); if (entry) entries.push(entry); }
    catch { entries.push({ id, at: '', kind: 'event', title: 'Недоступное событие', text: 'CLI сохранил неполное или невалидное событие.' }); }
  }
  return { entries, next_offset: offset + Buffer.byteLength(complete), more };
}
