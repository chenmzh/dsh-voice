/**
 * 停止朗读必须真的停住。
 *
 * 用户的原话:"当前停止语音服务,为什么我点了小喇叭以后,过了一段时间还是会
 * 继续读?没法完全停止?"
 *
 * 根因在客户端的合成循环里:循环是「取一句 → await 合成 → 入队播放」,
 * 而 `stop()` 只做了两件事 —— 自增 speechGeneration、清空播放队列。**它没有
 * 取消那句正在 await 的合成请求**。于是时序变成:
 *
 *   1. 用户在「第 N 句正在合成」时点小喇叭 → stop():队列清空,generation+1;
 *   2. 那句合成的 RPC 稍后才返回(模型加载时可能几十秒,这正是用户说的
 *      "过了一段时间");
 *   3. 循环里 `if (result.wav)` 分支**没有 generation 检查**,照常
 *      `audio.enqueue(...)`;
 *   4. AudioQueue.stop() 把 playing 置成 false,于是这次 enqueue 又触发
 *      drain() —— 停了之后又自己响起来。
 *
 * 这个文件里的用例把这条时序钉住:stop() 之后,任何在途合成的结果都不许入队。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { TtsController } = await import('../lib/client/tts-store.js');

/** 一个 4 字节的合法 base64,足够 wavBlob 解析。 */
const FAKE_WAV = 'AAAAAA==';

/** 记录每一次入队的假播放队列 —— 真 AudioQueue 依赖浏览器 Audio,node 里起不来。 */
function fakeAudio() {
    return {
        played: [],
        stopped: 0,
        enqueue(blob) { this.played.push(blob); },
        stop() { this.stopped++; this.played.length = 0; },
        unlock() { },
        dispose() { },
        subscribe() { return () => { }; },
        isSpeaking() { return false; },
    };
}

/**
 * 造一个 controller,让第 1 句的合成被我们用手动 gate 卡住,
 * 这样就能精确制造"用户在某句合成途中点了停止"的时序。
 */
async function makeGated({ segments = ['第一句。', '第二句。', '第三句。'] } = {}) {
    let open;
    const gate = new Promise(resolve => { open = resolve; });
    let gatedText = segments[0];
    const rpc = async (_channel, endpoint, payload) => {
        if (endpoint === 'segments')
            return { ok: true, value: { segments } };
        if (endpoint === 'speak') {
            if (payload.text === gatedText)
                await gate;
            return { ok: true, value: { wav: FAKE_WAV, mime: 'audio/wav', engine: 'kokoro' } };
        }
        return { ok: true, value: { active: 'kokoro', state: 'ready', engine: 'kokoro', voices: [], vramUsedMb: 1 } };
    };
    const ctl = new TtsController({ rpc, sessions: {} });
    ctl.audio = fakeAudio();
    return { ctl, open, segments };
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

test('停止朗读:在途合成的那一句不许再入队播放(用户听到的"停了又自己读")', async () => {
    const { ctl, open } = await makeGated();
    const running = ctl.speakText('第一句。第二句。第三句。', { engine: 'kokoro' });
    await tick();                       // 让循环走到第 1 句的 await 合成上
    assert.equal(ctl.getSnapshot().busy, true, '此时应当处于朗读中');
    ctl.stop();                         // ← 用户点小喇叭
    assert.equal(ctl.getSnapshot().busy, false);
    open();                             // 那句合成现在才返回
    await running;
    assert.equal(ctl.audio.played.length, 0,
        '停止之后合成完的音频不得入队 —— 入队会重新触发 drain,表现成"停了又继续读"');
    assert.equal(ctl.getSnapshot().speaking, false, '停止后 speaking 不能被在途结果改回 true');
    assert.equal(ctl.getSnapshot().note, '已停止', '提示文字不能被"正在朗读第 N 句"覆盖');
    ctl.dispose();
});

test('停止朗读:模型加载那种几十秒的合成也一样不许"迟到播放"', async () => {
    // 第一句就是那句要加载模型的合成 —— 用户点停止往往正是在这个窗口里。
    const { ctl, open } = await makeGated();
    const running = ctl.speakText('第一句。第二句。第三句。', { engine: 'cosyvoice3' });
    await tick();
    ctl.stop();
    await tick(120);                    // 模拟"过了一段时间"
    open();
    await running;
    assert.equal(ctl.audio.played.length, 0, '迟到的第一句也不能响');
    assert.equal(ctl.getSnapshot().speaking, false);
    ctl.dispose();
});

test('停止朗读:已经入队的后续句子必须被清掉,不会接着读完', async () => {
    // 不 gate:让它尽量快地把第 1 句排进队列,再点停止 —— 队列里不许有残留。
    const { ctl, open } = await makeGated();
    const running = ctl.speakText('第一句。第二句。第三句。', { engine: 'kokoro' });
    await tick(10);
    ctl.stop();
    assert.equal(ctl.audio.played.length, 0, 'stop() 之后队列里不允许还留着待播的句子');
    assert.ok(ctl.audio.stopped >= 1, 'stop() 必须真的调用播放队列的 stop');
    open();                             // 放掉那句在途合成,收尾
    await running;
    assert.equal(ctl.audio.played.length, 0, '迟到的结果回填后队列仍必须是空的');
    ctl.dispose();
});

test('停止之后重新朗读:新的一轮必须能正常播(不能把 generation 用坏)', async () => {
    const { ctl, open } = await makeGated();
    const first = ctl.speakText('第一句。第二句。第三句。', { engine: 'kokoro' });
    await tick();
    ctl.stop();
    open();
    await first;
    assert.equal(ctl.audio.played.length, 0, '第一轮被停止后不应留下任何播放');

    // 第二轮:换成不再卡住的 service,应当正常入队两句。
    const svc = ctl.service;
    ctl.service = {
        ...svc,
        segments: async () => ({ segments: ['甲。', '乙。'] }),
        speak: async () => ({ wav: FAKE_WAV, mime: 'audio/wav', engine: 'kokoro' }),
    };
    await ctl.speakText('甲。乙。', { engine: 'kokoro' });
    assert.equal(ctl.audio.played.length, 2, '新的一轮朗读必须照常入队两句');
    assert.equal(ctl.getSnapshot().note, '朗读完成');
    ctl.dispose();
});
