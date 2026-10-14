import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentRun, ChatMessage, Task, TranscriptEntry, HumanRequest, SavedEvent } from '../shared.js';

import { HistoryFlow } from './taskView.js';
import { stageTimeline } from './stageHistory.js';

type Api = <T>(path: string, method?: string, body?: Record<string, unknown>) => Promise<T>;
const delivery = { queued: 'Ожидает доставки', sending: 'Передаём в CLI', delivered: 'Принято активным turn', failed: 'Не доставлено', unknown: 'Доставка неизвестна — нужна сверка', applied: 'Требования применены · запустите новую Spec', revoked: 'Отозвано: требования изменились' };
export function Message({ message }: { message: ChatMessage }) {
  return <article className="chat-message user-message"><p className="meta">Вы · {message.kind === 'requirements' ? 'Изменение требований' : 'Сообщение агенту'} · Версия требований: {message.revision}</p>
    <p className="description">{message.text}</p><p className="meta">{message.kind === 'requirements' && message.status === 'queued' ? 'Ожидает применения после текущего этапа' : delivery[message.status]} · {new Date(message.created_at).toLocaleString('ru')}</p>
    {message.error && <p role="status">{message.error}</p>}</article>;
}
export function RunConversation({ runs, role, revision, path, api, messages, requests, active = true, report }: {
  runs: AgentRun[]; role: AgentRun['role']; revision: number; path: string; api: Api; messages: ChatMessage[]; requests: HumanRequest[];
  active?: boolean; report?: (run: AgentRun) => ReactNode;
}) {
  const [entries, setEntries] = useState<Record<string, TranscriptEntry[]>>({});
  const [events, setEvents] = useState<SavedEvent[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const offsets = useRef<Record<string, number>>({});
  const drained = useRef<Record<string, AgentRun['status']>>({});
  const eventOffset = useRef(0);
  const start = useRef<HTMLDivElement>(null);
  const selected = runs.filter(run => run.role === role);
  const signature = selected.map(run => `${run.id}:${run.status}:${run.diagnostic?.result_run_id ?? ''}`).join('|');
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let more = false;
      await Promise.all([
        ...selected.filter(run => run.status !== 'queued' && !run.diagnostic?.result_run_id && drained.current[run.id] !== run.status).map(async run => {
          try {
            const page = await api<{ entries: TranscriptEntry[]; next_offset: number; more: boolean }>(`${path}/runs/${run.id}/transcript?offset=${offsets.current[run.id] ?? 0}`);
            if (disposed) return;
            offsets.current[run.id] = page.next_offset; more ||= page.more;
            if (!page.more && run.status !== 'running') drained.current[run.id] = run.status;
            setEntries(values => {
              const previous = values[run.id] ?? [];
              const ids = new Set(previous.map(entry => entry.id));
              const added = page.entries.filter(entry => !ids.has(entry.id));
              return added.length ? { ...values, [run.id]: [...previous, ...added] } : values;
            });
            setErrors(values => ({ ...values, [run.id]: '' }));
          } catch (error) { if (!disposed) setErrors(values => ({ ...values, [run.id]: (error as Error).message })); }
        }),
        (async () => {
          try {
            const page = await api<{ events: SavedEvent[]; next_id: number; more: boolean }>(`${path}/events?after=${eventOffset.current}`);
            if (disposed) return;
            eventOffset.current = page.next_id; more ||= page.more;
            setEvents(values => {
              const ids = new Set(values.map(event => event.id));
              const added = page.events.filter(event => !ids.has(event.id));
              return added.length ? [...values, ...added] : values;
            });
            setErrors(values => ({ ...values, events: '' }));
          } catch (error) { if (!disposed) setErrors(values => ({ ...values, events: (error as Error).message })); }
        })(),
      ]);
      if (disposed) return;
      setLoaded(true);
      timer = setTimeout(poll, more ? 0 : 1000);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [active, signature, path, retry]);
  const timeline = stageTimeline(runs, entries, messages, events, requests).filter(item => item.run?.role === role || item.message?.run_id && selected.some(run => run.id === item.message?.run_id));
  return <section className="conversation" aria-label="История работы">
    <div ref={start} className="actions"><button className="secondary" onClick={() => start.current?.scrollIntoView({ block: 'start' })}>К последним сообщениям</button></div>
    <HistoryFlow>{timeline.map(item => <div key={item.id} data-history-id={item.id}>
      {item.kind !== 'report' && item.run && (item.run.stale || item.run.description_revision !== revision) && <span className="meta">↺ Неактуально · Версия требований: {item.run.description_revision}</span>}
      {item.kind === 'message' ? <Message message={item.message!} /> : item.kind === 'report' ? report?.(item.run!) :
        <article className={`chat-message ${item.kind}-message${item.alert ? ' history-alert' : ''}`}>
          {item.kind === 'tool' ? <details><summary>{item.title}{item.status && ` · ${item.status}`} · {item.text.split('\n')[0]?.slice(0, 150) || 'Детали вызова'}</summary><pre>{item.text}</pre></details> : <>
            {item.kind !== 'agent' && <p className="meta">{item.title}{item.status && ` · ${item.status}`}{item.at && <> · <time dateTime={item.at}>{new Date(item.at).toLocaleString('ru')}</time></>}</p>}
            {item.text && <pre role={item.alert ? 'alert' : undefined}>{item.text}</pre>}
          </>}
        </article>}
    </div>)}</HistoryFlow>
    {!loaded && <p role="status">Загружаем историю…</p>}
    {loaded && !timeline.length && !Object.values(errors).some(Boolean) && <p className="hint">Сообщений пока нет.</p>}
    {Object.entries(errors).filter(([, error]) => error).map(([id, error]) => <p key={id} role="status">{error} <button className="secondary" onClick={() => setRetry(value => value + 1)}>Повторить загрузку</button></p>)}
  </section>;
}
export function Composer({ task, path, api, refresh }: { task: Task; path: string; api: Api; refresh: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const blocked = !!task.publication_status || task.run_state === 'interrupted';
  return <form className="composer" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError(''); setSent(false);
    try { await api(`${path}/messages`, 'POST', { state_version: task.state_version, text, kind: 'guidance' }); setText(''); setSent(true); await refresh(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }}>
    <label>Сообщение агенту<textarea value={text} maxLength={4096} disabled={busy} onChange={e => { setText(e.target.value); setSent(false); }} placeholder="Уточните направление работы…" /></label>
    <div className="actions"><button disabled={busy || blocked || !text.trim()}>{busy ? 'Сохраняем…' : 'Отправить'}</button></div>
    <p className="hint">{blocked ? 'После прерывания или публикации нужна ручная сверка. Черновик остаётся здесь.'
      : 'Во время работы сообщение передаётся активному агенту; между запусками ждёт следующий. Ответы на обязательные вопросы и разрешение публикации задаются на вкладке «Обзор».'}</p>
    {sent && <p role="status">Сообщение сохранено. Статус доставки — в истории.</p>}{error && <p role="alert">{error}</p>}
  </form>;
}
