// Manual integration smoke: real Codex + private GitHub toy repository; never merge.
import { createApp } from '../src/server/app.js';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const directory='/tmp/swfactory-real-evidence-2';
const origin='http://127.0.0.1:4319';
const {app, store, token}=await createApp({directory,origin});
const login=await app.inject({method:'POST',url:'/api/session',headers:{host:'127.0.0.1:4319',origin},payload:{token}});
const headers={host:'127.0.0.1:4319',origin,cookie:String(login.headers['set-cookie']).split(';')[0]};
async function post(url:string,payload:object) {
 const res=await app.inject({method:'POST',url,headers,payload:{request_id:randomUUID(),...payload}});
 if(res.statusCode!==200) throw new Error(`${url}: ${res.body}`);
 return res.json();
}
try {
 const project=await post('/api/projects',{state_version:0,checkout:realpathSync('/tmp/swfactory-real-smoke'),remote:'origin',hosting:'github',target_branch:'main'});
 assert.equal(project.remote_url, 'https://github.com/ek2kk/swfactory-smoke.git');
 assert.equal(project.repository, 'ek2kk/swfactory-smoke');
 const task=await post(`/api/projects/${project.id}/tasks`,{state_version:project.state_version,description:'Add a tiny dependency-free Node.js CLI hello.mjs that prints one greeting line and exits. Add test/hello.test.mjs as a node:test test file verifying exact stdout and exit status, and document how to run both in README.md. IMPORTANT: the greeting text is deliberately unspecified and must be asked as a required clarification question during Spec before Build. Do not assume the greeting. No other features.'});
 const path=`/api/projects/${project.id}/tasks/${task.id}`;
 const current=()=>store.task(project.id,task.id);
 async function settled() {
  let previous='';
  for(let n=0;n<900;n++) {
   const t=current(), run=store.runs().at(-1);const state=`${t.stage}/${t.run_state} ${run?.role}/${run?.status}`;
   if(state!==previous){console.log(new Date().toISOString(),state,run?.error??'');previous=state;}
   if(!['queued','running'].includes(t.run_state)) return t;
   await delay(2000);
  }throw new Error('Pipeline timeout');
 }
 await post(`${path}/start`,{state_version:current().state_version});
 await settled();
 const question=store.humanRequests().find(q=>q.status==='pending');
 if(!question) throw new Error('Expected real Spec question');
 console.log('QUESTION',JSON.stringify(question.result.questions));
 await post(`${path}/questions/${question.id}/answer`,{state_version:current().state_version,answers:question.result.questions.map(()=>'The exact greeting is Hello, SW Factory! followed by a single newline. Use Node.js built-in node:test; no dependencies.')});
 await settled();
 if(current().stage==='build' && current().run_state==='idle') {
  await post(`${path}/build`,{state_version:current().state_version}); await settled();
 }
 if(current().stage!=='approve')throw new Error('Four reviews did not pass');
 if(current().run_state==='idle') { await post(`${path}/approve`,{state_version:current().state_version}); await settled(); }
 if(current().stage!=='approve'||current().run_state!=='completed')throw new Error('Approver did not approve');
 const approved=store.runs().at(-1)!;
 const changed=execFileSync('git',['diff','--name-only',approved.base_sha!,approved.head_sha!],{cwd:approved.worktree,encoding:'utf8'}).trim().split('\n').sort();
 assert.deepEqual(changed,['README.md','hello.mjs','test/hello.test.mjs']);
 assert.equal(execFileSync('git',['remote','get-url','--push','--all','origin'],{cwd:approved.worktree,encoding:'utf8'}).trim(), 'https://github.com/ek2kk/swfactory-smoke.git');
 await post(`${path}/publish`,{state_version:current().state_version});
 await settled();
 if(current().publication_status!=='confirmed')throw new Error('Publication unconfirmed');
 writeFileSync(`${directory}/evidence.json`,JSON.stringify(store.snapshot(),null,2));
 console.log('SUCCESS',current().pr_url);
} finally {writeFileSync(`${directory}/snapshot.json`,JSON.stringify(store.snapshot(),null,2));await app.close();}
