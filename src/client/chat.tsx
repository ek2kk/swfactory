import { useEffect, useRef, useState } from 'react';
import type { AgentRun, ChatMessage, Task, TranscriptEntry } from '../shared.js';

type Api = <T>(path: string, method?: string, body?: Record<string, unknown>) => Promise<T>;
const delivery = { queued: 'Ожидает доставки', sending: 'Передаём в CLI', delivered: 'Принято активным turn', failed: 'Не доставлено', unknown: 'Доставка неизвестна — нужна сверка', applied: 'Добавлено в новую редакцию · запустите Spec', revoked: 'Отозвано: редакция изменилась' };
export function Message({ message }: { message: ChatMessage }) {
  return <article className="chat-message user-message"><p className="meta">Вы · {message.kind === 'requirements' ? 'Изменение требований' : 'Указание'} · редакция {message.revision}</p>
    <p className="description">{message.text}</p><p className="meta">{delivery[message.status]} · {new Date(message.created_at).toLocaleString('ru')}</p>
    {message.error && <p role="status">{message.error}</p>}</article>;
}
export function RunConversation({ run, path, api, messages }: { run: AgentRun; path: string; api: Api; messages: ChatMessage[] }) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false, offset = 0;
    let timer: ReturnType<typeof setTimeout>;
    setEntries([]); setError(''); setLoaded(false);
    if (run.diagnostic?.result_run_id) { setLoaded(true); return; }
    async function poll() {
      try {
        const page = await api<{ entries: TranscriptEntry[]; next_offset: number; more: boolean }>(`${path}/runs/${run.id}/transcript?offset=${offset}`);
        if (disposed) return;
        offset = page.next_offset; setEntries(values => [...values, ...page.entries]); setError(''); setLoaded(true);
        if (page.more || ['queued', 'running'].includes(run.status)) timer = setTimeout(poll, page.more ? 0 : 1000);
      } catch (error) {
        if (disposed) return;
        setError((error as Error).message); setLoaded(true);
        if (['queued', 'running'].includes(run.status)) timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [run.id, run.status, run.diagnostic?.result_run_id, path, retry]);
  const timeline = [
    ...entries.map((entry, i) => ({ id: entry.id, at: entry.at || run.started_at || '', index: i, element: <article className={`chat-message ${entry.kind}-message`}>
      <p className="meta">{entry.title}{entry.status && ` · ${entry.status}`}</p>
      {entry.kind === 'tool' ? <details><summary>{entry.text.split('\n')[0]?.slice(0, 150) || 'Детали вызова'}</summary><pre>{entry.text}</pre></details> : <pre>{entry.text}</pre>}
    </article> })),
    ...messages.filter(m => m.run_id === run.id).map((message, i) => ({ id: message.id, at: message.created_at, index: i, element: <Message message={message} /> })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.index - b.index);
  return <section className="conversation" aria-label={`История ${run.role}`}>
    <div className="actions"><span className="meta">Редакция {run.description_revision} · {run.status}{run.stale ? ' · Неактуально' : ''}</span><button className="secondary" onClick={() => end.current?.scrollIntoView({ block: 'end' })}>К последним сообщениям</button></div>
    {timeline.map(item => <div key={item.id}>{item.element}</div>)}
    {run.diagnostic?.result_run_id && <p className="hint">Продолжение по сохранённому результату предыдущей попытки. Новый вызов модели не выполняется.</p>}
    {run.error && <p role="alert" className="error">{run.error}</p>}
    {!loaded && <p role="status">Загружаем историю…</p>}
    {loaded && !timeline.length && !error && !run.diagnostic?.result_run_id && <p className="hint">Сообщений пока нет. Текст появляется, когда CLI завершает сообщение; вызовы инструментов — при начале и завершении.</p>}
    {error && <p role="status">{error} <button className="secondary" onClick={() => setRetry(value => value + 1)}>Повторить загрузку</button></p>}
    <div ref={end} />
  </section>;
}
export function Composer({ task, path, api, refresh }: { task: Task; path: string; api: Api; refresh: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ChatMessage['kind']>('guidance');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const blocked = !!task.publication_status || task.run_state === 'interrupted';
  return <form className="composer" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError(''); setSent(false);
    try { await api(`${path}/messages`, 'POST', { state_version: task.state_version, text, kind }); setText(''); setSent(true); await refresh(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }}>
    <label>Сообщение агенту<textarea value={text} maxLength={4096} disabled={busy} onChange={e => { setText(e.target.value); setSent(false); }} placeholder="Уточните направление работы…" /></label>
    <div className="actions"><label>Тип сообщения<select disabled={busy} value={kind} onChange={e => setKind(e.target.value as ChatMessage['kind'])}><option value="guidance">Указание в рамках текущей Spec</option><option value="requirements">Изменение требований</option></select></label>
      <button disabled={busy || blocked || !text.trim()}>{busy ? 'Сохраняем…' : 'Отправить'}</button></div>
    <p className="hint">{blocked ? 'После прерывания или публикации нужна ручная сверка. Черновик остаётся здесь.' : kind === 'requirements'
      ? 'Уточнение добавится к описанию после текущего этапа. Прежние проверки потеряют актуальность; новую Spec нужно запустить явно.'
      : 'Во время работы сообщение передаётся активному turn; между запусками ждёт следующий. Ответы на обязательные вопросы и разрешение публикации задаются на вкладке «Обзор».'}</p>
    {sent && <p role="status">Сообщение сохранено. Статус доставки — в истории.</p>}{error && <p role="alert">{error}</p>}
  </form>;
}
