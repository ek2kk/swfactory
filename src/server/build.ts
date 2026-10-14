import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, readlinkSync, statSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import type { AgentRun, BuildResult } from '../shared.js';
import { run as git, type Run } from './git.js';
import { Problem } from './store.js';

const paths = (output: string) => output.split('\0').filter(Boolean);
const blocked = (message: string): never => { throw new Problem(422, `${message} Нужна ручная проверка worktree; изменения сохранены.`); };
function safePath(path: string) {
  if (path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') || /[\x00-\x1f\x7f]/.test(path)) blocked('Неоднозначный путь.');
}
function fileContent(cwd: string, path: string) {
  safePath(path);
  const file = join(cwd, path);
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(file);
      let resolved: string;
      try { resolved = realpathSync(file); }
      catch { return blocked(`Недоступная цель symlink: ${path}.`); }
      const inside = relative(cwd, resolved);
      if (isAbsolute(target) || inside.startsWith('../') || isAbsolute(inside)
        || realpathSync(dirname(file)) !== dirname(file)) blocked(`Symlink выходит за границы worktree: ${path}.`);
      safePath(inside);
      const targetStat = statSync(resolved);
      if (!targetStat.isFile() || targetStat.size > 2 * 1024 * 1024) blocked(`Недопустимая цель symlink: ${path}.`);
      // Include both link text and target bytes, even if the target is ignored by Git.
      return { mode: stat.mode, content: Buffer.concat([Buffer.from(target + '\0'), readFileSync(resolved)]) };
    }
    if (!stat.isFile() || realpathSync(file) !== file || stat.size > 2 * 1024 * 1024) blocked(`Специальный или слишком большой файл: ${path}.`);
    return { mode: stat.mode, content: readFileSync(file) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function sourceHash(run: AgentRun, command: Run = git) {
  const cwd = run.worktree;
  if (realpathSync(cwd) !== cwd || await command('git', ['symbolic-ref', '--short', 'HEAD'], cwd) !== run.branch) blocked('Worktree или branch изменён.');
  for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const path = await command('git', ['rev-parse', '--path-format=absolute', '--git-path', name], cwd);
    try { lstatSync(path); blocked('Незавершённая Git операция.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (paths(await command('git', ['ls-files', '-v', '-z'], cwd)).some(entry => !entry.startsWith('H '))) blocked('Index содержит скрытые или неоднозначные записи.');
  const hash = createHash('sha256');
  hash.update(await command('git', ['rev-parse', 'HEAD'], cwd));
  hash.update(await command('git', ['ls-files', '--stage', '-z'], cwd));
  const files = paths(await command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd));
  for (const path of [...new Set(files)].sort()) {
    const file = fileContent(cwd, path);
    hash.update(JSON.stringify([path, file?.mode, file?.content.length]));
    if (file) hash.update(file.content);
  }
  return hash.digest('hex');
}

export async function commitBuild(run: AgentRun, result: BuildResult, command: Run = git) {
  const cwd = run.worktree, base = run.base_sha!;
  const snapshot = await sourceHash(run, command);
  const head = await command('git', ['rev-parse', 'HEAD'], cwd);
  await command('git', ['merge-base', '--is-ancestor', base, head], cwd);
  const commits = (await command('git', ['rev-list', '--reverse', '--parents', `${base}..${head}`], cwd)).split('\n').filter(Boolean);
  let parent = base;
  const actual = new Set<string>();
  for (const line of commits) {
    const [sha, ...parents] = line.split(' ');
    if (parents.length !== 1 || parents[0] !== parent) blocked('История Build не является линейным продолжением base.');
    const changed = paths(await command('git', ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', sha], cwd));
    for (const path of changed) {
      safePath(path); actual.add(path);
      const entry = await command('git', ['--literal-pathspecs', 'ls-tree', sha, '--', path], cwd);
      if (entry) {
        if (!/^100(?:644|755) blob /.test(entry)) blocked('В commit есть symlink или submodule.');
      }
    }
    parent = sha;
  }
  const dirty = new Set([
    ...paths(await command('git', ['diff', '--name-only', '--no-renames', '-z', 'HEAD'], cwd)),
    ...paths(await command('git', ['ls-files', '--others', '--exclude-standard', '-z'], cwd)),
    ...paths(await command('git', ['diff', '--cached', '--name-only', '--no-renames', '-z'], cwd)),
  ]);
  for (const path of dirty) {
    actual.add(path);
    fileContent(cwd, path);
  }
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...result.changed_paths].sort())) blocked('Заявленные пути не совпадают с изменениями Git.');
  if (await sourceHash(run, command) !== snapshot) blocked('Source изменился во время проверки.');
  if (dirty.size) {
    await command('git', ['--literal-pathspecs', 'add', '--', ...dirty], cwd);
    const tree = await command('git', ['write-tree'], cwd);
    for (const path of dirty) {
      const entry = await command('git', ['--literal-pathspecs', 'ls-tree', tree, '--', path], cwd);
      if (entry) {
        if (!/^100(?:644|755) blob /.test(entry)) blocked('В index есть symlink или submodule.');
      }
    }
    if (tree === await command('git', ['rev-parse', 'HEAD^{tree}'], cwd)) blocked('Нет изменений для commit.');
    await command('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', `Build task ${run.task_id}`], cwd);
    if (await command('git', ['rev-parse', 'HEAD^{tree}'], cwd) !== tree) blocked('Дерево commit изменилось.');
  }
  const final = await command('git', ['rev-parse', 'HEAD'], cwd);
  if (final === base || await command('git', ['rev-parse', 'HEAD^{tree}'], cwd) === await command('git', ['rev-parse', `${base}^{tree}`], cwd) || await command('git', ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], cwd)) blocked('Build не создал commit или source tree не чистое.');
  await sourceHash(run, command);
  return final;
}
