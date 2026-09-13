import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioQueue } from '../lib/client/audio-player.js';
import { TtsController } from '../lib/client/tts-store.js';
import { prepareSegments } from '../lib/core/text-prep.js';
const tick = () => new Promise(r => setImmediate(r));

test('visible selected text preserves table cells, literal tags and URLs', async () => {
    const text = '| 名称 | 内容 |\n| 苹果 | 好吃 |\n<重要> 保留这个词。https://example.org/test';
    const selected = await prepareSegments(text, { engine: 'cosyvoice3', markdown: false });
    assert.equal(selected.degraded, false);
    for (const word of ['苹果', '好吃', '<重要>', 'https://example.org/test']) {
        assert.ok(selected.normalized.includes(word), word);
        assert.ok(selected.segments.join('').includes(word), word);
    }
    const whole = await prepareSegments(text, { engine: 'cosyvoice3' });
    assert.ok(!whole.normalized.includes('苹果'), 'Reproduces whole-reply Markdown table omission');
});

test('playback drains every WAV and old cancellation cannot clear a new audio element', async t => {
    const elements = [];
    class FakeAudio {
        constructor(src) { this.src = src; elements.push(this); }
        play() { return Promise.resolve(); }
        pause() { this.paused = true; }
    }
    const original = globalThis.Audio; globalThis.Audio = FakeAudio;
    t.after(() => { globalThis.Audio = original; });
    const queue = new AudioQueue();
    queue.enqueue(new Blob(['one']));
    queue.enqueue(new Blob(['two']));
    let finished = false;
    const drained = queue.waitUntilIdle().then(() => { finished = true; });
    await tick(); assert.equal(finished, false);
    elements[0].onended(); await tick(); assert.equal(elements.length, 2); assert.equal(finished, false);
    elements[1].onended(); await drained; assert.equal(finished, true);
    queue.enqueue(new Blob(['old']));
    queue.stop();
    queue.enqueue(new Blob(['new']));
    const current = queue.current;
    await tick(); assert.equal(queue.current, current);
    queue.stop(); assert.equal(current.paused, true);
});

test('audio rejection is reported and remaining chunks are not silently played out of order', async t => {
    const original = globalThis.Audio;
    t.after(() => { globalThis.Audio = original; });
    globalThis.Audio = class {
        play() { return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })); }
        pause() {}
    };
    const queue = new AudioQueue();
    queue.enqueue(new Blob(['one'])); queue.enqueue(new Blob(['two']));
    await assert.rejects(queue.waitUntilIdle(), /浏览器拦截/);
    assert.equal(queue.items.length, 0);
    assert.throws(() => queue.enqueue(new Blob(['three'])), /浏览器拦截/);
    queue.stop(); assert.equal(queue.error, null);
});

test('controller keeps stop state until audio ends, and carries selected-text flags through RPC', async () => {
    const calls = []; let finish;
    const ctl = new TtsController({ sessions: {}, rpc: async (_, endpoint, payload) => {
        calls.push({ endpoint, payload });
        return { ok: true, value: endpoint === 'segments' ? { segments: [payload.text] } : endpoint === 'speak' ? { wav: 'AAAA' } : {} };
    } });
    ctl.audio = { stop() {}, unlock() {}, enqueue() {}, dispose() {}, waitUntilIdle: () => new Promise(r => { finish = r; }) };
    const speech = ctl.speakText('<重要>。', { plainText: true, messageId: 'selected' });
    await tick();
    assert.equal(ctl.state.speaking, true); assert.equal(ctl.state.speakingMessageId, 'selected');
    assert.equal(calls.find(c => c.endpoint === 'segments').payload.markdown, false);
    assert.equal(calls.find(c => c.endpoint === 'speak').payload.prepared, true);
    finish(); await speech;
    assert.equal(ctl.state.speaking, false); assert.equal(ctl.state.note, '朗读完成');
    ctl.dispose();
});

test('nonempty skipped synthesis retries and visibly identifies the missing sentence', async () => {
    let attempts = 0;
    const ctl = new TtsController({ sessions: {}, rpc: async (_, endpoint, payload) => ({ ok: true, value:
        endpoint === 'segments' ? { segments: ['漏掉的词。', '后面的句子。'] }
        : endpoint === 'speak' && payload.text === '漏掉的词。' ? (++attempts, { skipped: 'empty' })
        : endpoint === 'speak' ? { wav: 'AAAA' } : {} }) });
    ctl.audio = { stop() {}, unlock() {}, enqueue() {}, dispose() {} };
    await ctl.speakText('漏掉的词。后面的句子。');
    assert.equal(attempts, 2); assert.match(ctl.state.note, /第 1 句/);
    ctl.dispose();
});


test('escaped literal pipes demonstrate why normalized segments must not be parsed twice', async () => {
    const once = await prepareSegments(String.raw`\| 苹果 \| 好吃 \|`, { engine: 'cosyvoice3' });
    assert.ok(once.normalized.includes('苹果'));
    const twice = await prepareSegments(once.normalized, { engine: 'cosyvoice3' });
    assert.equal(twice.normalized, '', 'Second Markdown parse wrongly treats literal text as a table');
});
