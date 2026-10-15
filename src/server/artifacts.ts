import { constants, mkdirSync, realpathSync, writeFileSync, renameSync, openSync, readFileSync, closeSync, fstatSync, readSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Problem } from './store.js';

export function removeResultArtifacts(directory: string, runIds: string[]) {
  const root = join(realpathSync(directory), 'artifacts');
  try { lstatSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (realpathSync(root) !== root) throw new Problem(422, 'Каталог artifacts не должен быть symlink. Исправьте путь и повторите очистку.');
  for (const id of runIds) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Problem(422, 'Небезопасный ID каталога результатов.');
    // rm removes symlinks themselves, never their targets (including old worktrees).
    rmSync(join(root, id), { recursive: true, force: true });
  }
}

export function artifactDirectory(directory: string, runId: string) {
  const root = join(realpathSync(directory), 'artifacts');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw new Problem(422, 'Каталог artifacts не должен быть symlink.');
  const path = join(root, runId);
  mkdirSync(path, { mode: 0o700 });
  return path;
}
export function saveArtifact(directory: string, name: string, text: string) {
  const temporary = join(directory, `${name}.tmp`);
  writeFileSync(temporary, name.endsWith('.json') ? JSON.stringify(JSON.parse(text), null, 2) : text, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, join(directory, name));
}
export function readReport(directory: string, runId: string) {
  const path = join(realpathSync(directory), 'artifacts', runId, 'report.md');
  try {
    if (realpathSync(path) !== path) throw new Error('symlink');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('invalid artifact');
      return readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  } catch { throw new Problem(404, 'Отчёт недоступен или путь небезопасен.'); }
}

export function readLog(directory: string, runId: string, name: 'events.jsonl' | 'stderr.log', offset: number) {
  const path = join(realpathSync(directory), 'artifacts', runId, name);
  try {
    if (realpathSync(path) !== path) throw new Error('symlink');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || offset > stat.size) throw new Error('invalid offset');
      const buffer = Buffer.alloc(Math.min(65536, stat.size - offset));
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      // Avoid splitting UTF-8 characters between pages.
      let end = count;
      if (offset + count < stat.size) while (end > 0 && (buffer[end - 1] & 0xc0) === 0x80) end--;
      if (end < count || (offset + count < stat.size && buffer[end - 1] >= 0xc0)) end = Math.max(0, end - 1);
      return { text: buffer.subarray(0, end).toString('utf8'), next_offset: offset + end, more: offset + end < stat.size };
    } finally { closeSync(fd); }
  } catch { throw new Problem(404, 'Лог недоступен, курсор неверен или путь небезопасен.'); }
}
