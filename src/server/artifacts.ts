import { constants, mkdirSync, realpathSync, writeFileSync, renameSync, openSync, readFileSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { Problem } from './store.js';

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
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
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
