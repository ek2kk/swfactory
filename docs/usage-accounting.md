# Учёт наблюдаемых runs

Статистика — производная от доступных строк `runs` в SQLite, а не billing ledger.
Snapshot/SSE передаёт `statistics_runs`: только id, принадлежность, этап, статус,
время и нормализованный usage. Включаются архивные задачи и все revisions/stale
попытки. Reset удаляет строки, поэтому удалённые расходы не восстанавливаются из
событий или файлов. Авторизация остаётся общей для локального приложения (ADR 0001).

## Семантика CLI

Проверено при реализации на установленном `codex-cli 0.162.1` через
`codex app-server generate-ts` и исходники тега `rust-v0.162.1`:

- [TokenUsage в protocol.rs](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/protocol/src/protocol.rs):
  `non_cached_input()` вычитает cached из input. Значит input уже включает cached;
  пользовательский input+output не прибавляет cached повторно.
- [JSONL event processor](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/exec/src/event_processor_with_jsonl_output.rs):
  `usage_from_last_total()` копирует `ThreadTokenUsage.total` в `turn.completed.usage`.
  Наш exec запускает новый thread, ровно один turn, без `resume`; terminal snapshot
  является вкладом этого run. При ошибке CLI может не сообщить usage — это неизвестность.
- [Официальные события app-server](https://learn.chatgpt.com/docs/app-server#turn-events):
  `thread/tokenUsage/updated` обновляет usage thread. Сгенерированные типы установленного
  CLI содержат `threadId`, `turnId`, `tokenUsage.total` и `tokenUsage.last`.
  `TokenUsageInfo.update_with_last_usage()` в protocol.rs прибавляет last к total;
  last — один model request, не сумма всего turn с tools/guidance.

Wire fixtures в `test/fixtures/usage.json` содержат как синтетические крайние случаи,
так и реальные метрики CLI 0.162.1 (session/turn ids заменены). Runtime smoke выполнен
в ephemeral/read-only режиме без tools: exec — input 17246, output 5, cached 7168;
два turn одной app-server session — cumulative 21174/7/0 → 42386/14/20992,
дельта второго turn 21212/7/20992. CLI totalTokens = inputTokens + outputTokens,
без дополнительного cached. Тесты исполняют оба адаптера с fake CLI; regression
asserts проверяют также реальные захваченные метрики. Тесты старой wire-формы
exec/app-server остаются.

`diagnostic.usage_accounting.version = 1` фиксирует основание учёта. Exec сохраняет
источник `exec-turn`. App-server сохраняет `thread-total`, baseline и последний
snapshot с session id и high-water counters для обнаружения снижения
через частичные snapshots. `thread/start` подтверждает новую session с нулевым baseline;
повторные snapshots заменяют состояние. Для resumed session допустим только
подтверждённый baseline **до** нового turn той же session. Текущий исполнитель
не вызывает `thread/resume`; функция расчёта отдельно проверена на таком baseline.
Нет baseline, другая session или снижение любого валидного счётчика — usage
неизвестен. Обнаруженное снижение не «исправляется» последующим ростом. Метрики
другого turn/session не принимаются. Исторический usage без доказанного источника
не объявляется достоверным; backfill по raw logs или длине текста не выполняется.

Принимаются только finite, nonnegative safe integers. Каждое поле проверяется
отдельно. Известные части складываются даже при отсутствии другого поля;
input+output помечается как частичный. Покрытие usage означает наличие **обоих**
input/output, cached и duration имеют собственное покрытие. Суммы вычисляются
через bigint, чтобы корректные поля не переполняли safe integer при агрегации.

## Число запусков и время

`diagnostic.model_started_at` записывается по событию spawn основного CLI,
не при постановке в очередь и не для служебного `--version`. Для старых записей
session id или usage служат свидетельством запуска, но не доказательством точности
usage. Записи только со started_at без подтверждения CLI показываются отдельно и
не включаются в число физических запусков. `result_run_id` исключается; ссылки
`review_plan.checks.reuse_run_id` не создают строку расхода. Идентичность — run id,
повтор snapshots/SSE/reload не прибавляет расход. Финальные метрики при Stop
могут обновлять существующую revoked строку без изменения её статуса/результата;
после физического удаления строки позднее событие ничего не создаёт.

Время — `finished_at - started_at` завершённых runs с корректными границами,
включая backend/tools и внутренние паузы; не «активное время модели». Очередь до run
и ожидание между runs не входят. Календарный интервал — от минимального started_at
до максимального finished_at (либо now для running); неполные границы обозначаются.
Restart переводит running в interrupted без выдуманного finished_at и сбрасывает
незавершённый stop_pending: последующая сверка не датирует историческое завершение. Stop сохраняет
конец только после подтверждения остановки, а не по самому запросу Stop.

Timezone — IANA timezone браузера. Сегодня начинается в локальную полночь;
7 дней — в локальную полночь шесть календарных дней назад (с учётом DST).
Интервал полуоткрытый `[начало, now)`. Terminal run целиком относится к finished_at.
Terminal run с неизвестным концом включается только во «Всё время». Running с
локально обновляемым elapsed и предварительным usage показаны отдельно для выбранного
проекта, независимо от периода, и не входят в завершённые totals.

Не учтены title, автоматический выбор Spec, generateText при диагностике/проверке
зависимостей и другие служебные вызовы без сбора usage. Это не стоимость,
остаток подписки или обещание полного учёта внешних расходов.
