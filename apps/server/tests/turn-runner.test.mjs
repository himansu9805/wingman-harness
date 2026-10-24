import assert from 'node:assert/strict';
import { test } from 'node:test';
import runner from '../dist/agent/turn-runner.service.js';
const deferred = () => { let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}; };
test('runner accepts independently, reserves during preparation, conflicts per thread and drains on shutdown', async () => {
 const r=new runner.TurnRunner();const prepare=deferred();const finish=deferred();let signal;
 const accepting=r.accept('a',async()=>{await prepare.promise;return async(_id,s)=>{signal=s;await finish.promise}});
 await assert.rejects(r.accept('a',async()=>async()=>{}), e=>e.status===409);
 prepare.resolve();const accepted=await accepting;assert.match(accepted.runId,/^[\da-f-]{36}$/);
 const other=await r.accept('b',async()=>async()=>{});await other.completion;
 await assert.rejects(r.exclusive('a',async()=>{}),e=>e.status===409);
 const closing=r.close();assert.equal(signal.aborted,true);
 await assert.rejects(r.accept('c',async()=>async()=>{}),e=>e.status===503);
 finish.resolve();await closing;await accepted.completion;
});
test('failed preparation releases reservation without executing', async()=>{
 const r=new runner.TurnRunner();await assert.rejects(r.accept('a',async()=>{throw Error('invalid')}),/invalid/);
 const run=await r.accept('a',async()=>async()=>{});await run.completion;await r.close();
});

test('shutdown drains deletion mutations before repositories can close', async () => {
 const r = new runner.TurnRunner(); const gate = deferred(); let closed = false;
 const deletion = r.exclusive('thread', async () => { await gate.promise; assert.equal(closed, false); });
 const shutdown = r.close().then(() => { closed = true; });
 await Promise.resolve(); assert.equal(closed, false);
 await assert.rejects(r.exclusive('other', async () => {}), e => e.status === 503);
 gate.resolve(); await Promise.all([deletion, shutdown]); assert.equal(closed, true);
});
