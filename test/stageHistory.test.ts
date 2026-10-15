import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSummary, stageRoles, stageNames, stageStatus, stageTabStatus, stageTimeline } from '../src/client/stageHistory.js';
import { defaultModels, legacyReviewRoles, roles, type AgentRun, type ChatMessage, type HumanRequest, type SavedEvent, type TranscriptEntry } from '../src/shared.js';

const run = (id: string, changes: Partial<AgentRun> = {}): AgentRun => ({
  id, task_id: 'task', project_id: 'project', role: 'spec', description_revision: 1, status: 'completed', outcome: 'READY',
  stale: 0, config: { models: defaultModels, instructions: '' }, project_version: 1, parent_run_id: null, branch: 'branch',
  worktree: '/tmp', base_sha: null, head_sha: null, source_hash: null, report: 0, error: null, spec_run_id: null,
  round_id: null, repair_round_id: null, repair_attempt: 0, ...changes,
});
const event = (id: number, type: string, payload: object, at = '2026-10-14T10:00:00Z'): SavedEvent => ({
  id, type, payload: JSON.stringify(payload), task_id: 'task', created_at: at,
});
const entry = (id: string, at: string, kind: TranscriptEntry['kind'] = 'agent'): TranscriptEntry => ({ id, at, kind, title: kind, text: id });

test('Review summary uses latest results for one round and source, never old PASS or superseded CHANGES', () => {
  const config = { models: { ...defaultModels, 'review-ui': 'ui', 'review-ux': 'ux' }, instructions: '' };
  delete config.models['review-ui-ux'];
  const old = run('old-code', { config, role: 'review-code', round_id: 'old', head_sha: 'af36e71f', outcome: 'PASS' });
  const current = legacyReviewRoles.map(role => run(role, { config, role, round_id: 'current', head_sha: 'f21c38c4', source_hash: 'source', repair_attempt: 2,
    outcome: role === 'review-code' ? 'CHANGES' : 'PASS' }));
  const history = [old, ...current];
  const summary = reviewSummary(history, 1)!;
  assert.equal(summary.round, 'current'); assert.equal(summary.passed, false);
  assert.deepEqual(summary.blockers.map(entry => entry.role), ['review-code']);
  assert.deepEqual(summary.entries.map(entry => entry.run?.outcome), ['CHANGES', 'PASS', 'PASS', 'PASS']);
  assert.ok(summary.entries.every(entry => entry.current));
  const fixed = { ...current[0], id: 'fixed-code', outcome: 'PASS' as const };
  assert.equal(reviewSummary([...history, fixed], 1)!.passed, true);
  assert.equal(reviewSummary([...history, { ...fixed, status: 'failed', outcome: null }], 1)!.passed, false);
  for (const change of [{ head_sha: 'other' }, { source_hash: 'other' }, { spec_run_id: 'other' }, { base_sha: 'other' },
    { project_version: 2 }, { config: { ...config, instructions: 'changed' } }, { stale: 1 }, { revoked: 1 }, { description_revision: 0 }]) {
    const changed = current.map(r => r.role === 'review-code' ? { ...r, ...change, outcome: 'PASS' as const } : r);
    assert.equal(reviewSummary([old, ...changed], 1)!.entries[0].current, false, JSON.stringify(change));
  }
  const missing = reviewSummary([old, ...current.slice(1)], 1)!;
  assert.equal(missing.entries[0].run?.id, old.id); assert.equal(missing.entries[0].current, false);
  assert.deepEqual(missing.blockers.map(entry => entry.role), ['review-code']);
});

