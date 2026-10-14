import test from 'node:test';
import assert from 'node:assert/strict';
import { stageStatus, stageTimeline } from '../src/client/stageHistory.js';
import { defaultModels, roles, type AgentRun, type ChatMessage, type HumanRequest, type SavedEvent, type TranscriptEntry } from '../src/shared.js';

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
  assert.deepEqual(history.map(item => item.id), ['message:m', 'event:3', 'transcript:d', 'transcript:c', 'transcript:b', 'transcript:a', 'event:2', 'event:1']);
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
