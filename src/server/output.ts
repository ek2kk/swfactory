import { redactStructured } from './diagnostics.js';

const labels: Record<string, string> = {
  title: 'Заголовок', outcome: 'Результат', summary: 'Итог', requirements: 'Требования',
  acceptance_criteria: 'Критерии приёмки', assumptions: 'Допущения', out_of_scope: 'Вне scope',
  changed_paths: 'Изменённые файлы', actions: 'Действия', checks: 'Проверки', findings: 'Замечания',
  evidence: 'Подтверждения', applicable: 'Применимость', applicability: 'Обоснование применимости',
  risks: 'Риски', affected_paths: 'Затронутые файлы', questions: 'Вопросы',
  text: 'Вопрос', context: 'Контекст', impact: 'Влияние', options: 'Варианты', required: 'Обязательный',
};

export function formatOutput(text: string): string {
  const safe = redactStructured(text) as string;
  let value: unknown;
  try { value = JSON.parse(safe); } catch { return safe; }
  function readable(item: unknown): string {
    if (typeof item === 'string') return item;
    if (typeof item === 'boolean') return item ? 'Да' : 'Нет';
    if (Array.isArray(item)) return item.map(readable).filter(Boolean).map(v => `• ${v}`).join('\n');
    if (item && typeof item === 'object') return Object.entries(item)
      .filter(([key]) => Object.hasOwn(labels, key))
      .map(([key, field]) => { const content = readable(field); return content ? `${labels[key]}: ${content}` : ''; })
      .filter(Boolean).join('\n\n');
    return '';
  }
  return readable(value) || 'Структурированный ответ без известных полей. Подробности в техническом логе.';
}
