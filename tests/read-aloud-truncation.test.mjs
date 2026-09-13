/** Regression tests for preprocessing, quotation boundaries and partial synthesis failures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREP_PYTHON, hasSpeakable, fallbackSegments, prepareSegments } from '../lib/core/text-prep.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, '..', 'python', 'tts_worker.py');
/** 唯一能 import numpy 的解释器;缺了就跳过"真起 worker"那条,不至于红别人的机器。 */
const PREP_PYTHON = process.env.DSH_VOICE_TEST_PYTHON || '';

/** 触发缺陷的那段原文(右引号紧跟在 `。` 之后,正是被切碎的位置)。 */
const STORY = [
    '**《小猫的纸盒屋》**',
    '',
    '小猫小猫最怕下雨。一天雨来了，他躲进大纸盒下，发现朋友也在里面。小猫把纸盒往他们那边推了推。',
    '',
    '雨停后，大家送他一朵野花。小猫笑了：“原来雨天的纸盒，是大家的屋子。”',
    '',
    '从那以后，小猫不再怕下雨了。',
    '',
    '（约 100 字 🐷）',
].join('\n');

// ---------------------------------------------------------------------------
// 第 1 层:空串配置不能让 textnorm 静默消失
// ---------------------------------------------------------------------------
test('ttsTextnormPath 的空串默认值不能再把 textnorm 关掉(它会让每次朗读都降级)', async () => {
    // 这正是宿主传下来的值:schema 默认 ''。以前 `'' ?? DEFAULT_TEXTNORM` 保留空串,
    // args 里出现一个空文件名,python 起不来 -> degraded。
    const result = await prepareSegments(STORY, { engine: 'cosyvoice', textnormPath: '' });
    assert.equal(result.degraded, false, 'textnorm 必须真的跑起来,而不是降级');
    assert.ok(!result.normalized.includes('**'), 'Markdown 加粗必须被剥掉');
    assert.ok(result.normalized.includes('一百'), '数字必须按引擎展开(100 -> 一百)');
});

test('纯空白的 textnormPath / python 同样回落到默认值', async () => {
    const result = await prepareSegments(STORY, { engine: 'kokoro', textnormPath: '   ', python: '  ' });
    assert.equal(result.degraded, false);
    assert.deepEqual(fallbackSegments('甲。乙。'), ['甲。', '乙。']);
    assert.equal(DEFAULT_PREP_PYTHON, 'python3');
});

test('切句结果的每一句都必须有可读内容,右引号必须跟着句子走', async () => {
    const result = await prepareSegments(STORY, { engine: 'cosyvoice', textnormPath: '' });
    assert.equal(result.degraded, false);
    // 真机就是在这里出现了一个孤零零的 `”`。
    assert.ok(!result.segments.includes('”'), `右引号不能自己成句: ${JSON.stringify(result.segments)}`);
    assert.ok(result.segments.some(s => s.includes('是大家的屋子。”')), '引号要跟句子合在一起');
    assert.ok(result.segments.some(s => s.includes('从那以后')), '结尾两句必须留着');
    for (const segment of result.segments)
        assert.ok(hasSpeakable(segment), `这一段没有可读内容: ${JSON.stringify(segment)}`);
});

// ---------------------------------------------------------------------------
// 第 2 层:兜底切句自己也不能产出纯标点片段
// ---------------------------------------------------------------------------
test('hasSpeakable 只认字母/数字/汉字,表情和标点不算', () => {
    assert.equal(hasSpeakable('你好'), true);
    assert.equal(hasSpeakable('abc 123'), true);
    assert.equal(hasSpeakable('”'), false);
    assert.equal(hasSpeakable('。！？…），'), false);
    assert.equal(hasSpeakable('🐷'), false);
    assert.equal(hasSpeakable(''), false);
    assert.equal(hasSpeakable(undefined), false);
});

test('fallbackSegments 把落单的右引号并回它所属的句子', () => {
    assert.deepEqual(fallbackSegments('小猫笑了：“原来雨天的纸盒，是大家的屋子。”'),
        ['小猫笑了：“原来雨天的纸盒，是大家的屋子。”']);
    // 引号在段落开头时(上一句不在这段里)要并到下一句,而不是自己成段。
    assert.deepEqual(fallbackSegments('”后面的句子。'), ['”后面的句子。']);
});

test('fallbackSegments 在整段都不可读时原样返回,交给上层当 skipped', () => {
    assert.deepEqual(fallbackSegments('”'), ['”']);
    assert.deepEqual(fallbackSegments('。。。'), ['。。。']);
});

// ---------------------------------------------------------------------------
// 第 3 层:单句失败不能中断整段朗读(客户端)
// ---------------------------------------------------------------------------
const { TtsController } = await import('../lib/client/tts-store.js');

/**
 * 假 RPC:segments 回给定的句子;speak 按 `failFor(text)` 回**失败信封**,
 * 让 createTtsService 的 decode 真的抛 VoiceRpcError(与真 host 同形状)。
 */
