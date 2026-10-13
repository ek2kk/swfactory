import { useState } from 'react';
import type { ModelOption } from '../shared.js';

export function ModelPicker({ role, value, catalog, onChange }: { role: string; value: string; catalog: ModelOption[]; onChange: (value: string) => void }) {
  const [manual, setManual] = useState(false);
  const listed = catalog.some(model => model.id === value);
  return <div>
    <label>{role}<select value={manual ? '' : value} onChange={event => {
      setManual(event.target.value === '');
      if (event.target.value) onChange(event.target.value);
    }}>
      {!listed && value && <option value={value}>{value || 'Модель не указана'} — вне каталога</option>}
      {catalog.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
      <option value="">Другая модель…</option>
    </select></label>
    {manual && <label>Model ID · {role}<input required maxLength={128} pattern="[a-zA-Z0-9][a-zA-Z0-9._:/\-]*" value={value} onChange={event => onChange(event.target.value)} /></label>}
    {!listed && value && <p className="hint">Модель отсутствует в каталоге. Доступность будет проверена при запуске.</p>}
  </div>;
}

export function ReasoningPicker({ role, value, model, onChange }: { role: string; value: string; model?: ModelOption; onChange: (value: string) => void }) {
  const options = model?.reasoning_efforts ?? [];
  const selected = options.find(option => option.effort === value);
  return <div>
    <label>Глубина рассуждений · {role}<select value={value} disabled={!options.length && !value} onChange={event => onChange(event.target.value)}>
      <option value="">По умолчанию Codex</option>
      {value && !selected && <option value={value} disabled>{value} — вне каталога</option>}
      {options.map(option => <option key={option.effort} value={option.effort}>{option.effort}{option.effort === model?.default_reasoning_effort ? ' · рекомендуется моделью' : ''}</option>)}
    </select></label>
    {selected?.description && <p className="hint">{selected.description}</p>}
    {value && !selected ? <p role="status">Сохранённый уровень отсутствует в каталоге. Он не изменён; Codex проверит его при запуске.</p>
      : !options.length && <p className="hint">Нет данных об уровнях этой модели. Обновите каталог Codex.</p>}
  </div>;
}
