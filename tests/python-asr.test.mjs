import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {PythonAsr} from '../lib/core/python-asr.js';
import {resolveEngine} from '../lib/core/engine.js';
const request=(sessionId,audio,final=false)=>({sessionId,audio:Buffer.from(audio).toString('base64'),final});
test('buffers independent sessions and flushes only at stop',async()=>{
 const worker=new PythonAsr({});const captured=[];
 worker.transcribe=async audio=>{captured.push([...audio]);return {text:'结果'}};
 await worker.handle(request('a',[1,0]));await worker.handle(request('b',[2,0]));
 assert.equal(captured.length,0);
 assert.equal((await worker.handle(request('a',[3,0],true))).value.delta,'结果');
 assert.deepEqual(captured,[[1,0,3,0]]);
 await worker.handle(request('b',[],true));assert.deepEqual(captured[1],[2,0]);
 assert.equal(worker.sessions.size,0);
});
test('empty stop skips inference and invalid audio cannot leak to next recording',async()=>{
 const worker=new PythonAsr({});worker.transcribe=()=>assert.fail('Must not infer');
 assert.equal((await worker.handle(request('a',[],true))).value.delta,'');
 await worker.handle(request('a',[1]));
 assert.equal((await worker.handle(request('a',[],true))).ok,false);
 assert.equal(worker.sessions.size,0);
});
test('worker errors are surfaced, never replaced with browser transcription',async()=>{
 const worker=new PythonAsr({});worker.transcribe=async()=>{throw new Error('CUDA failure')};
 const out=await worker.handle(request('a',[1,0],true));
 assert.equal(out.ok,false);assert.match(out.error.message,/CUDA failure/);
 assert.equal(resolveEngine('native',false),'native');
});
test('audio limits and session limits bound memory',async()=>{
 const worker=new PythonAsr({});
 for(let i=0;i<4;i++)await worker.handle(request('s'+i,[0,0]));
 assert.equal((await worker.handle(request('extra',[0,0]))).error.code,'busy');
 const session=worker.sessions.get('s0');session.bytes=16000*2*120;
 await worker.handle(request('s0',[0,0]));
 assert.equal((await worker.handle(request('s0',[],true))).ok,false);
});

class FakeChild extends EventEmitter {
 constructor() {
  super();this.stdin=new PassThrough();this.stdout=new PassThrough();this.stderr=new PassThrough();
  this.exitCode=null;this.signalCode=null;this.killed=false;this.signals=[];this.requests=[];
  this.stdin.on('data',data=>this.requests.push(JSON.parse(data.toString())));
 }
 send(message){this.stdout.write(JSON.stringify(message)+'\n')}
 kill(signal){this.killed=true;this.signals.push(signal);return true}
 exit(code=null,signal='SIGTERM') {
  this.exitCode=code;this.signalCode=signal;this.emit('exit',code,signal);this.emit('close',code,signal);
 }
}
class FakeTimers {
 constructor(){this.tasks=new Set()}
 setTimeout=(fn,delay)=>{const task={fn,delay,unref(){}};this.tasks.add(task);return task};
 clearTimeout=task=>this.tasks.delete(task);
 fire(delay){
  const tasks=[...this.tasks].filter(task=>task.delay===delay);
  assert.ok(tasks.length>0,`Expected timer with delay ${delay}`);
  for(const task of tasks){this.tasks.delete(task);task.fn()}
 }
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,spawnOverride) {
 const children=[],logs=[],calls=[],clock=new FakeTimers();
 const worker=new PythonAsr({pythonExecutable:'fake-python',nativeBackend:'qwen',qwenModelDir:'/fake/model',asrDevice:'cuda'},
  message=>logs.push(message),{
   spawn:(...args)=>{calls.push(args);const child=spawnOverride?.(calls.length)??new FakeChild();children.push(child);return child},
   setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,loadTimeoutMs:100,transcribeTimeoutMs:200,killTimeoutMs:10,
  });
 t.after(()=>{worker.dispose();for(const child of children)child.exit();assert.equal(clock.tasks.size,0)});
 return {worker,children,logs,calls,clock};
}

