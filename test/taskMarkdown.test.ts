import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskMarkdown } from '../src/client/TaskMarkdown.js';

const render = (children: string) => renderToStaticMarkup(createElement(TaskMarkdown, { children }));

test('task Markdown renders common Markdown and GFM with read-only task lists', () => {
  const html = render([
    '# Requirements', '', 'A **strong** and *emphasized* paragraph with `code` and ~~old~~.', '',
    '> Quoted requirements', '', '- Parent', '  - Nested', '', '1. First', '2. Second', '',
    '- [x] Done', '- [ ] Pending', '', '```ts', 'const value = "<safe>";', '```', '',
    '| Name | State |', '| --- | --- |', '| API | ready |', '',
    '[Docs](https://example.com "Documentation") and https://example.org',
  ].join('\n'));
  for (const tag of ['h1', 'p', 'strong', 'em', 'code', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'table', 'thead', 'tbody', 'th', 'td']) {
    assert.match(html, new RegExp(`<${tag}(?:>| )`), tag);
  }
  assert.match(html, /<ul>\s*<li>Parent\s*<ul>\s*<li>Nested<\/li>/);
  const checkboxes = html.match(/<input[^>]+>/g)!;
  assert.equal(checkboxes.length, 2);
  assert.ok(checkboxes.every(input => /disabled=""/.test(input) && /type="checkbox"/.test(input)));
  assert.match(checkboxes[0], /checked=""/);
  assert.doesNotMatch(checkboxes[1], /checked/);
  assert.match(html, /<code class="language-ts">const value = &quot;&lt;safe&gt;&quot;;\n<\/code>/);
  assert.match(html, /href="https:\/\/example.com" title="Documentation" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/example.org"/);
  assert.match(html, /class="markdown-table" role="region" aria-label="Таблица требований" tabindex="0"/);
  assert.match(html, /<pre tabindex="0">/);
});

test('plain text is readable, escaped and the original Markdown is unchanged', () => {
  assert.equal(render('Обычный текст & условия.\nСледующая строка.'), '<div class="task-markdown"><p>Обычный текст &amp; условия.\nСледующая строка.</p></div>');
  const source = '  # Исходник\r\n\r\n- [x] Готово  \r\n\r\n```txt\r\n  exact <code> & spaces  \r\n```\r\n';
  const task = Object.freeze({ description: source });
  const first = render(task.description);
  assert.match(first, /<h1>Исходник<\/h1>/);
  assert.equal(task.description, source);
  assert.equal(render(task.description), first);
});

test('raw HTML, unsafe URLs and images cannot execute or load remote content', () => {
  const html = render([
    '<script>alert(1)</script>', '', '<img src="https://tracker.invalid/pixel" onerror="alert(1)">', '',
    '<iframe src="https://tracker.invalid/frame"></iframe>', '', '<a href="javascript:alert(1)" onclick="alert(1)">raw</a>', '',
    '[script](javascript:alert%281%29) [data](data:text/html;base64,PHNjcmlwdD4=) [vb](vbscript:alert) [file](file:///etc/passwd)', '',
    '[entity](java&#x73;cript:alert) [mixed](JaVaScRiPt:alert) [safe](https://example.com)', '',
    '![Tracking image](https://tracker.invalid/pixel) ![reference image][image]', '',
    '[image]: https://tracker.invalid/reference', '',
    '`<img onerror="alert(1)">`',
  ].join('\n'));
  assert.doesNotMatch(html, /<(?:script|img|iframe)\b|<[^>]*\s(?:src|onclick|onerror)=/i);
  assert.doesNotMatch(html, /href="(?:javascript|data|vbscript|file):/i);
  assert.match(html, /<span>script<\/span>/);
  assert.doesNotMatch(html, /tracker\.invalid/);
  assert.match(html, /<span>Tracking image<\/span>/);
  assert.match(html, /<span>reference image<\/span>/);
  assert.match(html, /<code>&lt;img onerror=&quot;alert\(1\)&quot;&gt;<\/code>/);
  assert.match(html, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
});
