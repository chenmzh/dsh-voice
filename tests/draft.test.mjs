import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { VoiceRuntime } from '../lib/client/runtime.js';
const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let clientExports;
const jsx=(type,props)=>({type,props});
const sandbox = { console, window: { __ModuleLoader__: { load({id,factory}) {
 assert.equal(id,'@nn12138/dsh-voice');
 clientExports=factory(name=>name==='react/jsx-runtime'?{jsx,jsxs:jsx}:{Button:'button',IconStopFill16:'stop'});
} } } };
vm.runInNewContext(bundle.replace('var VoiceRuntime = class', 'var VoiceRuntime = globalThis.TestRuntime = class')
 .replace('function MicButton(props) {','globalThis.TestMicButton = MicButton; function MicButton(props) {'), sandbox);
assert.equal(typeof clientExports.apply,'function');
assert.equal(clientExports.name,'dsh-voice');
test('browser bundle renders visible loading status and accessible cancel control',()=>{
 const onToggle=()=>{};
 const button=sandbox.TestMicButton({onToggle,useListening:fn=>fn(true),useStarting:fn=>fn(true),
  usePartial:fn=>fn('正在启动语音服务、加载模型，请稍候…'),useHotkey:fn=>fn('Alt+M')});
 assert.equal(button.props['aria-busy'],true);
 assert.match(button.props['aria-label'],/加载模型.*取消/);
 assert.equal(button.props.children.props.role,'status');
 assert.match(button.props.children.props.children,/加载中/);
 assert.equal(button.props.onClick,onToggle);
});
for (const [label, Runtime] of [['module', VoiceRuntime], ['browser bundle', sandbox.TestRuntime]]) {
 function setup({draft='', occurrences=[], phase='plain', accepted=true}={}) {
  const state={draft,occurrences,phase,draftRev:7,imageIds:['image-1']};
  const edits=[],notices=[];
  const input={state:{getSnapshot:()=>state},notify:(...args)=>notices.push(args)};
  const scope={get:()=>({input:{for:s=>{assert.equal(s,scope);return input}},send:()=>assert.fail('Automatic send is forbidden')}),bail:(event,req)=>{assert.equal(event,'slash/input-insert-text');edits.push(req);return accepted?true:undefined}};
  let onText;
  const rec={onText:fn=>{onText=fn},onError:()=>{},onEnd:()=>{},start:async()=>{},stop:async()=>{}};
  const ctx={sessions:{scope:id=>{assert.equal(id,'recorded-session');return scope}}};
  const rpc={ping:async()=>({engine:'native'})};
  const runtime=new Runtime(ctx,{engine:'native'},{createRecognizer:()=>rec,rpc});
  return {runtime,rec,rpc,state,edits,notices,text:(...args)=>onText(...args)};
 }
 test(label+': stopping writes cumulative text once to original session, never sends',async()=>{
  const t=setup({draft:'已有文字'});
  await t.runtime.toggleMic('recorded-session');
  t.text('第一句',true);t.text('第一句第二句',true);t.text('末尾',false);
  // An edit made during recording must be preserved too.
  t.state.draft+='，键入内容';t.state.draftRev++;
  await Promise.all([t.runtime.stopMic('other-session'),t.runtime.stopMic('other-session')]);
  assert.equal(t.edits.length,1);assert.equal(t.edits[0].text,'\n第一句第二句末尾');
  assert.equal(t.edits[0].span.start,t.state.draft.length);assert.equal(t.edits[0].span.draftRev,8);
  assert.deepEqual(t.state.imageIds,['image-1']);
 });
 test(label+': empty draft accepts text without prefix',async()=>{
  const t=setup();await t.runtime.appendDraft('recorded-session','你好');
  assert.equal(t.edits[0].text,'你好');assert.equal(t.edits[0].span.start,0);
 });
 test(label+': references use detect offsets without replacing chips',async()=>{
  const t=setup({draft:'查看 /long-file 然后',occurrences:[{length:10}]});
  await t.runtime.appendDraft('recorded-session','继续');
  assert.equal(t.edits[0].span.start,t.state.draft.length-9);
  assert.equal(t.edits[0].span.end,t.edits[0].span.start);
  assert.equal(t.state.occurrences.length,1);
 });
 test(label+': busy input retains transcript in notice, no insertion or send',async()=>{
  const t=setup({phase:'submitting'});await t.runtime.appendDraft('recorded-session','保留这句话');
  assert.equal(t.edits.length,0);assert.match(t.notices[0][1],/保留这句话/);
 });
 test(label+': rejected revision edit shows recoverable transcript',async()=>{
  const t=setup({accepted:false});await t.runtime.appendDraft('recorded-session','重试文字');
  assert.equal(t.notices[0][0],'error');assert.match(t.notices[0][1],/重试文字/);
 });
 test(label+': final backend failure shows notice and never inserts partial text',async()=>{
  const t=setup();await t.runtime.toggleMic('recorded-session');t.text('未完成',false);
  t.runtime.recognizer.stop=async()=>{throw new Error('GPU unavailable')};
  await t.runtime.stopMic('recorded-session');
  assert.equal(t.edits.length,0);assert.match(t.notices[0][1],/GPU unavailable/);
 });
 for (const [name, expected] of [['NotFoundError',/没有检测到可用麦克风/],['NotAllowedError',/麦克风访问被拒绝/],['NotReadableError',/麦克风无法读取/]]) {
  test(label+': '+name+' is visible and leaves microphone stopped',async()=>{
   const t=setup();const error=new Error('device problem');error.name=name;
   t.rec.start=async()=>{throw error};
   await assert.rejects(t.runtime.toggleMic('recorded-session'),error);
   assert.equal(t.runtime.isListening(),false);
   assert.equal(t.edits.length,0);assert.equal(t.notices.length,1);
   assert.match(t.notices[0][1],expected);
  });
 }
 test(label+': no startup before click; waits for model before capture; every click rechecks',async()=>{
  const t=setup();let pings=0,starts=0,ready;
  t.rpc.ping=()=>{pings++;return new Promise(resolve=>{ready=resolve})};
  t.rec.start=async()=>{starts++};
  assert.equal(pings,0);assert.equal(t.runtime.isStarting(),false);
  const first=t.runtime.toggleMic('recorded-session');
  assert.equal(pings,1);assert.equal(starts,0);assert.equal(t.runtime.isStarting(),true);
  assert.match(t.runtime.getPartial(),/加载模型/);
  ready({engine:'native'});await first;
  assert.equal(starts,1);assert.equal(t.runtime.isStarting(),false);
  await t.runtime.stopMic('recorded-session');
  const second=t.runtime.toggleMic('recorded-session');
  assert.equal(pings,2);ready({engine:'native'});await second;
  await t.runtime.stopMic('recorded-session');assert.equal(t.edits.length,0);
 });
 test(label+': model startup error resets state, preserves reason and allows retry',async()=>{
  const t=setup();let starts=0;
  t.rec.start=async()=>{starts++};
  t.rpc.ping=async()=>{throw new Error('CUDA unavailable')};
  await assert.rejects(t.runtime.toggleMic('recorded-session'),/CUDA unavailable/);
  assert.equal(starts,0);assert.equal(t.runtime.isListening(),false);assert.equal(t.runtime.isStarting(),false);
  assert.equal(t.runtime.activeSession,null);assert.equal(t.edits.length,0);
  assert.match(t.notices[0][1],/CUDA unavailable/);
  t.rpc.ping=async()=>({engine:'native'});
  await t.runtime.toggleMic('recorded-session');assert.equal(starts,1);
  await t.runtime.stopMic('recorded-session');
 });
 for (const fails of [false,true]) test(label+': cancel pending model load ignores late '+(fails?'failure':'success'),async()=>{
  const t=setup();let starts=0,resolve,reject;
  t.rec.start=async()=>{starts++};
  t.rpc.ping=()=>new Promise((ok,fail)=>{resolve=ok;reject=fail});
  const first=t.runtime.toggleMic('recorded-session');
  await t.runtime.toggleMic('recorded-session');
  assert.equal(t.runtime.isListening(),false);assert.equal(t.runtime.isStarting(),false);
  t.rpc.ping=async()=>({engine:'native'});
  await t.runtime.toggleMic('recorded-session');
  if(fails)reject(new Error('old startup failure'));else resolve({engine:'native'});
  await first;
  assert.equal(starts,1);assert.equal(t.runtime.isListening(),true);assert.equal(t.notices.length,0);
  await t.runtime.stopMic('recorded-session');
 });
 test(label+': disposal during model loading never captures or submits later',async()=>{
  const t=setup();let ready,starts=0;
  t.rpc.ping=()=>new Promise(resolve=>{ready=resolve});t.rec.start=async()=>{starts++};
  const pending=t.runtime.toggleMic('recorded-session');t.runtime.dispose();
  ready({engine:'native'});await pending;
  await t.runtime.toggleMic('recorded-session');
  assert.equal(starts,0);assert.equal(t.runtime.isListening(),false);assert.equal(t.edits.length,0);
 });
 test(label+': disposal during finalization discards text and releases capture',async()=>{
  const t=setup();let done,stops=0;
  await t.runtime.toggleMic('recorded-session');t.text('不要插入',true);
  const finish=new Promise(resolve=>{done=resolve});t.rec.stop=()=>{stops++;return finish};
  const stopping=t.runtime.stopMic('recorded-session');t.runtime.dispose();
  done();await stopping;
  assert.ok(stops>0);assert.equal(t.edits.length,0);assert.equal(t.runtime.isListening(),false);
 });
 test(label+': browser mode never asks host to load a model',async()=>{
  const t=setup();t.runtime.setEngine('browser');
  t.rpc.ping=()=>assert.fail('browser must not load local ASR');
  await t.runtime.toggleMic('recorded-session');await t.runtime.stopMic('recorded-session');
 });
 test(label+': empty recording does not edit or send',async()=>{
  const t=setup();await t.runtime.toggleMic('recorded-session');await t.runtime.stopMic('recorded-session');assert.equal(t.edits.length,0);
 });
}
assert.doesNotMatch(bundle,/conversation\.send\(|input\.submit\(/);