test('idle construction and PCM buffering do not spawn or allocate timers',async t=>{
 const {worker,calls,clock}=fixture(t);
 assert.equal(calls.length,0);assert.equal(clock.tasks.size,0);
 await worker.handle(request('a',[1,0]));
 assert.equal(calls.length,0);assert.equal(clock.tasks.size,0);
 worker.dispose();
 assert.equal((await worker.handle(request('a',[],true))).ok,false);
 await assert.rejects(worker.start(),/disposed/);assert.equal(calls.length,0);
});

test('startup is single flight, publishes ready info and reuses only live ready worker',async t=>{
 const {worker,children,calls,clock}=fixture(t);
 const first=worker.start(),second=worker.start();
 assert.strictEqual(first,second);assert.equal(children.length,1);
 assert.equal(calls[0][0],'fake-python');assert.ok(calls[0][1].includes('/fake/model'));
 assert.equal(calls[0][2].env.PYTHONUNBUFFERED,'1');
 children[0].send({ready:true,backend:'qwen'});
 assert.strictEqual(await first,worker);assert.strictEqual(worker.start(),first);
 assert.equal(worker.info.backend,'qwen');assert.equal(children.length,1);assert.equal(clock.tasks.size,0);
});

test('ready worker exit clears cached flight and next start retries with exit signal logged',async t=>{
 const {worker,children,logs}=fixture(t);
 const first=worker.start();children[0].send({ready:true});await first;
 children[0].exit(null,'SIGKILL');
 assert.equal(worker.child,null);assert.equal(worker.startPromise,null);assert.equal(worker.info,undefined);
 assert.ok(logs.some(line=>line.includes('signal=SIGKILL')));
 const next=worker.start();assert.notStrictEqual(next,first);assert.equal(children.length,2);
 children[1].send({ready:true});await next;
});

test('exit during load rejects all concurrent callers and allows retry',async t=>{
 const {worker,children}=fixture(t);
 const first=worker.start(),second=worker.start();
 const rejected=Promise.all([assert.rejects(first,/code=7/),assert.rejects(second,/code=7/)]);
 children[0].exit(7,null);await rejected;
 assert.equal(worker.startPromise,null);
 const next=worker.start();children[1].send({ready:true});await next;
});

test('synchronous spawn throw preserves diagnostics and does not poison the next flight',async t=>{
 const {worker,children,calls,logs}=fixture(t,count=>{if(count===1)throw new Error('spawn ENOENT diagnostic')});
 await assert.rejects(worker.start(),/spawn ENOENT diagnostic/);
 assert.equal(worker.startPromise,null);assert.equal(worker.workers.size,0);
 assert.ok(logs.includes('spawn ENOENT diagnostic'));
 const next=worker.start();assert.equal(calls.length,2);children[0].send({ready:true});await next;
});

test('async spawn error + close without exit rejects, cleans timer and retries',async t=>{
 const {worker,children,clock}=fixture(t);
 const rejected=assert.rejects(worker.start(),/EACCES/);
 children[0].emit('error',new Error('spawn EACCES'));children[0].emit('close',-13,null);
 await rejected;assert.equal(worker.startPromise,null);assert.equal(clock.tasks.size,0);
 const next=worker.start();children[1].send({ready:true});await next;
});

test('load failure keeps useful error, terminates old worker and stale exit cannot clear replacement',async t=>{
 const {worker,children,logs}=fixture(t);
 const rejected=assert.rejects(worker.start(),/CUDA out of memory/);
 children[0].stderr.write('CUDA loader context\n');
 children[0].send({ready:false,error:'CUDA out of memory'});await rejected;
 assert.deepEqual(children[0].signals,['SIGTERM']);assert.equal(worker.startPromise,null);
 const next=worker.start();children[1].send({ready:true});await next;
 // Late readiness, errors and exit from the retired worker cannot touch the replacement.
 children[0].send({ready:true,backend:'stale'});children[0].emit('error',new Error('late old error'));
 children[0].exit(1,null);
 assert.strictEqual(worker.child,children[1]);assert.strictEqual(worker.startPromise,next);
 assert.equal(worker.info.backend,undefined);assert.ok(logs.includes('CUDA out of memory'));
 assert.ok(logs.includes('CUDA loader context'));assert.ok(logs.some(line=>line.includes('code=1')));
});

