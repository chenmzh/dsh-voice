/**
 * 音色目录形状的回归测试。
 *
 * 背景(真机发现的缺陷):`/tts/voices` 对不同引擎回**不同形状** —— 多数引擎回
 * 名字数组,而 Kokoro(默认引擎!)是双语模型,回 ``{zh:[...], en:[...]}``。
 * 渲染层直接 ``voices.map(...)``,拿到对象就抛
 * ``TypeError: voices.map is not a function``,而槽位渲染异常会被 DSH 整块摘掉:
 * 用户点一次「载入音色」,整个朗读按钮就从输入框消失了。
 *
 * 桩测试当时没抓到,因为桩按数组回。这里直接对 normalizeVoices 断言两种形状,
 * 并明确要求"任何未知形状都退化成空列表,而不是让调用方拿到非数组"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const storePath = path.join(here, '..', 'lib', 'client', 'tts-store.js');

/**
 * tts-store.js 顶层会 import 客户端运行时,单独 import 会拉起一堆浏览器依赖。
 * 这里只把 normalizeVoices 的定义抠出来求值 —— 函数体不依赖任何 import。
 */
function loadNormalizeVoices() {
    const source = readFileSync(storePath, 'utf8');
    const start = source.indexOf('export function normalizeVoices(');
    assert.notEqual(start, -1, 'normalizeVoices should exist in lib/client/tts-store.js');
    // 从定义处扫到配对的收尾大括号(函数里没有正则字面量,简单计数即可)。
    let depth = 0;
    let index = source.indexOf('{', start);
    const bodyStart = index;
    for (; index < source.length; index++) {
        const ch = source[index];
        if (ch === '{')
            depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0)
                break;
        }
    }
    assert.ok(index > bodyStart, 'normalizeVoices body should be balanced');
    const declaration = source.slice(start, index + 1).replace('export ', '');
    // 用 new Function 在当前 realm 里求值:vm 会给出另一个 realm 的 Array 原型,
    // deepStrictEqual 会因为原型不同而失败。
    const factory = new Function('GROUP_LABELS', `${declaration}\nreturn normalizeVoices;`);
    return factory({ zh: '中文音色', en: '英文音色' });
}

const normalizeVoices = loadNormalizeVoices();

test('a plain name array stays a single unlabelled group', () => {
    const { voices, voiceGroups } = normalizeVoices(['zero_shot_zh', 'cross_lingual_zh']);
    assert.deepEqual(voices, ['zero_shot_zh', 'cross_lingual_zh']);
    assert.equal(voiceGroups.length, 1);
    assert.equal(voiceGroups[0].key, null);
    assert.equal(voiceGroups[0].label, null);
    assert.deepEqual(voiceGroups[0].items, ['zero_shot_zh', 'cross_lingual_zh']);
});

test('Kokoro\'s {zh, en} object becomes two labelled groups', () => {
    const { voices, voiceGroups } = normalizeVoices({ zh: ['zf_001', 'zf_002'], en: ['af_heart'] });
    assert.equal(voiceGroups.length, 2);
    assert.deepEqual(voiceGroups.map(g => g.key), ['zh', 'en']);
    assert.deepEqual(voiceGroups.map(g => g.label), ['中文音色', '英文音色']);
    assert.deepEqual(voiceGroups[0].items, ['zf_001', 'zf_002']);
    assert.deepEqual(voiceGroups[1].items, ['af_heart']);
    // 扁平视图也要拿到全部音色,方便别处按名字查找。
    assert.deepEqual(voices, ['zf_001', 'zf_002', 'af_heart']);
});

test('empty groups are dropped and unknown group keys keep their own name', () => {
    const { voiceGroups } = normalizeVoices({ zh: [], ja: ['jp_1'] });
    assert.deepEqual(voiceGroups.map(g => g.key), ['ja']);
    assert.equal(voiceGroups[0].label, 'ja');
});

