import { useEffect, useState } from 'react';
import type { AgentRun } from '../shared.js';

export function RunProgress({ run, onInterrupt, busy = false }: { run: AgentRun; onInterrupt?: () => void; busy?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.id, run.status]);
  const activity = run.diagnostic?.last_activity_at;
  const elapsed = run.started_at ? Math.max(0, Math.floor((now - Date.parse(run.started_at)) / 1000)) : 0;
  const idle = activity ? Math.max(0, Math.floor((now - Date.parse(activity)) / 1000)) : elapsed;
  return <section aria-label="Прогресс этапа">
    {run.status === 'running' && <p className="meta">Выполняется {Math.floor(elapsed / 60)} мин {elapsed % 60} с<br />
      Последняя активность: {activity ? <time dateTime={activity}>{new Date(activity).toLocaleTimeString('ru')}</time> : 'пока нет событий'}
      {` · ${idle} с назад`}</p>}
    {run.status === 'running' && elapsed >= 600 && <p role="status">Этап выполняется более 10 минут. {idle < 60 ? 'Данные продолжают поступать.' : 'Новых событий давно нет.'} Можно прервать этап, сохранив изменения.</p>}
    {onInterrupt && <button className="secondary" disabled={busy || !!run.diagnostic?.interrupt_requested_at} onClick={onInterrupt}>
      {run.diagnostic?.interrupt_requested_at ? 'Прерываем этап…' : 'Прервать этап'}
    </button>}
  </section>;
}

export function AgentOutput({ run, load }: {
  run: AgentRun; load: () => Promise<{ text: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<{ run: string; version: number; text: string } | null>(null);
  const [error, setError] = useState('');
  const long = (run.output_length ?? Array.from(run.output_preview ?? '').length) > 600;
  useEffect(() => {
    if (!open || !long || !run.output_version) return;
    let active = true;
    const version = run.output_version;
    setError('');
    load().then(value => { if (active) setFull({ run: run.id, version, text: value.text }); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [open, long, run.id, run.output_version]);
  const current = full?.run === run.id && full.version === run.output_version;
  return <section className="agent-output" aria-label="Последнее сообщение агента">
    {run.output_preview ? <>
      <pre className="latest-message">{open && long ? current ? full.text : error ? run.output_preview + '…' : 'Загружаем сообщение…' : run.output_preview + (long ? '…' : '')}</pre>
      {open && long && error && <p role="alert">{error} <button className="secondary" onClick={() => { setOpen(false); setError(''); }}>Вернуться к сокращённому тексту</button></p>}
      {long && <button className="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Свернуть' : 'Развернуть'}</button>}
    </> : <p className="hint">{['queued', 'running'].includes(run.status)
      ? 'Ожидаем первое сообщение агента.' : 'Агент не передал текстовых сообщений.'}</p>}
  </section>;
}