test('load timeout stops stale worker, escalates SIGKILL and permits generation-safe retry',async t=>{
 const {worker,children,clock}=fixture(t);
 const rejected=assert.rejects(worker.start(),/model load timed out/);
 clock.fire(100);await rejected;assert.equal(worker.startPromise,null);
 const next=worker.start();children[1].send({ready:true});await next;
 clock.fire(10);assert.deepEqual(children[0].signals,['SIGTERM','SIGKILL']);assert.deepEqual(children[1].signals,[]);
 children[0].exit(null,'SIGKILL');assert.strictEqual(worker.child,children[1]);
 assert.equal(clock.tasks.size,0);
});

test('external kill invalidates even a resolved start promise before exit arrives',async t=>{
 const {worker,children}=fixture(t);
 const first=worker.start();children[0].send({ready:true});await first;
 children[0].kill('SIGTERM');
 const next=worker.start();assert.notStrictEqual(next,first);assert.equal(children.length,2);
 children[1].send({ready:true});await next;
 children[0].exit();assert.strictEqual(worker.child,children[1]);
});

test('dispose rejects loading flight immediately, forbids retry and cleans on close',async t=>{
 const {worker,children,clock}=fixture(t);
 const rejected=assert.rejects(worker.start(),/disposed/);
 worker.dispose();worker.dispose();await rejected;
 assert.equal(worker.child,null);assert.equal(worker.startPromise,null);
 assert.deepEqual(children[0].signals,['SIGTERM']);
 await assert.rejects(worker.start(),/disposed/);assert.equal(children.length,1);
 children[0].exit();assert.equal(clock.tasks.size,0);assert.equal(worker.workers.size,0);
});

test('transcriptions are serialized, use one live worker and preserve PCM payload',async t=>{
 const {worker,children,clock}=fixture(t);
 const first=worker.transcribe(Buffer.from([1,0,2,0]));
 const second=worker.transcribe(Buffer.from([3,0]));
 await flush();children[0].send({ready:true});await flush();
 assert.equal(children[0].requests.length,1);
 assert.equal(children[0].requests[0].audio,Buffer.from([1,0,2,0]).toString('base64'));
 children[0].send({id:children[0].requests[0].id,text:'first'});assert.equal((await first).text,'first');
 await flush();assert.equal(children.length,1);assert.equal(children[0].requests.length,2);
 children[0].send({id:children[0].requests[1].id,text:'second'});assert.equal((await second).text,'second');
 assert.equal(worker.pending.size,0);assert.equal(clock.tasks.size,0);
});

test('recording PCM survives idle worker crash and retry, including other live sessions',async t=>{
 const {worker,children}=fixture(t);
 const prepared=worker.start();children[0].send({ready:true});await prepared;
 await worker.handle(request('recording',[1,0]));await worker.handle(request('other',[9,0]));
 children[0].exit(null,'SIGKILL');
 assert.equal(worker.sessions.size,2);assert.equal(worker.sessions.get('recording').bytes,2);
 await worker.handle(request('recording',[2,0]));
 const final=worker.handle(request('recording',[3,0],true));
 await flush();assert.equal(children.length,2);children[1].send({ready:true});await flush();
 const message=children[1].requests[0];
 assert.deepEqual([...Buffer.from(message.audio,'base64')],[1,0,2,0,3,0]);
 assert.equal(worker.sessions.get('other').bytes,2);
 children[1].send({id:message.id,text:'complete recording'});
 assert.deepEqual(await final,{ok:true,value:{delta:'complete recording',final:true}});
 worker.dispose();assert.equal(worker.sessions.size,0);
});

