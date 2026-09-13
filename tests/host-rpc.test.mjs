/**
 * 宿主半的端到端接线测试:真 apply() → 真 /tts RPC → 真 PythonTts → 桩 worker。
 *
 * 之前 lib/index.js 的朗读分支、python-tts.js 的行协议、以及两者与 worker 的
 * 字段约定都没有被执行过 —— 只有写在文档里的"应该长这样"。这里用一个小 python
 * 桩冒充 worker(讲同一套 JSON 行协议),把这段缝真正跑起来:不需要 GPU,
 * 也不需要 40 秒的模型加载。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { PythonTts } from '../lib/core/python-tts.js';
import { TtsManager } from '../lib/core/tts-manager.js';

/** 桩 worker:ready 握手 + voices/setVoice/stats/unload/speak,全部走 stdout JSON 行。 */
const STUB_WORKER = String.raw`
import json, sys, base64, os

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

engine = "unknown"
voice = ""
for i, arg in enumerate(sys.argv):
    if arg == "--engine" and i + 1 < len(sys.argv):
        engine = sys.argv[i + 1]
    if arg == "--voice" and i + 1 < len(sys.argv):
        voice = sys.argv[i + 1]

# 故意往 stderr 写东西:客户端必须靠 stdout 的 JSON 行解析,不能被日志干扰。
sys.stderr.write("stub worker starting for %s\n" % engine)
sys.stderr.flush()

emit({"ready": True, "engine": engine, "loadSeconds": 0.01, "voice": voice,
      "voices": ["zf_001", "zf_002", "af_heart"]})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    rid = req.get("id")
    cmd = req.get("cmd")
    if cmd == "unload":
        emit({"id": rid, "ok": True})
        # 真 worker 收到 unload 就会退出;桩也照做,才能验证"等进程真的退出"。
        break
    elif cmd == "voices":
        emit({"id": rid, "ok": True, "voices": ["zf_001", "zf_002", "af_heart"], "voice": voice})
    elif cmd == "setVoice":
        voice = req.get("voice") or voice
        emit({"id": rid, "ok": True, "voices": ["zf_001", "zf_002", "af_heart"], "voice": voice})
    elif cmd == "stats":
        emit({"id": rid, "ok": True, "engine": engine, "voice": voice, "loads": 1})
    elif cmd == "prepare":
        text = (req.get("text") or "").strip()
        emit({"id": rid, "ok": True, "engine": engine, "segments": [text] if text else []})
    elif cmd is not None:
        # 与真 worker 一致:合成由"没有 cmd"触发,任何非空未知 cmd 都要被拒。
        # 这条分支的意义就是别把宿主的 cmd:'speak' 一路放过、到真 GPU 上才炸。
        emit({"id": rid, "ok": False, "error": "unknown cmd %r" % cmd})
    else:
        text = req.get("text") or ""
        if text == 'REQUIRE_PREPARED' and req.get('prepared') is not True:
            emit({'id': rid, 'ok': False, 'error': 'prepared flag was lost'})
            continue
        if not text.strip():
            emit({"id": rid, "ok": True, "skipped": "empty", "engine": engine})
        else:
            # 造一段真的 WAV(44 字节 RIFF 头 + 少量静音采样)。
            import struct
            payload = b"\x00\x00" * 64
            header = (b"RIFF" + struct.pack("<I", 36 + len(payload)) + b"WAVEfmt "
                      + struct.pack("<IHHIIHH", 16, 1, 1, 24000, 48000, 2, 16)
                      + b"data" + struct.pack("<I", len(payload)))
            wav = header + payload
            emit({"id": rid, "ok": True, "wav": base64.b64encode(wav).decode(),
                  "sampleRate": 24000, "audioSeconds": 0.01, "synthSeconds": 0.02,
                  "engine": engine, "voice": voice})
`;

function writeStubWorker() {
    const dir = mkdtempSync(path.join(tmpdir(), 'tts-stub-'));
    const file = path.join(dir, 'stub_worker.py');
    writeFileSync(file, STUB_WORKER, 'utf8');
    return file;
}

