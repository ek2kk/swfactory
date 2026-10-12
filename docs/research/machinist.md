# Machinist: что применимо к проверкам технического дизайна

**Изменение scope 12 октября 2026:** это историческое исследование дизайна v1.0/v1.1. Текущие [PRD](../PRD.md) и [дизайн](../TECHNICAL_DESIGN.md) используют только Codex, завершают pipeline созданием PR/MR без merge и откладывают надёжное interruption/recovery до рабочего прототипа. Приведённые ниже приоритеты S-01–S-12 не являются текущими блокерами разработки.

Дата исследования: 2026-10-11. Источники: [проект](https://machinist.sh/) и исходники [owainlewis/machinist, commit `39435164faf1ff7fad49e41c38a7eb1a00538f21`](https://github.com/owainlewis/machinist/tree/39435164faf1ff7fad49e41c38a7eb1a00538f21). Сопоставление с §14 [TECHNICAL_DESIGN.md](../TECHNICAL_DESIGN.md). Ссылки ниже закреплены за исследованным commit.

**Обновление после исследования:** пользователь выбрал полные разрешения обоих CLI, как в Machinist. В PRD/дизайне v1.1 live tool approvals исключены, S-01/S-02 заменены проверками non-interactive запуска и lifecycle; S-06 больше не требует sandbox. Ниже сохранено сравнение с первоначальным дизайном v1.0, а не текущий план проверок.

**Вывод:** полезный reference для controller, approvals между стадиями, leases и immutable artifacts. Не доказательство наиболее рискованных предположений нашего дизайна: native CLI permissions, строгий merge по source+target и enforceable sandbox. Заимствовать механизмы и тестовые сценарии; S-01–S-12 пока не помечать выполненными.

## Подтверждено чтением кода

### Controller, approvals, recovery и scheduler

- `WorkflowAction` в транзакции сверяет ожидаемый `run_id` с последней попыткой: stale UI и повторный click не одобряют новое исполнение. Retry создаёт новую попытку и снова требует approval. Это хороший образец для наших `run/attempt` и immutable human request, но здесь approval разрешает следующий **workflow step**, а не отвечает на живой tool-call Codex/Claude. [workflows.go](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/controlplane/workflows.go#L201-L266)
- Workflow с истёкшей lease переходит в `interrupted`; retry требует подтверждения `stopped`. Обычные command jobs автоматически возвращаются в очередь. Даже workflow recovery не доказывает остановку процесса: `stopped` — утверждение оператора. Это частичный ответ S-05, но не наша полная гарантия «restart никогда не возобновляет исполнение». [reclaimLeases](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/controlplane/workflows.go#L244-L284), [обычный requeue](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/controlplane/store.go#L33-L39)
- Lease действует 30 секунд, heartbeat идёт каждые 10 секунд; completion проверяет worker instance, lease token, срок и state. Повторное завершение уже terminal run с тем же ownership идемпотентно. Это защищает принятие результата, но само по себе не останавливает запись устаревшего процесса. На 409/404 heartbeat worker отменяет workflow context; временная сетевая ошибка лишь журналируется. [store.go](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/controlplane/store.go), [worker.go](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/managedworker/worker.go#L29-L149)
- Capacity проверяется через `COUNT` running jobs в одной транзакции с выдачей lease. Worker выполняет задания последовательно. Подход полезен для лимита task leases, но четыре параллельных reviewer и освобождение/повторный захват слота при live permission wait здесь не доказаны. [poll](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/controlplane/store.go#L738-L945), [worker loop](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/managedworker/worker.go#L59-L91)

### Persistence и artifacts

- SQLite использует WAL, foreign keys, один connection и транзакционные workflow transitions. Это reference для S-10, но не отчёт о crash/disk-full испытаниях. Legacy migration для schema version <1 удаляет старые таблицы; копировать migration policy в наш дизайн с требованием сохранения данных нельзя. [store initialization](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/controlplane/store.go#L187-L272)
- Artifact сначала записывается во временный файл с SHA-256 и `fsync`; публикация через hard link и sync директорий предшествует записи metadata в SQLite. Lease проверяется до staging и повторно внутри транзакции. Повтор `(run,path)` с тем же hash/size возвращает существующий artifact, с другим — conflict. Есть ограничения размера и количества. Это почти готовый алгоритм для наших immutable artifacts и idempotent upload. [filesystem store](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/artifacts/store.go), [PublishArtifact](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/controlplane/artifacts.go#L73-L138)
- Чтение storage через `os.OpenRoot`, проверка путей, отклонение symlink при сборе output, проверка checksum/size скачанных input — полезные меры для S-06 и локального artifact API. Они не делают весь agent process sandboxed. [worker artifacts](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/managedworker/artifacts.go), [storage reads](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/artifacts/store.go)

### CLI, процессы и merge

- Пример worker запускает Codex с `--sandbox danger-full-access`, Claude с `--dangerously-skip-permissions`. Это не решение S-01/S-02. SDK-варианты демонстрируют thread/result/structured output, но не связку UI ↔ live provider approval. В `agent.py` Codex использует full access, кроме read-only assessment; Claude также обходит permissions. [worker.toml](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/examples/worker.toml), [agent.py](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/agent.py), [SDK example](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/examples/workflows/code-workflows/codex_example.py)
- Unix runner использует process group (`Setpgid`) и SIGKILL отрицательного PID, с Darwin-specific обработкой EPERM. Это полезный старт для S-04, но не доказательство остановки detached writers, сохранения ownership после restart или защиты от PID reuse. [process_unix.go](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/runner/process_unix.go)
- Risk delivery gate проверяет source/head и base перед merge, но `gh pr merge --match-head-commit` связывает операцию только с source. Между чтением base и merge остаётся target race; S-07 не закрыт. CI принимает `NEUTRAL`/`SKIPPED` без отдельной policy. Проверка уже merged PR помогает retry, но не заменяет журнал всех create/push/merge side effects (S-08). [gate.py](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/examples/workflows/risk_delivery/gate.py#L60-L100)
- Auto-merge docs ограничен размером diff, исключает renames, необычные file modes и truncated tree. Это полезные дополнительные проверки, но path/size и agent risk report не доказывают семантическую безопасность Markdown с инструкциями. README прямо оговаривает отсутствие sandbox для agent credentials и атомарности локального preflight. [risk_delivery README](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/examples/workflows/risk_delivery/README.md), [gate.py](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/examples/workflows/risk_delivery/gate.py)

## Как изменить план S-01–S-12

| Проверки | Что взять | Что всё равно проверить самостоятельно |
|---|---|---|
| S-01/S-02 | CLI/SDK запуск и нормализацию результата | Live allow/deny, correlation, timeouts, cancellation, inherited hooks; остаётся P0 |
| S-03 | Step approval CAS и feedback между попытками | Native questions, free text, связь с живым provider request |
| S-04 | Process group kill и Darwin edge cases | Detached writers, crash/restart, PID reuse, unknown ownership |
| S-05 | Interrupted workflow, новая попытка, повторное approval | Actual Git/session resume и отсутствие повторного применения изменений |
| S-06 | Root-scoped artifact reads, checksum, symlink checks | Запрет агенту менять основной checkout/state и обходить hosting coordinator |
| S-07 | Негативные gate fixtures, source-head guard | Атомарная гарантия target на GitHub и GitLab; остаётся P0 |
| S-08 | Повторное completion/artifact publication; already-merged check | Lost response после create/push/merge, reconciliation каждого remote effect |
| S-09 | Транзакционный admission, lease tokens, stale-response checks | Три задачи × четыре reviewer, live waits и одновременные ответы |
| S-10 | WAL, atomic transitions, file/hash/DB publication | Crash injection, full disk, backup restore, migration failures |
| S-11/S-12 | Примеры конфигурации executor | Наш TypeScript/SQLite стек, реальные Mac и штатная auth пользователя |

Практический порядок: оставить первыми S-01/S-02/S-06/S-07; controller и artifact harness строить по приведённым механизмам. Для нашего local backend не переносить распределённый worker protocol целиком. Требования остаются строже reference.

## Что реально запущено и ограничения доказательств

- Запущено: `python3 -m unittest discover -s examples/workflows/risk_delivery -p 'test_*.py' -v` — **9 тестов прошли**. GitHub в этих тестах mocked; реальные branch protection, очередь и target race не испытаны. [test_gate.py](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/examples/workflows/risk_delivery/test_gate.py)
- Прочитаны Go-тесты stale/duplicate approval, explicit workflow recovery, atomic progression и concurrency. Не запущены: `go` отсутствует в PATH. Наличие test case не означает успешный прогон в нашем окружении. [workflow tests](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/controlplane/workflows_test.go), [store tests](https://github.com/owainlewis/machinist/blob/39435164faf1ff7fad49e41c38a7eb1a00538f21/internal/controlplane/store_test.go)
- Runtime Codex/Claude, real hosting remotes, установки на чистом Mac, crash/full-disk и end-to-end sandbox проверки не выполнялись. Исследование исходников уменьшает работу по проектированию, но не заменяет эти испытания.