function makeRpc({ segments, failFor = () => false, status = {} }) {
    const calls = { speak: [], enqueued: [] };
    const rpc = async (_channel, endpoint, payload) => {
        if (endpoint === 'segments')
            return { ok: true, value: { segments, engine: 'cosyvoice', degraded: false } };
        if (endpoint === 'status')
            return { ok: true, value: { active: 'cosyvoice', state: 'ready', engine: 'cosyvoice', voice: '', voices: [], vramUsedMb: 3000, ...status } };
        if (endpoint === 'speak') {
            calls.speak.push(payload.text);
            if (failFor(payload.text))
                return { ok: false, error: { code: 'runtime', message: 'RuntimeError: cosyvoice produced no audio chunks' } };
            return { ok: true, value: { wav: 'AAAA', mime: 'audio/wav', engine: 'cosyvoice' } };
        }
        return { ok: true, value: {} };
    };
    return { rpc, calls };
}

function makeController(options) {
    const { rpc, calls } = makeRpc(options);
    const ctl = new TtsController({ rpc, sessions: {} });
    // 播放交给桩:node 里没有 <audio>。
    const enqueued = [];
    ctl.audio = { stop() {}, unlock() {}, enqueue(blob) { enqueued.push(blob); }, dispose() {} };
    return { ctl, calls, enqueued };
}

test('中间有一句合成失败,后面的句子照样要读(不能读到一半就停)', async () => {
    const segments = ['第一句。', '第二句。', '第三句。'];
    // 第二句永远失败(重试也不成),前后两句正常 —— 正是真机 `”` 那一句的形态。
    const { ctl, enqueued, calls } = makeController({ segments, failFor: text => text === '第二句。' });
    await ctl.speakText(segments.join(''), { engine: 'cosyvoice' });
    const snap = ctl.getSnapshot();
    assert.equal(enqueued.length, 2, '第一句和第三句都必须入队播放');
    assert.equal(calls.speak.filter(t => t === '第三句。').length, 1, '第三句不能因为第二句失败而被跳过');
    assert.ok(/第 2 句/.test(snap.note), `必须告诉用户哪一句被跳过: ${snap.note}`);
    assert.equal(snap.busy, false);
    ctl.dispose?.();
});

test('一句偶发失败会重试一次,救回来就不算失败', async () => {
    const segments = ['第一句。'];
    let seen = 0;
    const { ctl, enqueued, calls } = makeController({
        segments,
        failFor: () => (++seen === 1),   // 只有第一次调用失败
    });
    await ctl.speakText('第一句。', { engine: 'cosyvoice' });
    assert.equal(calls.speak.length, 2, '应该重试一次');
    assert.equal(enqueued.length, 1, '重试成功后要正常播放');
    assert.equal(ctl.getSnapshot().note, '朗读完成');
    ctl.dispose?.();
});

test('每一句都失败时必须报错,而不是安静地什么都不放', async () => {
    const { ctl, enqueued } = makeController({ segments: ['甲。', '乙。'], failFor: () => true });
    await ctl.speakText('甲。乙。', { engine: 'cosyvoice' });
    const snap = ctl.getSnapshot();
    assert.equal(enqueued.length, 0);
    assert.ok(/合成失败/.test(snap.error ?? ''), `必须给出错误: ${snap.error}`);
    assert.equal(snap.busy, false);
    ctl.dispose?.();
});

// ---------------------------------------------------------------------------
// 第 4 层:worker 对纯标点片段直接回 skipped,连模型都不加载
// ---------------------------------------------------------------------------
test('worker 对纯标点文本回 skipped,而且不触发模型加载', async t => {
    if (!existsSync(PREP_PYTHON)) {
        t.skip(`缺少 ${PREP_PYTHON}`);
        return;
    }
    // --autoload 0:不预先加载,请求循环直接可用。此时引擎模块(kokoro/numpy)
    // 根本没被 import,所以这条测试能证明"纯标点不会惊动模型"。
    const stdout = await new Promise((resolve, reject) => {
        const child = execFile(PREP_PYTHON, [WORKER, '--engine', 'kokoro', '--autoload', '0'],
            { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
            (error, out) => (error && !out ? reject(error) : resolve(out)));
        child.stdin.on('error', () => { });
        child.stdin.end([
            JSON.stringify({ id: 1, text: '”' }),
            JSON.stringify({ id: 2, text: '。。。' }),
            JSON.stringify({ id: 3, text: '   ' }),
        ].join('\n') + '\n');
    });
    const lines = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const ready = lines.find(l => l.ready !== undefined);
    assert.equal(ready?.loaded, false, 'autoload 0 下模型不该被加载');
    // 纯标点与纯空白都回 skipped,但原因要分开:空白是 empty,标点是 no speakable text。
    const expected = { 1: 'no speakable text', 2: 'no speakable text', 3: 'empty' };
    for (const id of [1, 2, 3]) {
        const reply = lines.find(l => l.id === id);
        assert.ok(reply, `缺少 id=${id} 的回复`);
        assert.equal(reply.ok, true, `id=${id} 不该是错误: ${JSON.stringify(reply)}`);
        assert.equal(reply.wav, null);
        assert.equal(reply.skipped, expected[id]);
    }
    assert.ok(!lines.some(l => l.ok === false), '纯标点不该产生任何失败回复');
});