/** 造一个真正的 TtsManager,但子进程用 python3 跑桩 worker。 */
function makeRealManager(workerPath, events) {
    return new TtsManager(
        { ttsRoot: '/example/runtime/tts', modelsRoot: '/example/models/tts', engine: 'kokoro' },
        message => events.push(`log:${message}`),
        {
            // 真 PythonTts,真 spawn,真行协议 —— 只是指向桩脚本,并且用系统 python3。
            createProc: spec => new PythonTts(
                { ...spec, python: 'python3' },
                message => events.push(`log:${message}`),
                { workerPath, loadTimeoutMs: 30000, speakTimeoutMs: 30000 },
            ),
            // 桩里没有模型目录判断:全部当作已安装。
            exists: () => true,
            queryVram: async () => 11935,
            segment: async (text, options) => ({ engine: options.engine, spell: false, normalized: text, segments: [text], degraded: false }),
        },
    );
}

function makeCtx(ttsManager) {
    let handler;
    let channel;
    const ctx = {
        logger: { warn: () => { }, info: () => { }, error: () => { } },
        effect: fn => { fn(); },
        // 同上:桩里没有 settings provider,插件必须走行内 config 的回退路径。
        inject: () => ({}),
        connection: {
            rpc: {
                handle: (name, fn) => {
                    channel = name;
                    handler = fn;
                    return () => { };
                },
            },
        },
    };
    apply(ctx, { engine: 'browser', nativeBackend: 'zipformer', hotkey: 'alt+m' }, { ttsManager });
    return { channel, call: (endpoint, payload) => handler(endpoint, payload) };
}

/**
 * 每个用例的统一入口:建真 manager + 真 ctx,并**保证用完把子进程收掉**。
 * 不 dispose 的话桩 worker 会一直活着,Node 的事件循环不退出,整个测试文件挂住。
 */
function setup(t, events = []) {
    const tts = makeRealManager(writeStubWorker(), events);
    t.after(async () => { await tts.dispose(); });
    return { tts, ...makeCtx(tts) };
}

test('the host registers a /tts channel alongside /voice', (t) => {
    const { channel } = setup(t);
    // 后注册的是 /tts(voice 先注册)。
    assert.equal(channel, '/tts');
});

test('config reports the engine catalog without spawning anything', async (t) => {
    const events = [];
    const { tts, call } = setup(t, events);
    const res = await call('config', {});
    assert.equal(res.ok, true);
    assert.equal(res.value.engine, 'kokoro');
    assert.equal(res.value.autoRead, true);
    assert.equal(res.value.engines.length, 4);
    assert.deepEqual(res.value.engines.map(e => e.id), ['kokoro', 'cosyvoice', 'cosyvoice3', 'indextts']);
    // 关键:只读配置不该起进程。
    assert.deepEqual(events, []);
    assert.equal(tts.current, null);
});

test('status is answered before any engine is loaded', async (t) => {
    const { tts, call } = setup(t);
    const res = await call('status', {});
    assert.equal(res.ok, true);
    assert.equal(res.value.state, 'idle');
    assert.equal(res.value.active, null);
    assert.equal(res.value.vramUsedMb, 11935);
});

test('speak loads the engine, returns a real WAV and honours the voice list', async (t) => {
    const events = [];
    const { tts, call } = setup(t, events);
    const res = await call('speak', { text: '你好,这是一段测试。' });
    assert.equal(res.ok, true, `speak 失败: ${JSON.stringify(res)}`);
    assert.equal(res.value.engine, 'kokoro');
    assert.equal(res.value.mime, 'audio/wav');
    assert.equal(res.value.sampleRate, 24000);
    // base64 解回来必须是真的 WAV:RIFF....WAVE
    const wav = Buffer.from(res.value.wav, 'base64');
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.ok(wav.length > 44, 'WAV 只有头部,没有采样数据');
    // ready 握手里的音色列表应该被记下来。
    assert.deepEqual(tts.voices, ['zf_001', 'zf_002', 'af_heart']);
});

