import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectProject, remoteIdentity, run, type Run } from '../src/server/git.js';

test('remote identity rejects credentials, local paths and traversal', () => {
  assert.deepEqual(remoteIdentity('git@github.com:owner/repo.git'), { host: 'github.com', repository: 'owner/repo' });
  assert.deepEqual(remoteIdentity('ssh://git@gitlab.example/team/sub/repo.git'), { host: 'gitlab.example', repository: 'team/sub/repo' });
  for (const value of ['/tmp/repo', 'file:///tmp/repo', 'https://token@github.com/o/r', 'https://u:p@github.com/o/r', 'git@github.com:../repo', 'https://github.com/o/r?token=secret']) assert.throws(() => remoteIdentity(value));
});

test('connect reads dirty checkout unchanged, validates target/auth and canonical worktrees', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-git-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', 'git@github.com:owner/repo.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(dir, 'untracked.txt'), 'keep me');
  const before = git('status', '--porcelain=v1');
  const calls: string[][] = [];
  const command: Run = async (file, args, cwd) => {
    calls.push([file, ...args]);
    if (file === 'gh') { assert.deepEqual(args, ['auth', 'status', '--hostname', 'github.com']); return ''; }
    return run(file, args, cwd);
  };
  const input = { checkout: dir, remote: 'origin', target_branch: 'main', hosting: 'github' as const };
  const result = await inspectProject(input, command);
  assert.equal(result.checkout, dir);
  assert.equal(result.repository, 'owner/repo');
  assert.equal(git('status', '--porcelain=v1'), before);
  assert.ok(calls.every(call => call[0] === 'gh' || ['rev-parse', 'check-ref-format', 'remote', 'show-ref'].includes(call[1])));
  await assert.rejects(inspectProject({ ...input, target_branch: 'missing' }, command), /целевую ветку/);
  await assert.rejects(inspectProject({ ...input, remote: '--upload-pack=bad' }, command), /remote/);
  await assert.rejects(inspectProject({ ...input, hosting: 'gitlab' }, command), /Hosting/);
  await assert.rejects(inspectProject(input, async (file, args, cwd) => {
    if (file === 'gh') throw new Error('auth failed');
    return run(file, args, cwd);
  }), /auth failed/);
  git('remote', 'add', 'gitlab', 'git@gitlab.example:team/sub/repo.git');
  git('update-ref', 'refs/remotes/gitlab/main', 'HEAD');
  const gitlab = await inspectProject({ ...input, remote: 'gitlab', hosting: 'gitlab' }, async (file, args, cwd) => {
    if (file === 'glab') { assert.deepEqual(args, ['auth', 'status', '--hostname', 'gitlab.example']); return ''; }
    return run(file, args, cwd);
  });
  assert.equal(gitlab.repository, 'team/sub/repo');
  const worktree = join(dir, 'linked');
  git('worktree', 'add', '-b', 'linked', worktree);
  assert.equal((await inspectProject({ ...input, checkout: worktree }, command)).common_dir, result.common_dir);
});

test('missing executable returns an actionable error without stderr', async () => {
  await assert.rejects(run('swfactory-nonexistent-cli', ['auth', 'status'], tmpdir()), /Не найден/);
});
