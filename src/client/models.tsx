import { useState } from 'react';
import type { ModelOption } from '../shared.js';

export function ModelPicker({ role, value, catalog, onChange }: { role: string; value: string; catalog: ModelOption[]; onChange: (value: string) => void }) {
  const [manual, setManual] = useState(false);
  const listed = catalog.some(model => model.id === value);
  return <div>
    <label>Модель · {role}<select value={manual ? '' : value} onChange={event => {
      setManual(event.target.value === '');
      if (event.target.value) onChange(event.target.value);
    }}>
      {!listed && value && <option value={value}>{value || 'Модель не указана'} — вне каталога</option>}
      {catalog.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
      <option value="">Другая модель…</option>
    </select></label>
    {manual && <label>Model ID · {role}<input required maxLength={128} pattern="[a-zA-Z0-9][a-zA-Z0-9._:\/\-]*" value={value} onChange={event => onChange(event.target.value)} /></label>}
    {!listed && value && <p className="hint">Модель отсутствует в каталоге. Доступность будет проверена при запуске.</p>}
  </div>;
}

export function ReasoningPicker({ role, value, model, onChange }: { role: string; value: string; model?: ModelOption; onChange: (value: string) => void }) {
  const options = model?.reasoning_efforts ?? [];
  const selected = options.find(option => option.effort === value);
  return <fieldset className="reasoning-picker">
    <legend>Глубина рассуждений · {role}</legend>
    <p className="hint" aria-live="polite">Текущее значение: {value || 'По умолчанию Codex'}{value && !selected ? ' · не подтверждено каталогом' : ''}</p>
    <div className="effort-stops">
      {[{ effort: '', description: 'По умолчанию Codex' }, ...options].map(option => <label key={option.effort} title={option.description}>
        <input type="radio" name={`effort-${role}`} aria-label={`${option.effort || 'По умолчанию Codex'} · ${role}`} value={option.effort} checked={value === option.effort} onChange={() => onChange(option.effort)} />
        <span>{option.effort || 'По умолчанию Codex'}</span>
      </label>)}
    </div>
    {selected?.description && <p className="hint">{selected.description}</p>}
    {value && !selected && <p role="status">Уровень {value} не подтверждён каталогом и сохранён без изменений. <button type="button" className="secondary" onClick={() => onChange('')}>Сбросить · {role}</button></p>}
    {!options.length && <p className="hint">{!model ? 'Модель или каталог недоступны; уровни неизвестны.' : model.reasoning_efforts === undefined ? 'Каталог не содержит данных об уровнях этой модели.' : 'Каталог не предлагает явных уровней для этой модели.'} Доступен режим по умолчанию.</p>}
  </fieldset>;
}
