import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { classifyFailure } from '../src/server/diagnostics.js';
import { Store } from '../src/server/store.js';
import { defaultModels, roles } from '../src/shared.js';
import { executeSpec, executeBuild, executeReview, executeApprove } from '../src/server/codex.js';
import { supportsFast } from '../src/server/models.js';

const ready = { outcome: 'READY', title: 'Fast', summary: 'Confirmed', requirements: ['One'], acceptance_criteria: ['Test'], assumptions: [], out_of_scope: [], questions: [] };
const model = { id: 'test-model', name: 'Test', fast: { supported: true, reason: 'Confirmed', auth: 'chatgpt' as const }, reasoning_efforts: [{ effort: 'low', description: '' }, { effort: 'high', description: '' }] };

test('Fast persists independently for six roles and two projects, survives restart and freezes snapshots; legacy stays inherited', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-fast-api-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = 'http://127.0.0.1:4317';
  let available = true;
  const { app, store, token } = await createApp({ directory, origin, discoverModels: async () => [{ ...model, fast: { ...model.fast, supported: available, reason: 'Account unavailable' } }] });
  t.after(() => app.close());
  const projects = ['one', 'two'].map(name => store.addProject({ checkout: directory, common_dir: join(directory, name), remote: 'origin', remote_url: 'git@github.com:o/r.git', host: 'github.com', repository: name, hosting: 'github', target_branch: 'main' }));
  const session = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const configs = projects.map((_, i) => ({ models: Object.fromEntries(roles.map(role => [role, model.id])) as typeof defaultModels, instructions: `Instructions \n${i}`, reasoning_efforts: Object.fromEntries(roles.map((role, n) => [role, n % 2 ? 'high' : 'low'])), fast_modes: Object.fromEntries(roles.map((role, n) => [role, n % 2 === i])) }));
  const put = (i: number, config: object, version: number, request_id = randomUUID()) => app.inject({ method: 'PUT', url: `/api/projects/${projects[i].id}/settings`, headers, payload: { ...config, request_id, state_version: version } });
  for (let i = 0; i < projects.length; i++) {
    assert.deepEqual(store.settings(projects[i].id).fast_modes, Object.fromEntries(roles.map(role => [role, false])));
    assert.equal((await put(i, configs[i], 1)).statusCode, 200);
    assert.deepEqual((await app.inject({url:`/api/projects/${projects[i].id}/settings`,headers})).json(), { ...configs[i], state_version: 2 });
  }
  const task = store.createTask(projects[0].id, 'Snapshot', 2), run = store.queueSpec(projects[0].id, task.id, 1, directory);
  const opposite = { ...configs[0], fast_modes: configs[1].fast_modes };
  for (const fast_modes of [{ unknown: true }, { spec: 'true' }, { spec: null }, []]) assert.equal((await put(0, { ...opposite, fast_modes }, 2)).statusCode, 400);
  const id = randomUUID();
  assert.equal((await put(0, opposite, 2, id)).statusCode, 200);
  assert.equal((await put(0, opposite, 2, id)).statusCode, 200);
  assert.equal((await put(0, configs[0], 2)).statusCode, 409);
  assert.deepEqual(store.specRun(projects[0].id, task.id, run.id).config, configs[0]);
  available = false;
  assert.equal((await put(0, configs[0], 3)).statusCode, 422);
  assert.deepEqual(store.settings(projects[0].id), opposite);
  // Saving instructions retains existing true even if support disappears; execution must recheck it.
  assert.equal((await put(0, { ...opposite, instructions: 'Changed' }, 3)).statusCode, 200);
  const legacy = { models: { ...defaultModels, 'review-ui': 'legacy-ui', 'review-ux': 'legacy-ux' }, instructions: 'Legacy' };
  store.db.prepare('UPDATE project_settings SET config = ? WHERE project_id = ?').run(JSON.stringify(legacy), projects[1].id);
  const oldTask = store.createTask(projects[1].id, 'Legacy snapshot', 2), oldRun = store.queueSpec(projects[1].id, oldTask.id, 1, directory);
  assert.equal((await put(1, { ...legacy, instructions: 'Legacy changed' }, 2)).statusCode, 200);
  assert.equal(store.settings(projects[1].id).fast_modes, undefined);
  assert.equal(store.specRun(projects[1].id, oldTask.id, oldRun.id).config.fast_modes, undefined);
  assert.equal(store.settings(projects[1].id).models['review-ui'], 'legacy-ui');
  await app.close();
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.settings(projects[0].id).fast_modes, opposite.fast_modes);
    assert.equal(reopened.settings(projects[1].id).fast_modes, undefined);
    assert.deepEqual(reopened.specRun(projects[0].id, task.id, run.id).config, configs[0]);
  } finally { reopened.close(); }
});

