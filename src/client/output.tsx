import { useEffect, useState } from 'react';
import type { AgentRun, Task } from '../shared.js';

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
    <p className="meta">{run.role} · {run.status === 'running' ? `Выполняется ${Math.floor(elapsed / 60)} мин ${elapsed % 60} с` : run.status}<br />
      Последняя активность: {activity ? <time dateTime={activity}>{new Date(activity).toLocaleTimeString('ru')}</time> : 'пока нет событий'}
      {run.status === 'running' && ` · ${idle} с назад`}<br />
      Получено {run.diagnostic?.stream_updates ?? 0} фрагментов ответа · {run.diagnostic?.stream_chars ?? 0} символов. Текст показывается после завершения сообщения.</p>
    {run.status === 'running' && elapsed >= 600 && <p role="status">Этап выполняется более 10 минут. {idle < 60 ? 'Данные продолжают поступать.' : 'Новых событий давно нет.'} Можно прервать этап, сохранив изменения.</p>}
    {onInterrupt && <button className="secondary" disabled={busy || !!run.diagnostic?.interrupt_requested_at} onClick={onInterrupt}>
      {run.diagnostic?.interrupt_requested_at ? 'Прерываем этап…' : 'Прервать этап'}
    </button>}
  </section>;
}

export function AgentOutput({ run, stage, load }: {
  run: AgentRun; stage: Task['stage']; load: () => Promise<{ text: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<{ version: number; text: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || !run.output_version) return;
    let active = true;
    const version = run.output_version;
    setError('');
    load().then(value => { if (active) setFull({ version, text: value.text }); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [open, run.id, run.output_version]);
  return <section aria-label="Последнее сообщение агента">
    <p className="meta">Стадия: {stage} · Роль: {run.role} · Обновлено: {run.output_at
      ? <time dateTime={run.output_at}>{new Date(run.output_at).toLocaleString('ru')}</time> : '—'}</p>
    {run.output_preview ? <>
      <p className="agent-preview">{run.output_preview}</p>
      <details onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>Полный текст последнего сообщения</summary>
        {error ? <p role="alert">{error}</p> : <pre className="agent-full">{full && full.version === run.output_version ? full.text : 'Загружаем сообщение…'}</pre>}
      </details>
    </> : <p className="hint">{['queued', 'running'].includes(run.status)
      ? 'Ожидаем первое сообщение агента. CLI может не отдавать текст до завершения работы.'
      : 'Агент не передал текстовых сообщений.'}</p>}
  </section>;
}