test('recording PCM survives another session transcription timeout without being truncated',async t=>{
 const {worker,children,clock}=fixture(t);
 const prepared=worker.start();children[0].send({ready:true});await prepared;
 await worker.handle(request('recording',[1,0]));
 const failing=worker.handle(request('other',[8,0],true));await flush();
 clock.fire(200);assert.equal((await failing).ok,false);
 assert.equal(worker.sessions.get('recording').bytes,2);
 const final=worker.handle(request('recording',[2,0],true));
 await flush();children[1].send({ready:true});await flush();
 assert.deepEqual([...Buffer.from(children[1].requests[0].audio,'base64')],[1,0,2,0]);
 children[1].send({id:children[1].requests[0].id,text:'complete'});assert.equal((await final).value.delta,'complete');
});

test('worker crash rejects pending transcription and retry cannot be damaged by old messages',async t=>{
 const {worker,children}=fixture(t);
 const first=worker.transcribe(Buffer.from([1,0]));const rejected=assert.rejects(first,/SIGSEGV/);
 await flush();children[0].send({ready:true});await flush();
 children[0].exit(null,'SIGSEGV');await rejected;assert.equal(worker.pending.size,0);
 const second=worker.transcribe(Buffer.from([2,0]));
 await flush();children[1].send({ready:true});await flush();
 const id=children[1].requests[0].id;
 children[0].send({id,text:'wrong generation'});children[0].emit('error',new Error('late error'));
 assert.equal(worker.pending.size,1);assert.strictEqual(worker.child,children[1]);
 children[1].send({id,text:'recovered'});assert.equal((await second).text,'recovered');
});

test('transcription timeout rejects pending work, kills timed-out generation and retries',async t=>{
 const {worker,children,clock}=fixture(t);
 const first=worker.transcribe(Buffer.from([1,0]));const rejected=assert.rejects(first,/transcription timed out/);
 await flush();children[0].send({ready:true});await flush();
 clock.fire(200);await rejected;
 assert.equal(worker.pending.size,0);assert.equal(worker.startPromise,null);assert.deepEqual(children[0].signals,['SIGTERM']);
 const second=worker.transcribe(Buffer.from([2,0]));
 await flush();children[1].send({ready:true});await flush();
 clock.fire(10);assert.deepEqual(children[1].signals,[]);
 children[0].exit();assert.equal(worker.pending.size,1);
 children[1].send({id:children[1].requests[0].id,text:'retry'});assert.equal((await second).text,'retry');
 assert.equal(clock.tasks.size,0);
});

test('dispose rejects both in-flight and queued transcriptions without spawning again',async t=>{
 const {worker,children}=fixture(t);
 const first=worker.transcribe(Buffer.from([1,0]));const second=worker.transcribe(Buffer.from([2,0]));
 const rejected=Promise.all([assert.rejects(first,/disposed/),assert.rejects(second,/disposed/)]);
 await flush();children[0].send({ready:true});await flush();
 worker.dispose();await rejected;assert.equal(worker.pending.size,0);assert.equal(children.length,1);
 await assert.rejects(worker.transcribe(Buffer.from([3,0])),/disposed/);
 assert.equal(children.length,1);
});

test('stdin write callback failure rejects pending call and retires unusable worker',async t=>{
 const {worker,children}=fixture(t);
 const started=worker.start();children[0].send({ready:true});await started;
 children[0].stdin.write=(_data,callback)=>{callback(new Error('write EPIPE'));return false};
 await assert.rejects(worker.transcribe(Buffer.from([1,0])),/write EPIPE/);
 assert.equal(worker.pending.size,0);assert.equal(worker.startPromise,null);assert.deepEqual(children[0].signals,['SIGTERM']);
 const next=worker.start();children[1].send({ready:true});await next;
});

test('per-transcription model error clears pending timer but retains healthy worker',async t=>{
 const {worker,children,clock}=fixture(t);
 const run=worker.transcribe(Buffer.from([1,0]));const rejected=assert.rejects(run,/decode failed/);
 await flush();children[0].send({ready:true});await flush();
 children[0].send({id:children[0].requests[0].id,error:'decode failed'});await rejected;
 assert.equal(worker.pending.size,0);assert.equal(clock.tasks.size,0);
 assert.strictEqual(await worker.start(),worker);assert.equal(children.length,1);
});