for (const path of ['exec', 'app-server']) for (const role of roles) for (const fast of [true, false, undefined]) test(`${path} ${role} Fast=${fast}: actual adapter sends independent tier and effort`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-fast-cli-')), directory = join(root, 'run'); mkdirSync(directory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'codex');
  const result = role === 'spec' ? ready : role === 'build' ? { outcome: 'READY', summary: 'Built', changed_paths: ['x'], actions: ['Edit'], checks: ['Test'], questions: [], dependencies: [] }
    : role === 'approve' ? { outcome: 'APPROVE', summary: 'Approved', risks: [], affected_paths: [], questions: [] }
    : { outcome: 'PASS', summary: 'Reviewed', findings: [], evidence: ['Checked'], applicable: true, applicability: '', questions: [], dependencies: [], ...(role === 'review-ui-ux' ? { ui: { summary: 'UI', findings: [], evidence: ['Checked'] }, ux: { summary: 'UX', findings: [], evidence: ['Checked'] } } : {}) };
  writeFileSync(cli, `#!${process.execPath}
const assert=require('node:assert/strict'); const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli 0.162.1');process.exit(0);}
const fast=${JSON.stringify(fast)}, interactive=${path === 'app-server'};
const send=x=>console.log(JSON.stringify(x));
if(args[0]==='exec'){
 assert.deepEqual(args.filter(v=>v.startsWith('service_tier=')),fast===undefined?[]:['service_tier="'+(fast?'fast':'default')+'"']);
 assert.ok(args.includes('model_reasoning_effort="high"'));
 process.stdin.resume();process.stdin.on('end',()=>{for(const e of [{type:'thread.started'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify(result)})}},{type:'turn.completed'}])send(e);});
}else require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize')send({id:r.id,result:{userAgent:'swfactory/0.162.1 (test)'}});
 if(r.method==='account/read')send({id:r.id,result:{account:{type:'chatgpt'}}});
 if(r.method==='model/list')send({id:r.id,result:{data:[{model:'test-model',displayName:'Test',serviceTiers:[{id:'priority'}]}],nextCursor:null}});
 if(r.method==='thread/start'){
  assert.equal(r.params.serviceTier,fast===undefined?undefined:fast?'fast':'default');
  assert.deepEqual(args.filter(v=>v.startsWith('service_tier=')),fast===undefined?[]:['service_tier="'+(fast?'fast':'default')+'"']);
  send({id:r.id,result:{thread:{id:'thread'},serviceTier:fast?'priority':'default'}});
 }
 if(r.method==='turn/start'){
  assert.equal(r.params.effort,'high');send({id:r.id,result:{turn:{id:'turn'}}});
  send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});
  send({method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage',text:JSON.stringify(${JSON.stringify(result)})}}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
 }
});`, { mode: 0o700 });
  const execute = role === 'spec' ? executeSpec : role === 'build' ? executeBuild : role === 'approve' ? executeApprove : executeReview;
  assert.deepEqual(await execute({ cwd: root, directory, model: 'test-model', reasoningEffort: 'high', fast, reviewRole: role.startsWith('review-') ? role as 'review-code' | 'review-security' | 'review-ui-ux' : undefined, prompt: role, ...(path === 'app-server' ? { control() {} } : {}) }, cli), result);
  if (path === 'app-server' && fast !== undefined) assert.match(readFileSync(join(directory, 'events.jsonl'), 'utf8'), /run\/serviceTier/);
});

test('unverified CLI refuses explicit modes before execution; legacy sends no override', async t => {
  for (const version of [undefined, 'codex-cli 0.160.1', 'codex-cli 0.162.0']) assert.equal(supportsFast(version), false);
  assert.equal(supportsFast('codex-cli 0.162.1'), true);
  const root = mkdtempSync(join(tmpdir(), 'factory-fast-old-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'codex');writeFileSync(cli, `#!${process.execPath}\nconsole.log('codex-cli 0.160.1');`, { mode: 0o700 });
  for (const fast of [true, false]) await assert.rejects(executeSpec({ cwd:root,directory:root,model:'test-model',fast,prompt:'x' },cli),/0.162.1/);
});


for (const scenario of ['account', 'model', 'ignored-tier', 'denied-tier']) test(`Fast refuses ${scenario} without starting a fallback turn`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-fast-refuse-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'codex');
  writeFileSync(cli, `#!${process.execPath}
const assert=require('node:assert/strict');if(process.argv[2]==='--version'){console.log('codex-cli 0.162.1');process.exit(0);}
assert.equal(process.argv[2],'app-server'); const send=x=>console.log(JSON.stringify(x));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize')send({id:r.id,result:{userAgent:'swfactory/0.162.1 (test)'}});
 if(r.method==='account/read')send({id:r.id,result:{account:{type:${scenario === 'account' ? "'apiKey'" : "'chatgpt'"}}}});
 if(r.method==='model/list')send({id:r.id,result:{data:[{model:'test-model',displayName:'Test',serviceTiers:${scenario === 'model' ? '[]' : "[{id:'priority'}]"}}],nextCursor:null}});
 if(r.method==='thread/start')send(${scenario === 'denied-tier' ? "{id:r.id,error:{code:'unsupported_service_tier',message:'Fast mode not allowed for this account'}}" : "{id:r.id,result:{thread:{id:'thread'},serviceTier:null}}"});
 if(r.method==='turn/start')assert.fail('no fallback inference');
});`,{mode:0o700});
  await assert.rejects(executeSpec({cwd:root,directory:root,model:'test-model',fast:true,prompt:'x',control(){}},cli), scenario === 'account' ? /авторизация/ : scenario === 'model' ? /модели/ : scenario === 'ignored-tier' ? /не подтвердил/ : /аккаунту/);
});


test('Fast rate-limit diagnostics preserve the existing scheduler reset time', () => {
  const error = classifyFailure({ code: 'rate_limit_exceeded', message: 'Fast mode rate limit exceeded', reset_at: '2099-01-01T00:00:00Z' });
  assert.equal(error.kind, 'rate_limit'); assert.equal(error.resetAt, '2099-01-01T00:00:00.000Z');
});
