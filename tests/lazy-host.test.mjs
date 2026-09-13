import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { PythonAsr } from '../lib/core/python-asr.js';
import { VoiceRuntime } from '../lib/client/runtime.js';
import { createVoiceService } from '../lib/client/voice-service.js';

function setup(loadModel, engine='native') {
  // 插件现在还注册了一条 /tts 朗读通道;这里两条都要收,但权威性断言不变。
  const handlers={};
  const disposers=[], logs=[];
  let handler;
  const ctx={logger:{warn:(...args)=>logs.push(args)}, effect:fn=>{disposers.push(fn())},
    // 这个桩代表"没装 settings provider"的部署:inject 存在但依赖永不就绪,
    // 于是插件必须保持用行内 config 工作(见 lib/index.js 里 source 的回退路径)。
    inject:()=>({}),
    connection:{rpc:{handle:(channel,fn,options)=>{
      assert.ok(channel==='/voice'||channel==='/tts',`unexpected channel ${channel}`);
      assert.equal(options.authority,'loopback');
      handlers[channel]=fn;
      if(channel==='/voice')handler=fn;
      return ()=>{};
    }}}};
  apply(ctx,{engine,nativeBackend:'qwen',hotkey:'alt+m'},loadModel ? {loadModel} : {});
  return {call:(method,payload={})=>handler(method,payload),callTts:(method,payload={})=>handlers['/tts'](method,payload),logs,dispose:()=>disposers.forEach(fn=>fn?.())};
}

test('apply and config never initialize ASR; mic ping loads lazily and shares concurrent load',async()=>{
  let count=0,ready;
  const t=setup(()=>{count++;return new Promise(resolve=>{ready=resolve})});
  assert.equal(count,0);
  for(let i=0;i<3;i++){
    const config=await t.call('config');assert.equal(config.value.engine,'native');assert.equal(config.value.hotkey,'alt+m');
  }
  assert.equal(count,0);
  const p1=t.call('ping'),p2=t.call('ping');await Promise.resolve();
  assert.equal(count,1);ready({});
  assert.equal((await p1).value.engine,'native');assert.equal((await p2).value.engine,'native');
  const again=t.call('ping');await Promise.resolve();assert.equal(count,2);ready({});await again;
  t.dispose();
});

test('failed loading preserves cause and retries on the next mic ping',async()=>{
  let count=0;
  const t=setup(async()=>{if(++count===1)throw new Error('CUDA unavailable');return {}});
  const failed=await t.call('ping');assert.equal(failed.ok,false);assert.match(failed.error.message,/CUDA unavailable/);
  const ok=await t.call('ping');assert.equal(ok.value.engine,'native');assert.equal(count,2);t.dispose();
});

test('browser never loads and auto resolves only on click, not config',async()=>{
  const browser=setup(()=>assert.fail('browser must not load'),'browser');
  assert.equal((await browser.call('config')).value.engine,'browser');
  assert.equal((await browser.call('ping')).value.engine,'browser');
  assert.equal((await browser.call('asr')).ok,false);browser.dispose();
  let count=0;
  const auto=setup(async()=>{count++;throw new Error('missing model')},'auto');
  assert.equal((await auto.call('config')).value.engine,'auto');assert.equal(count,0);
  assert.equal((await auto.call('ping')).value.engine,'browser');assert.equal(count,1);
  assert.equal((await auto.call('ping')).value.engine,'browser');assert.equal(count,2);auto.dispose();
});

test('disposal during startup prevents successful readiness or later startup',async()=>{
  let ready,count=0;
  const t=setup(()=>{count++;return new Promise(resolve=>{ready=resolve})});
  const pending=t.call('ping');await Promise.resolve();t.dispose();ready({});
  assert.equal((await pending).ok,false);
  assert.equal((await t.call('ping')).ok,false);assert.equal(count,1);
});

test('production Python load path checks child on each ping, never caches readiness',async(t)=>{
  let starts=0;
  t.mock.method(PythonAsr.prototype,'start',async function(){starts++;if(starts===2)throw new Error('worker exited');return this});
  const host=setup();await host.call('config');assert.equal(starts,0);
  assert.equal((await host.call('ping')).ok,true);
  assert.match((await host.call('ping')).error.message,/worker exited/);
  assert.equal((await host.call('ping')).ok,true);assert.equal(starts,3);host.dispose();
});

test('end-to-end runtime -> voice service -> host: click loads before capture',async()=>{
  let loads=0,ready,starts=0;
  const host=setup(()=>{loads++;return new Promise(resolve=>{ready=resolve})});
  const rpc=createVoiceService((channel,endpoint,payload)=>host.call(endpoint,payload));
  const rec={onText(){},onError(){},onEnd(){},async start(){starts++},async stop(){}};
  const runtime=new VoiceRuntime({}, {engine:'native'}, {rpc,createRecognizer:()=>rec,submit:()=>assert.fail('no auto-send')});
  await rpc.fetchConfig();assert.equal(loads,0);
  const click=runtime.toggleMic('test');await Promise.resolve();
  assert.equal(loads,1);assert.equal(starts,0);assert.equal(runtime.isStarting(),true);
  ready({});await click;assert.equal(starts,1);assert.equal(runtime.isStarting(),false);
  await runtime.stopMic('test');host.dispose();
});
