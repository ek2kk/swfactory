# SW Factory

Локальная Kanban-доска для macOS: подключить Git-проект, сохранить задачу
и получить Spec выбранной моделью Codex в отдельном worktree. Валидный READY
переводит карточку в Build; сам Build и дальнейшие роли ещё не исполняются.

## Запуск

Нужны Node.js **24.21.0 LTS** (см. `.nvmrc`), npm, Git и авторизованный `gh`
для GitHub либо `glab` для GitLab, а также авторизованный Codex CLI (`codex login`).
Адаптер проверяется с Codex 0.160.1. Если native addon не установился готовым
бинарником, для сборки `better-sqlite3` нужны Xcode Command Line Tools.

```sh
nvm install
nvm use
npm ci
npm run check
npm start
```

Откройте URL, напечатанный backend. Bootstrap token передаётся во fragment,
удаляется из адресной строки и обменивается на HttpOnly/SameSite session cookie.
После restart откройте новый URL из терминала. Не публикуйте этот URL.
Backend работает отдельным процессом: закрытие браузерной вкладки его не
останавливает. Остановка — Ctrl+C в терминале: backend ждёт текущие runs, новые из очереди
не запускает. Cancel/остановка потомков пока не реализованы; автозапуска при входе нет.

По умолчанию: `http://127.0.0.1:4317`, данные —
`~/Library/Application Support/AgentKanban/`. Можно задать `PORT` и
`SWFACTORY_DATA_DIR` перед запуском. Не выбирайте checkout проекта как data directory.
Один data directory может принадлежать только одному backend, даже на разных
портах. Настройки проектов, карточки, редакции и события хранятся в `state.sqlite`;
`owner.sqlite` удерживает process-lifetime exclusive lock. Не удаляйте его при
работающем backend. Данные и их история автоматически не удаляются.

## Подключение и карточки

1. Введите абсолютный путь к существующему checkout, имя remote, target branch
   и hosting. Для self-hosted GitHub/GitLab выберите тип hosting явно.
2. Приложение читает Git root, common-dir, remote и **локальную remote-tracking
   target branch**, затем проверяет CLI auth для host из remote. Оно не делает
   fetch, checkout, stash, commit и не запускает агентов. Если target отсутствует,
   самостоятельно выполните `git fetch <remote>` в своём checkout и повторите.
   HTTPS remote со встроенными credentials не принимаются — используйте CLI auth.
3. Добавьте описание: пробелы и переносы сохраняются дословно. Заголовок не нужен;
   карточка показывает нейтральный ID. Редактирование создаёт новую редакцию,
   предыдущие доступны в истории. Чужая новая редакция блокирует устаревшую запись.

## Запуск Spec

1. В «Модели и инструкции» задайте модели для Spec, Build, четырёх Review и
   Approve, а также дополнительные инструкции проекта. Стартовое значение —
   `gpt-6.1-sol`; это не обещание доступности в вашей подписке. Модель передаётся
   CLI явно и не заменяется при ошибке. Настройки и их revision фиксируются при старте.
2. Нажмите «Приступить к реализации». FIFO исполняет до трёх задач одновременно.
   Preflight блокирует staged, unstaged, неигнорируемые untracked изменения,
   незавершённый merge/rebase, изменившийся checkout или remote. Причины и пути
   видны в карточке запуска. После отказа preflight можно исправить checkout и
   явно повторить старт; новый request создаёт новую попытку.
3. Fetch выбранной remote target branch сохраняет SHA в отдельном ref. Branch
   `swfactory/<task-id>/<run-id>` и worktree создаются от этого SHA: неопубликованные
   локальные commits не подмешиваются. Основной checkout не переключается;
   stash/reset/автоматического исправления нет.
4. Spec получает описание, инструкции проекта, task/run/revision/base и указание
   читать применимые AGENTS.md в worktree. Только полный успешный JSONL stream,
   валидный structured result и неизменившийся Git state допускают READY → Build.
   NEEDS_INPUT сохраняет вопросы в отчёте и переводит карточку в Needs human;
   ответ/продолжение реализуются отдельным срезом.

Рабочий Codex запускается с `--dangerously-bypass-approvals-and-sandbox`: без
permission prompts и с full access. Worktree и инструкции **не являются sandbox**.
Spec запрещено менять source, создавать commits, публиковать или выполнять merge.
После ошибки исполнения требуется ручная сверка; частичные файлы не удаляются.

SQLite хранит runs и решения, `artifacts/<run-id>/` — input/schema/result JSON,
report.md, events.jsonl и stderr.log; `worktrees/<project-id>/<run-id>/` — рабочие
деревья. Отчёт доступен через task/run ID, без произвольного пути и symlink escape.
Сырые process logs доступны только локально; они не передаются браузеру. Объём
логов ограничен 32 MiB на run, превышение останавливает процесс и блокирует переход.
Артефакты и worktrees автоматически не удаляются.

Dirty checkout допускается при подключении, но блокирует старт. Linked worktrees
одного common-dir считаются одним проектом. Проверка CLI auth не доказывает права
push; Spec не публикует изменения и не проверяет права будущей публикации.

## Проверки и границы

`npm run check` запускает тесты приложения, TypeScript и production build.
Проверяются rollback состояния/события, idempotency и stale state, редакции,
принадлежность карточки проекту, CSRF/Origin/Host, bootstrap auth, SSE replay и
snapshot, запрет второго владельца в другом процессе, restart/interrupted и
read-only Git inspection в одноразовом dirty checkout с linked worktree.

Browser UI получает данные приложения и сохранённый отчёт: provider credentials и CLI stderr не
передаются. Текст выводится как текст, без HTML. API произвольных файлов отсутствует; отчёты проверяют принадлежность task/project/run. UI обслуживается тем же
Fastify origin; Vite используется для сборки, отдельный dev server не требуется.

Не реализованы Build/Review/Approve/публикация, resume/cancel, backup/restore и crash/disk-full
испытания. Никакого автоматического retry незавершённого исполнения после restart:
состояния queued/running/waiting помечаются interrupted с сохранением истории.
Реальная GitLab-интеграция требует отдельного тестового remote; в этом срезе
формирование команд проверяется локально, реальные GitLab-права не заявляются.

Дополнительные тесты Spec: Git preflight и remote SHA на локальном bare remote,
изоляция локальных commits, три слота, immutable model config, READY/NEEDS_INPUT,
ошибки процесса/stream/schema, изменение source, rollback события и отказ записи
артефакта, start replay/ownership/version, migration v1 → v2 и symlink escape.
Контракт structured output сверялся с [официальным примером Codex](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex)
и локальным `codex exec --help`.

Реальная проверка 12 октября 2026: Codex 0.160.1 / `gpt-6.1-sol` подготовил
READY через весь Spec controller на одноразовом локальном bare remote; отчёт
сохранён, stage=Build, source чистый. Отдельный smoke адаптера подтвердил запись
proof.txt в full-access режиме. Browser QA не выполнена: в среде проверки нет
подключённого браузера. Реальные GitHub/GitLab remote операции этим smoke не покрыты.
