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
