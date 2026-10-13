import { useEffect, useState } from 'react';
import type { AgentRun, Task } from '../shared.js';

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