test('Review summary distinguishes explicit reused PASS and optional reviews from current results', () => {
  const old = run('old', { role: 'review-security', round_id: 'previous', outcome: 'PASS', head_sha: 'previous' });
  const build = run('build', { role: 'build', head_sha: 'head', source_hash: 'source', review_plan: {
    policy_version: 2, build_id: 'build', revision: 1, head_sha: 'head', source_hash: 'source', diff_base: 'previous',
    checks: [{ role: 'review-code', required: false, reason: 'CSS only' },
      { role: 'review-security', required: true, reuse_run_id: old.id, reason: 'Unchanged' },
      { role: 'review-ui-ux', required: true, reason: 'Layout' }],
  } });
  const ui = { ...build, id: 'ui', role: 'review-ui-ux' as const, round_id: build.id, outcome: 'PASS' as const };
  const summary = reviewSummary([old, build, ui], 1)!;
  assert.equal(summary.passed, true); assert.equal(summary.entries[0].required, false);
  assert.equal(summary.entries[1].reused, true); assert.equal(summary.entries[1].current, true);
  assert.equal(reviewSummary([{ ...old, stale: 1 }, build, ui], 1)!.passed, false);
  assert.equal(reviewSummary([old, build, { ...ui, stale: 1 }], 1)!.passed, false);
  assert.equal(reviewSummary([old, { ...build, stale: 1 }, ui], 1)!.passed, false);
  assert.equal(reviewSummary([old, ui], 1)!.passed, false);
});

test('review tabs select the current Build round before Review and after reload', () => {
  const old = run('old-security', { role: 'review-security', outcome: 'PASS', round_id: 'old-build' });
  const build = run('new-build', { role: 'build', review_plan: {
    build_id: 'new-build', revision: 1, head_sha: 'head', source_hash: 'source', diff_base: 'base',
    checks: [{ role: 'review-security', required: true, reason: 'Code changed' }],
  } });
  const history = [old, build];
  assert.equal(stageTabStatus('review-security', history, 1, []).label, 'Ещё не запускался');
  assert.equal(stageTabStatus('review-security', structuredClone(history), 1, []).state, 'idle');
  assert.equal(stageTabStatus('review-security', [{ ...old, round_id: null }, { ...build, review_plan: undefined }], 1, []).state, 'idle');
  assert.equal(stageTabStatus('review-security', [old, run('spec')], 1, []).state, 'idle');
  assert.equal(stageTabStatus('build', history, 1, []).state, 'success');
  for (const status of ['queued', 'running', 'completed'] as const) {
    const current = run('current-security', { ...build, id: 'current-security', role: 'review-security', round_id: build.id,
      status, outcome: status === 'completed' ? 'PASS' : null });
    const runs = [...history, current];
    assert.equal(stageTabStatus('review-security', runs, 1, []).state, status === 'completed' ? 'success' : status);
    assert.equal(stageTabStatus('review-security', [...history, { ...current, stale: 1 }], 1, []).state, 'stale');
    assert.equal(stageTabStatus('review-security', runs, 2, []).state, 'stale');
  }
  const code = run('current-code', { role: 'review-code', outcome: 'PASS', round_id: build.id, review_plan: build.review_plan });
  assert.equal(stageTabStatus('review-security', [...history, code], 1, []).state, 'idle');
});

