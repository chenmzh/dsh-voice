/**
 * 锁定"换模型必须先卸载旧的"这条硬规则。
 *
 * 这是用户明确要求的行为,也是最容易在重构里被写反的地方(先加载新的会让
 * 两个模型同时占显存 → 16GB 卡上直接 OOM),所以用事件顺序把它钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtsManager } from '../lib/core/tts-manager.js';

/** 假子进程:只记录"被谁在什么时候调用",不碰真实引擎。 */
function makeDeps(events, { failOn = null, loadDelay = 0, voices = ['v1', 'v2'] } = {}) {
  const procs = [];
  const createProc = spec => {
    const proc = {
      id: spec.id,
      ready: false,
      info: undefined,
      async start() {
        events.push(`start:${spec.id}`);
        if (loadDelay)
          await new Promise(r => setTimeout(r, loadDelay));
        if (failOn === spec.id) {
          proc.failed = true;
          throw new Error('CUDA out of memory');
        }
        proc.ready = true;
        proc.info = { ready: true, engine: spec.id, loadSeconds: 1 };
        return proc;
      },
      async unload() {
        events.push(`unload:${spec.id}`);
        proc.ready = false;
      },
      async voices() { return { voices, voice: spec.defaultVoice }; },
      async setVoice(voice) { return { voices, voice }; },
      async speak({ text }) { return { wav: Buffer.from(text), sampleRate: 24000, audioSeconds: 1, voice: 'x' }; },
      async stats() { return { engine: spec.id, voices }; },
      dispose() { events.push(`dispose:${spec.id}`); },
    };
    procs.push(proc);
    return proc;
  };
  let vram = 5000;
  return { deps: { createProc, exists: () => true, queryVram: async () => vram }, procs, setVram: v => { vram = v; } };
}

const opts = { ttsRoot: '/t', modelsRoot: '/m', engine: 'kokoro' };

test('selecting another engine unloads the old process before starting the new one', async () => {
  const events = [];
  const { deps } = makeDeps(events);
  const mgr = new TtsManager(opts, () => {}, deps);
  await mgr.ensureReady();
  assert.equal(mgr.current.id, 'kokoro');
  events.length = 0;
  await mgr.select('indextts');
  await mgr.waitReady();
  // 顺序断言:unload 必须严格早于 start。
  assert.deepEqual(events, ['unload:kokoro', 'start:indextts']);
  assert.equal(mgr.current.id, 'indextts');
  assert.equal(mgr.state, 'ready');
  assert.ok(!events.some((e, i) => e.startsWith('start:') && events.slice(0, i).includes('unload:kokoro') === false),
    'start 出现在了 unload 之前');
});

test('never two engines resident at once, even under rapid switching', async () => {
  const events = [];
  const { deps, procs } = makeDeps(events, { loadDelay: 5 });
  const mgr = new TtsManager(opts, () => {}, deps);
  // 连续点四个引擎:最后一次点击必须生效,中间态不能留下两个就绪进程。
  await mgr.select('kokoro');
  await mgr.select('cosyvoice');
  await mgr.select('cosyvoice3');
  await mgr.select('indextts');
  await mgr.waitReady();
  await mgr.queue;
  assert.equal(mgr.current.id, 'indextts');
  assert.equal(mgr.current.proc.ready, true);
  const readyProcs = procs.filter(p => p.ready);
  assert.equal(readyProcs.length, 1, `同时就绪的进程数应为 1,实际 ${readyProcs.length}`);
  assert.equal(procs[0].ready, false);
});

test('reselecting the already-loaded engine does not reload it', async () => {
  const events = [];
  const { deps } = makeDeps(events);
  const mgr = new TtsManager(opts, () => {}, deps);
  await mgr.ensureReady();
  events.length = 0;
  await mgr.select('kokoro');
  await mgr.queue;
  assert.deepEqual(events, [], '同一个引擎不该重新加载');
  assert.equal(mgr.current.id, 'kokoro');
});

test('status is a non-blocking snapshot while a slow engine loads', async () => {
  const events = [];
  const { deps } = makeDeps(events, { loadDelay: 40 });
  const mgr = new TtsManager(opts, () => {}, deps);
  void mgr.select('indextts');
  const snapshot = await mgr.status();
  // 加载还没结束,status 必须立刻返回并如实报告 loading。
  assert.equal(snapshot.state, 'loading');
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.desired, 'indextts');
  await mgr.waitReady();
  assert.equal((await mgr.status()).state, 'ready');
});