test('every non-array shape yields empty arrays, never a non-array', () => {
    // 这正是线上崩溃的形态:调用方拿到的必须是数组,否则 .map 直接抛异常。
    for (const raw of [undefined, null, 'zero_shot_zh', 42, true, { zh: 'not-a-list' }]) {
        const { voices, voiceGroups } = normalizeVoices(raw);
        assert.ok(Array.isArray(voices), `voices must be an array for ${JSON.stringify(raw)}`);
        assert.ok(Array.isArray(voiceGroups), `voiceGroups must be an array for ${JSON.stringify(raw)}`);
        assert.deepEqual(voices, []);
        assert.deepEqual(voiceGroups, []);
    }
});

test('an empty array produces no groups (placeholder select, not a blank group)', () => {
    const { voices, voiceGroups } = normalizeVoices([]);
    assert.deepEqual(voices, []);
    assert.deepEqual(voiceGroups, []);
});

test('non-string entries in a plain array are passed through for optionValue', () => {
    const { voices } = normalizeVoices([{ id: 'voice_04', label: 'Voice 4' }, '', null, 'ref_en']);
    assert.deepEqual(voices, [{ id: 'voice_04', label: 'Voice 4' }, 'ref_en']);
});

// ---------------------------------------------------------------------------
// 第二条真机缺陷:音色目录被 status 轮询清空。
//
// 宿主侧有路径**不带**音色列表(worker 的 setVoice 就只回 voice),而早期代码用
// ``info.voices ?? []`` 兜底 —— [] 不是 nullish,于是「切一次音色」把宿主的音色目录
// 真的清成空数组,下一次 status 轮询就把客户端分组打回单个占位选择框。用户看到的
// 现象是"我刚选的人声没了"。
//
// 这里用真的 TtsController 跑完整时序,因为缺陷正是"两次 RPC 之间的状态残留",
// 只测纯函数抓不到。
// ---------------------------------------------------------------------------
const { TtsController } = await import('../lib/client/tts-store.js');

/** 按 endpoint 回桩数据的假 RPC;信封是 {ok, value}(与真 host 一致)。 */
function makeController(reply) {
    // 注意 rpc 是**函数**而不是 {call}:TtsController 直接把 rpc 交给 createTtsService。
    const rpc = async (_channel, endpoint, payload) => ({ ok: true, value: reply(endpoint, payload) });
    return new TtsController({ rpc, sessions: {} });
}

const KOKORO_VOICES = { zh: ['zf_001', 'zf_002'], en: ['af_heart'] };
const KOKORO_STATUS = { active: 'kokoro', state: 'ready', engine: 'kokoro', voice: '', voices: KOKORO_VOICES };

test('载入音色后,一次不带列表的 status 轮询不会清空分组', async () => {
    const ctl = makeController(endpoint => (endpoint === 'voices'
        ? { voices: KOKORO_VOICES, voice: 'zh=zf_001,en=af_heart', engine: 'kokoro' }
        : { active: 'kokoro', state: 'ready', engine: 'kokoro', voice: 'zh=zf_001,en=af_heart', voices: [] }));
    await ctl.loadVoices('kokoro');
    assert.equal(ctl.getSnapshot().voiceGroups.length, 2, '载入音色应当建出两组');
    await ctl.refreshStatus();
    assert.equal(ctl.getSnapshot().voiceGroups.length, 2, 'status 带回 voices:[] 时不能清空');
    assert.deepEqual(ctl.getSnapshot().voices, ['zf_001', 'zf_002', 'af_heart']);
    ctl.dispose?.();
});

test('setVoice 的回包里没有 voices 字段时,分组必须原样保留', async () => {
    // 这正是真 host 的形态:worker 的 setVoice 只回 voice。
    const ctl = makeController(endpoint => (endpoint === 'voices'
        ? { voices: KOKORO_VOICES, voice: '', engine: 'kokoro' }
        : { voices: [], voice: 'zh=zf_002,en=af_heart', engine: 'kokoro' }));
    await ctl.loadVoices('kokoro');
    await ctl.setVoice('zh=zf_002,en=af_heart');
    const snap = ctl.getSnapshot();
    assert.equal(snap.voice, 'zh=zf_002,en=af_heart');
    assert.equal(snap.voiceGroups.length, 2, '空数组不是"新列表",不能覆盖');
    assert.deepEqual(snap.voiceGroups[0].items, ['zf_001', 'zf_002']);
    ctl.dispose?.();
});

