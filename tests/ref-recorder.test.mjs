import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceRecorder, pcmWav, availableRefName } from '../lib/client/ref-recorder.js';
import { VoiceSettingsStore } from '../lib/client/settings-store.js';
import { capturePcm } from '../lib/client/audio.js';

function mic() {
    let push, stops = 0;
    const recorder = new ReferenceRecorder(() => {}, async cb => { push = cb; return { stop() { stops++; } }; });
    return { recorder, push: chunk => push(chunk), stops: () => stops };
}
test('WAV header and signed samples are valid little endian PCM16', () => {
    const wav = Buffer.from(pcmWav([Int16Array.from([-32768, 0]), Int16Array.from([32767])]));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(4), 42);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(40), 6);
    assert.deepEqual([44, 46, 48].map(i => wav.readInt16LE(i)), [-32768, 0, 32767]);
});
test('recording releases capture, rejects short/silent clips, and permits another recording', async () => {
    const m = mic();
    await m.recorder.start(); m.push(new Int16Array(16000).fill(1000)); m.recorder.stop();
    assert.match(m.recorder.state.error, /不足 3 秒/);
    await m.recorder.start(); m.push(new Int16Array(48000)); m.recorder.stop();
    assert.match(m.recorder.state.error, /没有录到/);
    await m.recorder.start(); m.push(new Int16Array(64000).fill(1234)); m.recorder.stop();
    assert.equal(m.recorder.state.status, 'ready');
    assert.equal(m.recorder.state.seconds, 4);
    assert.equal(m.stops(), 3);
    m.recorder.dispose();
});
test('recording caps sample count at 20 seconds and ignores late audio callbacks', async () => {
    const m = mic(); await m.recorder.start();
    m.push(new Int16Array(350000).fill(1234));
    assert.equal(m.recorder.state.seconds, 20);
    const wav = m.recorder.state.wav;
    assert.equal(wav.byteLength, 44 + 320000 * 2);
    m.push(new Int16Array(16000));
    assert.equal(m.recorder.state.wav, wav);
    assert.equal(m.stops(), 1);
    m.recorder.dispose();
});
test('cancel or unmount while permission is pending stops the late microphone stream', async () => {
    let resolve, stopped = 0;
    const recorder = new ReferenceRecorder(() => {}, () => new Promise(r => { resolve = r; }));
    const pending = recorder.start(); recorder.dispose();
    resolve({ stop() { stopped++; } }); await pending;
    assert.equal(stopped, 1);
    assert.equal(recorder.state.status, 'idle');
});
test('permission denial is actionable and retry succeeds', async () => {
    let n = 0;
    const recorder = new ReferenceRecorder(() => {}, async () => {
        if (!n++) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        return { stop() {} };
    });
    await recorder.start(); assert.match(recorder.state.error, /麦克风权限/);
    await recorder.start(); assert.equal(recorder.state.status, 'recording'); recorder.dispose();
});
test('capture releases tracks when AudioContext construction fails', async () => {
    const oldNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const oldAudio = globalThis.AudioContext;
    let stopped = 0;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++; } }] }) } } });
    globalThis.AudioContext = class { constructor() { throw new Error('context failed'); } };
    try { await assert.rejects(capturePcm(() => {}), /context failed/); assert.equal(stopped, 1); }
    finally {
        if (oldNav) Object.defineProperty(globalThis, 'navigator', oldNav); else delete globalThis.navigator;
        if (oldAudio) globalThis.AudioContext = oldAudio; else delete globalThis.AudioContext;
    }
});
test('automatic names do not replace earlier recordings', () => {
    assert.equal(availableRefName([{ label: '我的音色' }, { label: '我的音色 2' }]), '我的音色 3');
});

function settings(rpc) {
    let value = { ttsEngine: 'kokoro', ttsVisibleEngines: ['kokoro'], ttsVoice: { kokoro: 'preset' } };
    const writes = [];
    const scope = {
        getSnapshot: () => ({ value, writable: true, user: value }), subscribe: () => () => {},
        async mutate(ops) { writes.push(ops); for (const op of ops) value = { ...value, [op.path[0]]: op.value }; },
    };
    const store = new VoiceSettingsStore({ rpc }); store.attachScope(scope);
    store.update({ engineChoices: [{ id: 'cosyvoice3', voiceKind: 'clone', installed: true }] });
    return { store, writes, value: () => value };
}
test('save and use keeps multiple voices and all previous engine preferences', async () => {
    const refs = [];
    const { store, value, writes } = settings(async (_c, endpoint, payload) => {
        assert.equal(endpoint, 'saveRef');
        const saved = { id: `/refs/${payload.name}.wav`, label: payload.name }; refs.push(saved);
        return { ok: true, value: { saved, refs: [...refs] } };
    });
    for (const name of ['一', '二']) assert.equal(await store.saveRef({ name, audio: 'YQ==', ext: '.wav', text: '文本' }, 'cosyvoice3'), true);
    assert.equal(store.state.refs.length, 2);
    assert.equal(value().ttsVoice.kokoro, 'preset');
    assert.equal(value().ttsVoice.cosyvoice3, '/refs/二.wav');
    assert.equal(value().ttsEngine, 'cosyvoice3');
    assert.deepEqual(value().ttsVisibleEngines, ['kokoro', 'cosyvoice3']);
    assert.equal(writes.length, 2);
});
test('preview selects and validates exact reference before generating different text', async () => {
    const calls = [];
    const { store } = settings(async (_c, endpoint, payload) => { calls.push([endpoint, payload]); return { ok: true, value: { wav: 'YQ==' } }; });
    await store.previewRef('/refs/one.wav', 'cosyvoice3', '新的示例内容');
    assert.deepEqual(calls.map(c => c[0]), ['select', 'setVoice', 'speak']);
    assert.deepEqual(calls[2][1], { text: '新的示例内容', engine: 'cosyvoice3', voice: '/refs/one.wav' });
});
test('invalid clone or cancelled model load cannot fall back to another voice', async () => {
    const calls = [];
    let current = true;
    const { store } = settings(async (_c, endpoint) => {
        calls.push(endpoint);
        if (endpoint === 'select') current = false;
        return { ok: true, value: {} };
    });
    await assert.rejects(store.previewRef('/refs/x.wav', 'cosyvoice3', '试听', () => current), /取消/);
    assert.deepEqual(calls, ['select']);
    calls.length = 0;
    store.rpc = async (_c, endpoint) => { calls.push(endpoint); return endpoint === 'setVoice' ? { ok: false, error: { message: 'bad reference' } } : { ok: true, value: {} }; };
    await assert.rejects(store.previewRef('/refs/x.wav', 'cosyvoice3', '试听'), /bad reference/);
    assert.deepEqual(calls, ['select', 'setVoice']);
});


test('chat read-aloud follows the engine selected from settings, replacing stale browser preference', async () => {
    const { TtsController } = await import('../lib/client/tts-store.js');
    const controller = new TtsController({ sessions: {}, rpc: async (_c, endpoint) => ({ ok: true, value: endpoint === 'config'
        ? { engine: 'cosyvoice3', engines: [{ id: 'kokoro' }, { id: 'cosyvoice3' }] }
        : { state: 'idle', active: null } }) });
    controller.savedEngine = 'kokoro';
    await controller.refreshConfig();
    assert.equal(controller.savedEngine, 'cosyvoice3');
    assert.equal(controller.state.preferred, 'cosyvoice3');
    controller.dispose();
});