test('unload frees the engine and reports the vram delta', async () => {
  const events = [];
  const { deps, setVram } = makeDeps(events);
  const mgr = new TtsManager(opts, () => {}, deps);
  await mgr.ensureReady();
  setVram(6200);
  await mgr.unload();
  assert.equal(mgr.current, null);
  assert.equal(mgr.state, 'idle');
  // 卸载前后各读一次显存,并在 lastEvent 里体现出来。
  const after = await mgr.status();
  assert.equal(after.active, null);
  assert.match(mgr.lastEvent, /已卸载/);
});

test('a failed load surfaces the cause and leaves nothing resident', async () => {
  const events = [];
  const { deps } = makeDeps(events, { failOn: 'indextts' });
  const mgr = new TtsManager(opts, () => {}, deps);
  await mgr.ensureReady();
  await mgr.select('indextts');
  await mgr.queue;
  assert.equal(mgr.state, 'error');
  assert.equal(mgr.current, null);
  assert.match(mgr.error, /CUDA out of memory/);
  // 关键:老引擎已经被卸掉了,失败不能悄悄退回旧引擎假装没事。
  assert.ok(events.includes('unload:kokoro'));
  await assert.rejects(() => mgr.ensureReady(), /CUDA out of memory/);
});

test('an unknown engine id is rejected instead of silently ignored', async () => {
  const { deps } = makeDeps([]);
  const mgr = new TtsManager(opts, () => {}, deps);
  await assert.rejects(() => mgr.select('not-an-engine'), /未知 TTS 引擎/);
});

test('speak routes through the resident engine and returns wav bytes', async () => {
  const events = [];
  const { deps } = makeDeps(events);
  const mgr = new TtsManager(opts, () => {}, deps);
  const out = await mgr.speak({ text: '你好' });
  assert.equal(out.engine, 'kokoro');
  assert.ok(Buffer.isBuffer(out.wav));
  assert.equal(out.wav.toString(), '你好');
  assert.equal(out.sampleRate, 24000);
});

test('speak with an explicit engine switches first, then synthesizes', async () => {
  const events = [];
  const { deps } = makeDeps(events);
  const mgr = new TtsManager(opts, () => {}, deps);
  await mgr.ensureReady();
  events.length = 0;
  const out = await mgr.speak({ text: 'abc', engine: 'indextts' });
  assert.equal(out.engine, 'indextts');
  assert.deepEqual(events.slice(0, 2), ['unload:kokoro', 'start:indextts']);
});

test('empty text is rejected before any engine work happens', async () => {
  const events = [];
  const { deps } = makeDeps(events);
  const mgr = new TtsManager(opts, () => {}, deps);
  await assert.rejects(() => mgr.speak({ text: '   \n ' }), /没有可朗读的文本/);
  assert.deepEqual(events, [], '空文本不该拉起任何引擎');
});

test('dispose unloads the resident engine so vram is released on shutdown', async () => {
  const events = [];
  const { deps } = makeDeps(events);
  const mgr = new TtsManager(opts, () => {}, deps);
  await mgr.ensureReady();
  events.length = 0;
  await mgr.dispose();
  assert.deepEqual(events, ['unload:kokoro', 'dispose:kokoro']);
});

test('catalog marks engines whose venv or model files are missing', async () => {
  const { deps } = makeDeps([]);
  const mgr = new TtsManager(opts, () => {}, { ...deps, exists: p => !p.includes('indextts') });
  const catalog = mgr.catalog();
  const byId = Object.fromEntries(catalog.map(e => [e.id, e]));
  assert.equal(byId.kokoro.installed, true);
  assert.equal(byId.indextts.installed, false);
  // 目录顺序就是 UI 展示顺序(按推荐度),不是字母序。
  assert.deepEqual(catalog.map(e => e.id), ['kokoro', 'cosyvoice', 'cosyvoice3', 'indextts']);
  // F5-TTS 已按用户要求整条拿掉:注册表、worker、UI 都不该再有它。
  assert.equal(byId.f5tts, undefined, 'F5-TTS 必须从引擎表里消失');
  assert.equal(byId.indextts.commercial, true);
});

