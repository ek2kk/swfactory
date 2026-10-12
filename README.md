# SW Factory

Локальная Kanban-доска для macOS. Первый срез: подключить Git-проект, создать
задачу из описания и редактировать её до запуска. Стадии будущего pipeline
видны на доске; запуск Codex и генерация заголовков ещё не реализованы.

## Запуск

Нужны Node.js **24.21.0 LTS** (см. `.nvmrc`), npm, Git и авторизованный `gh`
для GitHub либо `glab` для GitLab. Если native addon не установился готовым
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
останавливает. Остановка — Ctrl+C в терминале; автозапуска при входе нет.

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

Dirty checkout допускается при подключении: проверка чистоты перед исполнением
относится к следующему срезу. Linked worktrees одного common-dir считаются одним
проектом. Проверка CLI auth не доказывает права push на remote; сетевой preflight
перед запуском будет отдельным шагом.

## Проверки и границы

`npm run check` запускает тесты приложения, TypeScript и production build.
Проверяются rollback состояния/события, idempotency и stale state, редакции,
принадлежность карточки проекту, CSRF/Origin/Host, bootstrap auth, SSE replay и
snapshot, запрет второго владельца в другом процессе, restart/interrupted и
read-only Git inspection в одноразовом dirty checkout с linked worktree.

Browser UI получает только данные приложения: provider tokens и CLI stderr не
передаются. Текст выводится как текст, без HTML. API произвольных файлов и
артефактов отсутствует до появления самих артефактов. UI обслуживается тем же
Fastify origin; Vite используется для сборки, отдельный dev server не требуется.

Не реализованы исполнение/публикация, resume/cancel, backup/restore и crash/disk-full
испытания. Никакого автоматического retry незавершённого исполнения после restart:
состояния queued/running/waiting помечаются interrupted с сохранением истории.
Реальная GitLab-интеграция требует отдельного тестового remote; в этом срезе
формирование команд проверяется локально, реальные GitLab-права не заявляются.