test('voices and setVoice round-trip through the worker protocol', async (t) => {
    const { tts, call } = setup(t);
    const list = await call('voices', {});
    assert.equal(list.ok, true);
    assert.deepEqual(list.value.voices, ['zf_001', 'zf_002', 'af_heart']);
    const changed = await call('setVoice', { voice: 'zf_002' });
    assert.equal(changed.ok, true);
    assert.equal(changed.value.voice, 'zf_002');
    assert.equal((await call('speak', { text: '切换音色之后。' })).value.voice, 'zf_002');
});

test('switching engines through the RPC unloads the previous process first', async (t) => {
    const events = [];
    const { tts, call } = setup(t, events);
    await call('speak', { text: '先用 kokoro。' });
    assert.equal(tts.current.id, 'kokoro');
    const first = tts.current.proc;
    const selected = await call('select', { engine: 'indextts' });
    assert.equal(selected.ok, true);
    assert.equal(selected.value.state, 'loading');
    await tts.waitReady();
    assert.equal(tts.current.id, 'indextts');
    // 旧进程必须真的死了(exitCode 不为 null 才算退出)。
    assert.notEqual(first, tts.current.proc);
    assert.equal(first.alive(), false, '旧引擎进程还活着,显存没有释放');
    // 而且状态里能看到"先卸载后加载"这件事。
    assert.match(tts.lastEvent, /已加载 IndexTTS/);
});

test('unload via RPC frees the engine and leaves nothing resident', async (t) => {
    const { tts, call } = setup(t);
    await call('speak', { text: '先加载。' });
    assert.ok(tts.current);
    const res = await call('unload', {});
    assert.equal(res.ok, true);
    assert.equal(res.value.active, null);
    assert.equal(tts.current, null);
    assert.match(res.value.lastEvent, /已卸载/);
});

test('an unknown engine is rejected with an error envelope, not a crash', async (t) => {
    const { tts, call } = setup(t);
    const res = await call('select', { engine: 'gpt-4o-audio' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'bad_engine');
    const unknown = await call('nonsense', {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, 'unknown_endpoint');
});

test('a worker that dies mid-request surfaces as a tts_failed envelope', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tts-stub-die-'));
    const file = path.join(dir, 'die_worker.py');
    // ready 之后立刻退出:请求必然失败,但必须是可读的错误而不是挂死。
    writeFileSync(file, [
        'import json, sys',
        'sys.stdout.write(json.dumps({"ready": True, "engine": "kokoro"}) + "\\n")',
        'sys.stdout.flush()',
        'sys.exit(3)',
    ].join('\n'), 'utf8');
    const tts = makeRealManager(file, []);
    t.after(async () => { await tts.dispose(); });
    const { call } = makeCtx(tts);
    const res = await call('speak', { text: '这句会失败。' });
    assert.equal(res.ok, false, `期望失败,实际: ${JSON.stringify(res)}`);
    assert.equal(res.error.code, 'tts_failed');
});

test('the segments endpoint never loads an engine', async () => {
    let spawned = false;
    const tts = new TtsManager(
        { ttsRoot: '/t', modelsRoot: '/m', engine: 'kokoro' },
        () => { },
        {
            createProc: () => { spawned = true; throw new Error('must not spawn'); },
            exists: () => true,
            queryVram: async () => 11935,
            segment: async (text, options) => ({ engine: options.engine, spell: true, normalized: text, segments: ['甲。', '乙。'], degraded: false }),
        },
    );
    const { call } = makeCtx(tts);
    const res = await call('segments', { text: '甲。乙。', engine: 'indextts' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.value.segments, ['甲。', '乙。']);
    // 用请求里指定的引擎决定数字规则,而不是当前 selection。
    assert.equal(res.value.engine, 'indextts');
    assert.equal(res.value.spell, true);
    assert.equal(spawned, false);
});


test('selected text flags survive host RPC, manager and Python line protocol', async t => {
    const { call } = setup(t);
    const segments = await call('segments', { text: '<重要> 苹果', markdown: false });
    assert.equal(segments.ok, true);
    assert.ok(segments.value.segments.join('').includes('<重要>'));
    const speech = await call('speak', { text: 'REQUIRE_PREPARED', prepared: true });
    assert.equal(speech.ok, true);
    assert.ok(speech.value.wav);
});
