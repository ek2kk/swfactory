import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalogs, discoverModels, normalizeModels } from '../src/server/models.js';
import { defaultModels, roles } from '../src/shared.js';
import { createApp } from '../src/server/app.js';
import { randomUUID } from 'node:crypto';

const models = [{ id: 'model-a', name: 'Model A', reasoning_efforts: [{ effort: 'ultra', description: 'Thorough' }, { effort: 'medium', description: 'Balanced' }], default_reasoning_effort: 'medium' }, { id: 'provider/model-b', name: 'Model B' }];
test('catalog validates all entries and deduplicates exact model IDs', () => {
  assert.deepEqual(normalizeModels([...models, models[0]]), models);
  for (const bad of [null, [], [{}], [{ id: '-bad', name: 'Bad' }], [{ id: 'ok', name: '' }], [{ id: 'ok', name: 'bad\nname' }]]) assert.throws(() => normalizeModels(bad));
});

test('catalog survives restart; error and empty discovery retain last successful cache; defaults are explicit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-models-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const failing = async () => { throw new Error('private credential stderr'); };
  const initial = await new ModelCatalogs(directory, failing).get('project', directory);
  assert.equal(initial.source, 'defaults');
  assert.deepEqual(initial.models.map(m => m.id), [...new Set(Object.values(defaultModels))]);
  assert.ok(!initial.error?.includes('private credential'));
  let calls = 0;
  const catalog = new ModelCatalogs(directory, async () => { calls++; return models; });
  const [a, b] = await Promise.all([catalog.get('project', directory), catalog.get('project', directory)]);
  assert.equal(calls, 1); assert.deepEqual(a, b); assert.equal(a.source, 'codex');
  for (const discover of [failing, async () => [], async () => [{ id: '', name: 'bad' }]]) {
    const fallback = await new ModelCatalogs(directory, discover).get('project', directory);
    assert.equal(fallback.source, 'cache'); assert.deepEqual(fallback.models, models); assert.equal(fallback.updated_at, a.updated_at);
  }
  writeFileSync(join(directory, 'models-project.json'), '{broken');
  assert.equal((await new ModelCatalogs(directory, failing).get('project', directory)).source, 'defaults');
});

for (const scenario of ['pages', 'timeout', 'malformed', 'empty', 'error', 'cursor-loop'] as const) test(`Codex model/list ${scenario} never starts inference`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-model-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = join(directory, 'codex');
  writeFileSync(cli, `#!${process.execPath}
const assert=require('node:assert/strict');
assert.deepEqual(process.argv.slice(2),['app-server','--listen','stdio://']);
const send=x=>console.log(JSON.stringify(x));
let initialized=false;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 assert.ok(['initialize','initialized','model/list'].includes(r.method));
 if(r.method==='initialize') {send({id:r.id,result:{}});return;}
 if(r.method==='initialized'){initialized=true;return;}
 assert.ok(initialized); assert.equal(r.params.includeHidden,false);
 const scenario=${JSON.stringify(scenario)};
 if(scenario==='timeout')return;
 if(scenario==='malformed'){console.log('not json');return;}
 if(scenario==='error'){send({id:r.id,error:{message:'secret'}});return;}
 const data=scenario==='empty'?[]:[{id:'opaque',model:r.params.cursor?'provider/model-b':'model-a',displayName:r.params.cursor?'Model B':'Model A',hidden:false,...(r.params.cursor?{}:{supportedReasoningEfforts:[{reasoningEffort:'ultra',description:'Thorough'},{reasoningEffort:'medium',description:'Balanced'}],defaultReasoningEffort:'medium'})}];
 send({id:r.id,result:{data,nextCursor:scenario==='cursor-loop'?'next':scenario==='pages'&&!r.params.cursor?'next':null}});
});`, { mode: 0o700 });
  if (scenario === 'pages') assert.deepEqual(await discoverModels(directory, cli), models);
  else await assert.rejects(discoverModels(directory, cli, 1000));
});

