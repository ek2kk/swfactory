# Issue tracker: GitHub

Задачи и specs хранятся в GitHub Issues репозитория `ek2kk/swfactory`.
Для операций используй `gh` из корня репозитория.

- Создать: `gh issue create --title "..." --body-file <path>`.
- Прочитать вместе с обсуждением: `gh issue view <number> --comments`.
- Получить открытые задачи:
  `gh issue list --state open --json number,title,body,labels,comments`.
- Добавить комментарий: `gh issue comment <number> --body-file <path>`.
- Добавить или снять label:
  `gh issue edit <number> --add-label "..." --remove-label "..."`.
- Закрыть: `gh issue close <number>`.

Многострочные тексты передавай через файл с помощью `--body-file`.
Названия triage labels бери из `docs/agents/triage-labels.md`.

Инструкция skill «publish to the issue tracker» означает создать issue.
Инструкция «fetch the relevant ticket» означает прочитать issue и комментарии.

## Pull requests as a triage surface

**PRs as a request surface: no.**
