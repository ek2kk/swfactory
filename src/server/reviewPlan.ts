import { reviewsFor, type AgentRun, type ReviewRole, type ReviewPlan } from '../shared.js';
import type { Run } from './git.js';

// shortcut: path/content rules cannot infer arbitrary API semantics; extend rules for new trust-boundary APIs.
// Unknown paths and configuration require all roles rather than guessing applicability.
export function reviewImpact(paths: string[], diff: string): Record<'code' | 'security' | 'ui', boolean> {
  if (diff === 'Diff unavailable: all reviews required') return { code: true, security: true, ui: true };
  let code = false, security = false, ui = false;
  for (const path of paths) {
    if (/^(docs\/.*|README[^/]*|CHANGELOG[^/]*)\.md$/i.test(path)) continue;
    if (/\.(css|scss|sass)$/.test(path)) { ui = true; continue; }
    if (/\.(tsx|jsx|html)$/.test(path) || /(^|\/)(client|frontend|components|pages)\//.test(path)) { code = true; ui = true; continue; }
    if (/\.(ts|js|py|go|rs|java|rb)$/.test(path)) { code = true; continue; }
    code = security = ui = true;
  }
  const changed = diff.split('\n').filter(line => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)).join('\n');
  if (/auth|token|secret|password|cookie|session|fetch|request|https?|sql|query|exec|spawn|file|path|read|write|upload|download|innerHTML|eval|permission|cors|dependency|unlink|rename|mkdir|chmod|symlink|encrypt|decrypt|socket|sanitize|url/i.test(changed + '\n' + paths.filter(path => !/\.md$/i.test(path)).join('\n'))) security = true;
  if (/api|route|response|status|error|validation|schema|contract/i.test(changed + '\n' + paths.filter(path => !/\.md$/i.test(path)).join('\n'))) ui = true;
  return { code, security, ui };
}

export async function makeReviewPlan(run: AgentRun, command: Run, prior: AgentRun[], requirements = ''): Promise<ReviewPlan> {
  const previous = prior.find(r => r.round_id === run.repair_round_id);
  const compatible = prior.length > 0 && prior.every(r => !r.stale && r.description_revision === run.description_revision
    && r.spec_run_id === run.spec_run_id && r.base_sha === run.base_sha && r.project_version === run.project_version
    && JSON.stringify(r.config) === JSON.stringify(run.config));
  const diffBase = compatible && previous?.head_sha ? previous.head_sha : run.base_sha!;
  const paths = (await command('git', ['diff', '--name-only', '-z', '--no-renames', diffBase, run.head_sha!, '--'], run.worktree)).split('\0').filter(Boolean);
  const readDiff = async (base: string) => {
    try {
      const diff = await command('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, run.head_sha!, '--'], run.worktree);
      return Buffer.byteLength(diff) <= 64 * 1024 ? diff : 'Diff unavailable: all reviews required';
    }
    catch { return 'Diff unavailable: all reviews required'; }
  };
  const diff = await readDiff(diffBase);
  const impact = reviewImpact(paths, diff);
  const fullPaths = (await command('git', ['diff', '--name-only', '-z', '--no-renames', run.base_sha!, run.head_sha!, '--'], run.worktree)).split('\0').filter(Boolean);
  const fullDiff = diffBase === run.base_sha ? diff : await readDiff(run.base_sha!);
  const full = reviewImpact(fullPaths, fullDiff);
  if (full.code) {
    if (/auth|token|secret|password|access|permission|доступ|токен|секрет|авторизац/i.test(requirements)) full.security = true;
    if (/user journey|interface|screen|form|интерфейс|сценари|экран|форм[ауы]/i.test(requirements)) full.ui = true;
  }
  const affected = (role: ReviewRole, value: typeof impact) => role === 'review-code' ? value.code : role === 'review-security' ? value.security : value.ui;
  return { build_id: run.id, head_sha: run.head_sha!, source_hash: run.source_hash!, revision: run.description_revision, diff_base: diffBase, diff, requirements,
    checks: reviewsFor(run.config).map(role => {
      const old = prior.find(r => r.role === role);
      const failed = old?.outcome === 'CHANGES';
      const required = affected(role, full) || failed;
      const reuse = compatible && required && !affected(role, impact) && old?.status === 'completed' && old.outcome === 'PASS';
      return { role, required, ...(reuse ? { reuse_run_id: old.id } : {}), reason: failed ? 'Перепроверка предыдущих замечаний и diff исправления'
        : reuse ? `PASS ${old.id} применим: требования/config неизменны; diff ${diffBase}..${run.head_sha} не затрагивает область роли`
        : required ? 'Фактический diff затрагивает область роли или содержит неизвестные изменения'
        : 'Фактический diff не затрагивает область роли' };
    }) };
}
