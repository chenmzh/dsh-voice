import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createSessionReader } from '../lib/client/session-text.js';
import { TtsController } from '../lib/client/tts-store.js';

// Exercise the event source shipped by the local host, not a guessed append-only feed.
const hostBundle = readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller/client'), 'utf8');
const begin = hostBundle.indexOf('//#region lib/types/client/contract/events.js');
assert.ok(begin >= 0, 'Locate the installed DSH event source contract');
const source = hostBundle.slice(begin, hostBundle.indexOf('//#endregion', begin));
const HostEventSource = new Function('_deepseek_ai_dsh_client_store', `${source}; return MutableSessionEventSource;`)({ notifySubscribers: listeners => { for (const fn of listeners) fn(); } });
const message = (id, seq = 1, text = '一条新的回复。') => ({ type: 'durable', event: { type: 'assistant/message', seq, data: { message: { id, content: [{ type: 'text', text }] } } } });
const sessions = feed => ({ binding: () => ({ eventSource: feed }) });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test('DSH streamed settlement automatically emits the final message exactly once', () => {
    const feed = new HostEventSource(), heard = [];
    const dispose = createSessionReader(sessions(feed)).onAssistantMessage('session', value => heard.push(value));
    feed.append({ type: 'transient', event: { type: 'assistant/message', data: { attemptId: 'attempt', message: { id: 'reply', content: [{ type: 'text', text: '半句' }] } } } });
    assert.equal(heard.length, 0, 'Never speak unfinished transient rows');
    const final = message('reply');
    feed.settleAssistant('attempt', final);
    assert.deepEqual(heard, [{ messageId: 'reply', text: '一条新的回复。' }]);
    feed.append(final);
    feed.settleAssistant('attempt', final);
    assert.equal(heard.length, 1, 'Replay/duplicate settlement must not speak twice');
    dispose();
    feed.append(message('after-disposal'));
    assert.equal(heard.length, 1);
});

test('initial history, backfill and reconnect replacement are silent, including later replay', () => {
    const feed = new HostEventSource(), heard = [];
    feed.replace([message('existing', 2)], true);
    const dispose = createSessionReader(sessions(feed)).onAssistantMessage('session', v => heard.push(v));
    feed.prepend([message('older', 1)], false);
    feed.replace([message('existing', 2), message('reconnected', 3)], false);
    for (const id of ['existing', 'older', 'reconnected']) feed.append(message(id));
    feed.settleAssistant('abandoned');
    assert.deepEqual(heard, []);
    feed.append(message('live', 4));
    assert.equal(heard[0].messageId, 'live');
    dispose();
});

test('settlement starts synthesis without pressing speaker; off/on does not replay skipped replies', async () => {
    const feed = new HostEventSource(), calls = [], played = [];
    const ctl = new TtsController({ sessions: sessions(feed), rpc: async (_channel, endpoint, payload) => {
        calls.push([endpoint, payload]);
        return { ok: true, value: endpoint === 'segments' ? { segments: [payload.text] }
            : endpoint === 'speak' ? { wav: 'AAAA', engine: 'kokoro' } : { state: 'ready', active: 'kokoro' } };
    } });
    ctl.audio = { stop() {}, unlock() {}, enqueue(blob) { played.push(blob); }, dispose() {} };
    ctl.setAutoRead(true); ctl.bindSession('session');
    feed.settleAssistant('first', message('first'));
    assert.equal(ctl.state.speakingMessageId, 'first', 'Auto reading must identify its message so the speaker button can stop it');
    await tick();
    assert.equal(played.length, 1);
    assert.ok(calls.some(([endpoint]) => endpoint === 'speak'));
    ctl.setAutoRead(false); feed.settleAssistant('disabled', message('disabled', 2)); await tick();
    assert.equal(played.length, 1);
    ctl.setAutoRead(true); feed.append(message('disabled', 2)); await tick();
    assert.equal(played.length, 1);
    feed.settleAssistant('next', message('next', 3)); await tick();
    assert.equal(played.length, 2);
    ctl.dispose();
});

test('host auto-read setting overrides a stale browser false and can be toggled repeatedly', async () => {
    let enabled = true;
    const ctl = new TtsController({ sessions: {}, rpc: async (_channel, endpoint) => ({ ok: true, value: endpoint === 'config'
        ? { autoRead: enabled, engine: 'kokoro', engines: [{ id: 'kokoro' }] } : { active: null, state: 'idle' } }) });
    ctl.setAutoRead(false); await ctl.refreshConfig(); assert.equal(ctl.state.autoRead, true);
    enabled = false; await ctl.refreshConfig(); assert.equal(ctl.state.autoRead, false);
    enabled = true; await ctl.refreshConfig(); assert.equal(ctl.state.autoRead, true);
    ctl.dispose();
});


test('successive automatic replies wait for playback, and stop cancels pending replies', async () => {
    const feed = new HostEventSource(), heard = []; let finish;
    const ctl = new TtsController({ sessions: sessions(feed), rpc: async (_, endpoint, payload) => {
        if (endpoint === 'speak') heard.push(payload.text);
        return { ok: true, value: endpoint === 'segments' ? { segments: [payload.text] }
            : endpoint === 'speak' ? { wav: 'AAAA' } : {} };
    } });
    ctl.audio = { stop() { finish?.(); }, unlock() {}, enqueue() {}, dispose() { finish?.(); },
        waitUntilIdle: () => new Promise(r => { finish = r; }) };
    ctl.setAutoRead(true); ctl.bindSession('session');
    feed.append(message('a', 1, '第一段。')); await tick();
    feed.append(message('b', 2, '第二段。')); await tick();
    assert.deepEqual(heard, ['第一段。']);
    assert.equal(ctl.state.speakingMessageId, 'a');
    finish(); await tick(); assert.deepEqual(heard, ['第一段。', '第二段。']);
    feed.append(message('c', 3, '第三段。')); ctl.stop(); await tick();
    assert.deepEqual(heard, ['第一段。', '第二段。']);
    ctl.dispose();
});


test('a new automatic reply waits for a manually selected paragraph', async () => {
    const feed = new HostEventSource(), heard = []; let finish;
    const ctl = new TtsController({ sessions: sessions(feed), rpc: async (_, endpoint, payload) => {
        if (endpoint === 'speak') heard.push(payload.text);
        return { ok: true, value: endpoint === 'segments' ? { segments: [payload.text] }
            : endpoint === 'speak' ? { wav: 'AAAA' } : {} };
    } });
    ctl.audio = { stop() { finish?.(); }, unlock() {}, enqueue() {}, dispose() { finish?.(); },
        waitUntilIdle: () => new Promise(r => { finish = r; }) };
    ctl.setAutoRead(true); ctl.bindSession('session');
    const selected = ctl.speakText('选中的段落。', { plainText: true }); await tick();
    feed.append(message('new', 1, '新的回复。')); await tick();
    assert.deepEqual(heard, ['选中的段落。']);
    finish(); await selected; await tick();
    assert.deepEqual(heard, ['选中的段落。', '新的回复。']);
    ctl.stop(); ctl.dispose();
});