// ---------------------------------------------------------------------------
// 真机缺陷回归:音色目录被 setVoice 清空。
//
// 真 worker 的 setVoice 只回 {"voice": ...},**不回 voices**。旧代码在
// python-tts.js 里用 `voices: msg.voices ?? []` 兜底,[] 不是 nullish,于是
// tts-manager 的 `info.voices ?? this.voices` 真的把目录清成了 [] —— 下一次
// /tts/status 轮询把客户端的选择器打回占位,用户刚配的人声就"丢了"。
// 这个测试用的假子进程**故意不回 voices**,更接近真 worker。
// ---------------------------------------------------------------------------
function makeSilentSetVoiceDeps(voices) {
  const events = [];
  const createProc = spec => ({
    id: spec.id,
    ready: false,
    async start() { this.ready = true; return { ready: true, engine: spec.id }; },
    async unload() { this.ready = false; },
    async voices() { return { voices, voice: spec.defaultVoice }; },
    // 只回 voice —— 与 python/tts_worker.py 的 setVoice 分支完全一致。
    async setVoice(voice) { return { voice }; },
    async speak() { return { wav: Buffer.from('x'), sampleRate: 24000, audioSeconds: 1, voice: 'x' }; },
    async stats() { return { engine: spec.id, voices }; },
    dispose() {},
  });
  return { deps: { createProc, exists: () => true, queryVram: async () => 1000 }, events };
}

const KOKORO_LIKE = { zh: ['zf_001', 'zf_002'], en: ['af_heart'] };

test('setVoice 不回声列表时,已缓存的音色目录必须保留(真 worker 就是这个形态)', async () => {
  const { deps } = makeSilentSetVoiceDeps(KOKORO_LIKE);
  const mgr = new TtsManager(opts, () => {}, deps);
  await mgr.listVoices();
  assert.deepEqual(mgr.voices, KOKORO_LIKE, '载入音色应当缓存分组对象');
  const out = await mgr.setVoice('zh=zf_002,en=af_heart');
  assert.equal(out.voice, 'zh=zf_002,en=af_heart');
  assert.deepEqual(out.voices, KOKORO_LIKE, 'setVoice 之后目录不能变空');
  const status = await mgr.status();
  assert.deepEqual(status.voices, KOKORO_LIKE, 'status 轮询也必须仍带完整目录');
});

test('子进程回 voices:[] 时也不许清空目录(旧 python-tts 正是回空数组)', async () => {
  // 复刻缺陷:老代码 `info.voices ?? this.voices` 遇到 [] 会照单全收(因为 [] 不是
  // nullish),于是目录真的变空。这条断言在修好之前必然失败。
  const { deps } = makeSilentSetVoiceDeps(KOKORO_LIKE);
  const createProc = deps.createProc;
  deps.createProc = spec => {
    const proc = createProc(spec);
    proc.setVoice = async voice => ({ voices: [], voice });
    return proc;
  };
  const mgr = new TtsManager(opts, () => {}, deps);
  await mgr.listVoices();
  await mgr.setVoice('zh=zf_002,en=af_heart');
  assert.deepEqual(await mgr.status().then(s => s.voices), KOKORO_LIKE);
});

test('说话时按消息带的 voice 也不能把目录清掉', async () => {
  const { deps } = makeSilentSetVoiceDeps(KOKORO_LIKE);
  const mgr = new TtsManager(opts, () => {}, deps);
  await mgr.listVoices();
  await mgr.speak({ text: '你好', voice: 'zh=zf_001,en=af_heart' });
  assert.deepEqual(mgr.voices, KOKORO_LIKE);
});

test('hasVoices 只认"真的有音色"的载荷', async () => {
  const { hasVoices } = await import('../lib/core/tts-manager.js');
  assert.equal(hasVoices(['a']), true);
  assert.equal(hasVoices(KOKORO_LIKE), true);
  // 以下都算"没带列表":空数组正是旧代码把目录清掉的元凶。
  for (const raw of [undefined, null, '', [], {}, { zh: [] }, { zh: 'nope' }, 0, false])
    assert.equal(hasVoices(raw), false, `${JSON.stringify(raw)} 不该算带列表`);
});

test('python-tts 不再伪造 voices:[] —— 缺列表就回 undefined', async () => {
  const { PythonTts } = await import('../lib/core/python-tts.js');
  // 绕开构造函数(会去 spawn python),只测 setVoice 的封装层。
  const proc = Object.create(PythonTts.prototype);
  proc.request = async req => (req.cmd === 'setVoice' ? { id: 1, ok: true, voice: 'zf_002' } : { id: 1, ok: true, voices: ['a'], voice: '' });
  const out = await proc.setVoice('zf_002');
  assert.equal(out.voice, 'zf_002');
  assert.equal(out.voices, undefined, 'msg 里没有 voices 就必须留 undefined,让上层保留旧目录');
  assert.deepEqual(await proc.voices(), { voices: ['a'], voice: '' });
});