test('model endpoint requires session and owned project; selected IDs persist without changing existing run config', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-model-api-'));
  const origin = 'http://127.0.0.1:4317';
  const { app, store, token } = await createApp({ directory, origin, discoverModels: async () => models });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject({ checkout: directory, common_dir: directory, remote: 'origin', remote_url: 'git@github.com:o/r.git', host: 'github.com', repository: 'o/r', hosting: 'github', target_branch: 'main' });
  const session = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const url = `/api/projects/${project.id}/models`;
  assert.equal((await app.inject({url,headers:{host:headers.host}})).statusCode,401);
  assert.equal((await app.inject({url:`/api/projects/${randomUUID()}/models`,headers})).statusCode,404);
  assert.deepEqual((await app.inject({url,headers})).json().models,models);
  const task=store.createTask(project.id,'Task',1), run=store.queueSpec(project.id,task.id,1,directory);
  const selected=Object.fromEntries(roles.map(role=>[role,'custom/model']));
  const payload={request_id:randomUUID(),state_version:1,models:selected,instructions:'Keep instructions'};
  const settings=`/api/projects/${project.id}/settings`;
  assert.equal((await app.inject({method:'PUT',url:settings,headers,payload})).statusCode,200);
  assert.deepEqual((await app.inject({url:settings,headers})).json().models,selected);
  assert.deepEqual(store.specRun(project.id,task.id,run.id).config.models,defaultModels);
  assert.equal((await app.inject({method:'PUT',url:settings,headers,payload:{...payload,request_id:randomUUID()}})).statusCode,409);
  assert.equal((await app.inject({method:'PUT',url:settings,headers,payload:{...payload,request_id:randomUUID(),state_version:2,models:{...selected,spec:'invalid model'}}})).statusCode,400);
});


test('reasoning metadata validates defaults and options; old catalogs stay usable', () => {
  assert.deepEqual(normalizeModels([{ id: 'old', name: 'Old' }]), [{ id: 'old', name: 'Old' }]);
  for (const reasoning_efforts of [null, {}, [{ effort: 'high', description: 1 }], [{ effort: 'bad effort', description: '' }], [{ effort: 'high', description: 'bad\ntext' }], [{ effort: 'high', description: '' }, { effort: 'high', description: '' }]]) {
    assert.throws(() => normalizeModels([{ id: 'm', name: 'M', reasoning_efforts }]));
  }
  assert.throws(() => normalizeModels([{ ...models[0], default_reasoning_effort: 'unsupported' }]));
});

test('reasoning settings validate model capabilities, freeze in runs and preserve legacy defaults', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-effort-api-'));
  const origin = 'http://127.0.0.1:4317';
  let current = models;
  const { app, store, token } = await createApp({ directory, origin, discoverModels: async () => current });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.addProject({ checkout: directory, common_dir: directory, remote: 'origin', remote_url: 'git@github.com:o/r.git', host: 'github.com', repository: 'o/r', hosting: 'github', target_branch: 'main' });
  const session = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:4317', origin }, payload: { token } });
  const headers = { host: '127.0.0.1:4317', origin, cookie: String(session.headers['set-cookie']).split(';')[0] };
  const url = `/api/projects/${project.id}/settings`;
  assert.equal(store.settings(project.id).reasoning_efforts, undefined);
  const selected = Object.fromEntries(roles.map(role => [role, 'model-a']));
  const put = (config: object, state_version: number) => app.inject({ method: 'PUT', url, headers, payload: { request_id: randomUUID(), state_version, models: selected, instructions: '', ...config } });
  const payload = { request_id: randomUUID(), state_version: 1, models: selected, instructions: '', reasoning_efforts: { spec: 'ultra', build: 'medium' } };
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload })).statusCode, 200);
  const task = store.createTask(project.id, 'Frozen effort', 2);
  const run = store.queueSpec(project.id, task.id, 1, directory);
  assert.deepEqual(run.config.reasoning_efforts, payload.reasoning_efforts);
  for (const reasoning_efforts of [{ spec: 'unsupported' }, { spec: 'medium', build: 'high' }]) assert.equal((await put({ reasoning_efforts }, 2)).statusCode, 422);
  for (const reasoning_efforts of [{ unknown: 'medium' }, { spec: '' }, { spec: 'bad effort' }, { spec: 2 }]) assert.equal((await put({ reasoning_efforts }, 2)).statusCode, 400);
  assert.equal((await put({ models: { ...selected, spec: 'custom-model' }, reasoning_efforts: { spec: 'ultra' } }, 2)).statusCode, 422);
  current = [{ id: 'model-a', name: 'No effort metadata' }];
  assert.equal((await put({ reasoning_efforts: payload.reasoning_efforts, instructions: 'Keep saved values' }, 2)).statusCode, 200);
  assert.equal((await put({ reasoning_efforts: {} }, 3)).statusCode, 200);
  assert.deepEqual(store.settings(project.id).reasoning_efforts, {});
  assert.deepEqual(store.specRun(project.id, task.id, run.id).config.reasoning_efforts, payload.reasoning_efforts);
  assert.equal((await app.inject({ method: 'PUT', url, headers, payload })).statusCode, 200, 'replay precedes catalog validation');
  assert.deepEqual(store.settings(project.id).reasoning_efforts, {});
});