test('换引擎时必须作废旧引擎的分组(分不清两种情况就会留住错的音色名)', async () => {
    const ctl = makeController(() => ({ voices: KOKORO_VOICES, voice: '', engine: 'kokoro' }));
    await ctl.loadVoices('kokoro');
    assert.equal(ctl.getSnapshot().voiceGroups.length, 2);
    // 切到 cosyvoice3:加载中的快照 active=null 且没有列表。
    ctl.applyStatus({ active: null, state: 'loading', voices: [] });
    assert.equal(ctl.getSnapshot().voiceGroups.length, 0, '旧引擎的音色名必须作废');
    ctl.dispose?.();
});

test('卸载后(active=null)分组也清空 —— 没有引擎在显存里就没有音色可选', async () => {
    const ctl = makeController(() => ({ voices: KOKORO_VOICES, voice: '', engine: 'kokoro' }));
    await ctl.loadVoices('kokoro');
    ctl.applyStatus({ active: null, state: 'ready', voices: [] });
    assert.deepEqual(ctl.getSnapshot().voiceGroups, []);
    ctl.dispose?.();
});

// ---------------------------------------------------------------------------
// 第三条真机缺陷:面板的显存数字是陈旧的。
//
// 「载入音色」和「朗读」都会把模型真的装进显存,但它们的响应里没有显存数字。
// 客户端只在 refreshStatus 里更新 vramUsedMb,而 ready 之后根本不轮询 —— 于是
// 面板会一直显示上次读到的旧值。实测出现过同时显示
// 「整卡已用显存:2 MB · 驻留:Kokoro-82M」(真机 nvidia-smi 是 1482 MiB),
// 用户据此以为没占显存,这条要求("换模型/卸载要看得到显存变化")就废了。
// ---------------------------------------------------------------------------
test('载入音色之后显存数字必须是新的(不能停在旧快照)', async () => {
    const ctl = makeController(endpoint => (endpoint === 'voices'
        ? { voices: KOKORO_VOICES, voice: 'zh=zf_001,en=af_heart', engine: 'kokoro' }
        : { active: 'kokoro', state: 'ready', engine: 'kokoro', voice: 'zh=zf_001,en=af_heart', voices: KOKORO_VOICES, vramUsedMb: 1482 }));
    await ctl.loadVoices('kokoro');
    assert.equal(ctl.getSnapshot().vramUsedMb, 1482, '载入后要补一次状态快照');
    assert.equal(ctl.getSnapshot().active, 'kokoro');
    assert.equal(ctl.getSnapshot().voiceGroups.length, 2, '补快照不能顺手把音色分组清掉');
    ctl.dispose?.();
});

test('首次朗读把模型装进显存之后,显存数字同样要刷新', async () => {
    let loaded = false;
    const ctl = makeController(endpoint => {
        if (endpoint === 'segments')
            return { segments: ['第一句。', '第二句。'], engine: 'kokoro' };
        if (endpoint === 'speak') { loaded = true; return { wav: 'AAAA', mime: 'audio/wav', engine: 'kokoro' }; }
        if (endpoint === 'status')
            return { active: loaded ? 'kokoro' : null, state: loaded ? 'ready' : 'idle', engine: 'kokoro', voice: '', voices: loaded ? KOKORO_VOICES : [], vramUsedMb: loaded ? 1472 : 2 };
        return {};
    });
    // 播放交给桩:真的 <audio> 在 node 里不存在。
    ctl.audio = { stop() {}, unlock() {}, enqueue() {}, dispose() {} };
    assert.equal(ctl.getSnapshot().vramUsedMb, null);
    await ctl.speakText('第一句。第二句。', { engine: 'kokoro' });
    const snap = ctl.getSnapshot();
    assert.equal(snap.active, 'kokoro', '朗读把模型装上去了');
    assert.equal(snap.vramUsedMb, 1472, '朗读之后面板必须拿到真实显存,而不是停在 2 MB');
    assert.equal(snap.speaking, false);
    ctl.dispose?.();
});