test('review tabs honor only explicit fresh reuse evidence and optional checks', () => {
  const pass = run('pass', { role: 'review-security', outcome: 'PASS', round_id: 'old-build' });
  const build = run('build', { role: 'build', review_plan: {
    build_id: 'build', revision: 1, head_sha: 'head', source_hash: 'source', diff_base: 'base',
    checks: [{ role: 'review-security', required: true, reason: 'Unchanged', reuse_run_id: pass.id }],
  } });
  const status = (runs: AgentRun[], revision = 1, requests: HumanRequest[] = []) => stageTabStatus('review-security', runs, revision, requests);
  assert.equal(status([pass, build]).label, 'Предыдущий PASS применим');
  assert.equal(status([pass, run('other', { role: 'review-security', outcome: 'CHANGES' }), build]).label, 'Предыдущий PASS применим');
  assert.equal(status([build]).state, 'idle');
  assert.equal(status([{ ...pass, stale: 1 }, build]).state, 'stale');
  assert.equal(status([{ ...pass, description_revision: 0 }, build]).state, 'stale');
  assert.equal(status([{ ...pass, outcome: 'CHANGES' }, build]).state, 'attention');
  assert.equal(status([pass, build], 1, [{ run_id: pass.id, status: 'pending' } as HumanRequest]).state, 'attention');
  assert.equal(status([pass, { ...build, stale: 1 }]).state, 'idle');
  assert.equal(status([pass, build], 2).state, 'idle');
  assert.equal(status([pass, { ...build, review_plan: { ...build.review_plan!, revision: 0 } }]).state, 'idle');
  const optional = { ...build, review_plan: { ...build.review_plan!, checks: [{ role: 'review-security' as const, required: false, reason: 'Not applicable' }] } };
  assert.equal(status([pass, optional]).label, 'Не требуется');
  assert.equal(status([pass, { ...optional, stale: 1 }]).label, 'Ещё не запускался');
});

test('stage status uses latest attempt, actual successful outcome, requirements version and pending human request', () => {
  assert.equal(stageStatus([], 1, []).state, 'idle');
  for (const role of roles) {
    const success = run('old', { role, outcome: role.startsWith('review-') ? 'PASS' : role === 'approve' ? 'APPROVE' : 'READY' });
    assert.equal(stageStatus([success], 1, []).state, 'success', role);
    for (const status of ['queued', 'running', 'failed', 'interrupted'] as const) {
      assert.equal(stageStatus([success, run('new', { role, status, outcome: null })], 1, []).state,
        status === 'queued' || status === 'running' ? status : 'attention');
    }
    for (const outcome of ['NEEDS_INPUT', 'BLOCKED', 'CHANGES', 'ESCALATE', null] as const) {
      assert.equal(stageStatus([success, run('new', { role, outcome })], 1, []).state, 'attention');
    }
    assert.equal(stageStatus([success], 2, []).state, 'stale');
    assert.equal(stageStatus([{ ...success, stale: 1 }], 1, []).state, 'stale');
    assert.equal(stageStatus([success], 1, [{ run_id: 'old', status: 'pending' } as HumanRequest]).state, 'attention');
    assert.equal(stageStatus([success, run('new', { role, outcome: success.outcome })], 1, [{ run_id: 'old', status: 'pending' } as HumanRequest]).state, 'success');
  }
});

test('all attempts, tools, messages and saved interventions form one stable newest-first stream', () => {
  const runs = [run('old'), run('new', { parent_run_id: 'old' })];
  const events = [event(1, 'spec.queued', { run_id: 'old' }), event(2, 'run.retried', { run_id: 'new', parent_run_id: 'old' }),
    event(3, 'run.interrupt-requested', { run_id: 'new' }, '2026-10-14T10:00:03Z')];
  const transcripts = { old: [entry('a', '2026-10-14T10:00:01Z'), entry('b', '', 'tool')],
    new: [entry('c', '2026-10-14T10:00:02Z'), entry('d', '2026-10-14T10:00:02Z', 'tool')] };
  const messages = [{ id: 'm', run_id: 'new', created_at: '2026-10-14T10:00:04Z', text: 'guidance' } as ChatMessage,
    { id: 'unbound', run_id: null, created_at: '2026-10-14T10:00:05Z' } as ChatMessage];
  const history = stageTimeline(runs, transcripts, messages, events, []);
  assert.deepEqual(history.map(item => item.id), ['message:m', 'event:3', 'transcript:d', 'transcript:c', 'transcript:b', 'transcript:a', 'event:2', 'event:1', 'report:new', 'report:old']);
  assert.equal(history.find(item => item.id === 'transcript:b')?.at, '', 'missing timestamp is not invented');
  assert.deepEqual(stageTimeline(runs, structuredClone(transcripts), structuredClone(messages), structuredClone(events), []).map(item => item.id), history.map(item => item.id), 'reload order is stable');
  const update = stageTimeline(runs, { ...transcripts, new: [...transcripts.new, entry('e', '2026-10-14T10:00:06Z')] }, messages, events, []);
  assert.deepEqual(update.slice(1).map(item => item.id), history.map(item => item.id));
  assert.equal(new Set(update.map(item => item.id)).size, update.length);
});

