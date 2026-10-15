## Agent skills

### Issue tracker

Задачи и specs ведём в GitHub Issues. Перед работой с ними читай
`docs/agents/issue-tracker.md`.

### Triage labels

Используем стандартные пять triage labels. Перед triage читай
`docs/agents/triage-labels.md`.

### Domain docs

Используем single-context: корневой `CONTEXT.md` и `docs/adr/`.
Перед исследованием проекта читай `docs/agents/domain.md`.

## Workflow реализации задач

При поручении реализовать GitHub Issue выполняй весь цикл до опубликованного PR:

1. Прочитай issue и комментарии, проверь blocking dependencies. Начинай реализацию
   после merge всех блокирующих задач в целевую ветку; `ready-for-agent` само по
   себе не означает отсутствие блокировок.
2. Для каждой задачи создай отдельную ветку `issue/<number>-<short-slug>` от
   актуальной remote default branch, если в задаче не указана другая целевая ветка.
   Все изменения задачи вноси в эту ветку. При продолжении используй существующую
   ветку и PR этой задачи. Для параллельных задач используй отдельные worktrees.
3. Сохраняй чужие и ранее незакоммиченные изменения; не включай их в commit задачи.
   Если текущий checkout занят такими изменениями, работай в отдельном worktree.
4. Реализуй согласованный scope, проверь acceptance criteria и выполни необходимые
   проверки. Зафиксируй изменения задачи в commits и push её ветки.
5. Создай PR через `gh` в целевую ветку. В описании укажи `Closes #<number>`,
   результат, выполненные проверки и известные ограничения. Если PR уже существует,
   обновляй его. Многострочное описание передавай через `--body-file`.
6. Верни пользователю ссылку на PR и краткий результат проверок. Если работа
   заблокирована или обязательные проверки не пройдены, явно сообщи об этом;
   незавершённый PR публикуй как draft.

Merge выполняет пользователь вручную на GitHub. Агент не выполняет merge,
не включает auto-merge и не закрывает issue как выполненную до merge PR.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