test('undated attempts retain saved sequence; continuation without model and human actions remain readable', () => {
  const result = { outcome: 'NEEDS_INPUT', summary: 'Choose', questions: [{ text: 'Which?' }] };
  const request = { id: 'q', run_id: 'old', result, answers: ['A'], status: 'answered' } as HumanRequest;
  const runs = [run('old', { role: 'build' }), run('new', { role: 'build', diagnostic: { result_run_id: 'old' }, report: 1 })];
  const events = [event(1, 'build.queued', { run_id: 'old' }), event(2, 'human.requested', { run_id: 'old', human_request_id: 'q' }),
    event(3, 'human.answered', { run_id: 'old', human_request_id: 'q' }), event(4, 'run.retried', { run_id: 'new' }),
    event(5, 'task.stop-verified-by-human', { evidence: 'Processes stopped' })];
  const history = stageTimeline(runs, { old: [entry('old1', ''), entry('old2', '')], new: [entry('new1', ''), entry('new2', '')] }, [], events, [request]);
  assert.ok(history.find(item => item.id === 'event:4')?.text.includes('без нового вызова модели'));
  assert.match(history.find(item => item.id === 'event:3')!.text, /Which\?\nA/);
  assert.equal(history.find(item => item.id === 'event:5')?.run?.id, 'new');
  assert.equal(history.find(item => item.id === 'report:new')?.at, '');
  assert.deepEqual(history.filter(item => item.kind === 'agent').map(item => item.text), ['new2', 'new1', 'old2', 'old1']);
});


test('diagnostics remain available without a saved report for every attempt', () => {
  for (const status of ['queued', 'running', 'completed', 'failed', 'interrupted'] as const) {
    const attempt = run(status, { status, report: 0, error: status === 'failed' ? 'CLI failed' : null });
    const history = stageTimeline([attempt], {}, [], [], []);
    const diagnostics = history.filter(item => item.kind === 'report');
    assert.equal(diagnostics.length, 1, status);
    assert.equal(diagnostics[0].run, attempt);
  }
});

test('legacy UI and UX reports remain on distinct history tabs alongside new combined runs', () => {
  const config = { models: { ...defaultModels, 'review-ui': 'old-ui', 'review-ux': 'old-ux' }, instructions: '' };
  delete config.models['review-ui-ux'];
  const history = [run('ui', { role: 'review-ui', config, outcome: 'PASS' }), run('ux', { role: 'review-ux', config, outcome: 'PASS' })];
  assert.deepEqual(stageRoles(history), ['spec', 'build', 'review-code', 'review-security', 'review-ui', 'review-ux', 'approve']);
  assert.equal(stageNames['review-ui'], 'Review · UI'); assert.equal(stageNames['review-ux'], 'Review · UX');
  assert.equal(stageStatus(history.slice(0, 1), 1, []).state, 'success');
  assert.ok(stageRoles([...history, run('combined', { role: 'review-ui-ux' })]).includes('review-ui-ux'));
  assert.ok(stageRoles([...history, run('combined', { role: 'review-ui-ux' })]).includes('review-ux'));
});

// Stop preserves a report without granting it authority in another cycle.
test('revoked successful reports remain historical at the same revision', () => {
  const run = { role: 'spec', status: 'completed', outcome: 'READY', description_revision: 1, revoked: 1 } as AgentRun;
  assert.equal(stageStatus([run], 1, []).state, 'stale');
});
