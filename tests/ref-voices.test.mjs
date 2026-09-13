/**
 * 克隆音色(参考音频目录)。
 *
 * 用户的原话是"有没有办法让我在 cosyvoice 的配置页面尝试配置克隆音色"。
 * CosyVoice 2/3 是零样本克隆引擎:没有说话人列表,"一个音色"就是**一段参考
 * 音频**。所以这个功能的全部内容就是:一个目录 + 目录里的 wav 出现在音色下拉里。
 *
 * 三条容易写错、写错就"看起来能用其实废掉"的地方,这里各钉一条:
 *  1. 目录没配/配成空串时必须回落到默认目录(空串不是 nullish —— 本仓库已经
 *     在 ttsTextnormPath 上栽过一次);
 *  2. 预置音色引擎(Kokoro)不能被塞进文件路径,它的音色标识是 `zh=..,en=..`;
 *  3. **音色的身份必须是绝对路径**。旧 worker 对文件型音色回的是 basename,
 *     宿主把它记成当前音色,worker 一重启就再也解析不回来 —— 最后一条用真
 *     worker 子进程验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REF_DIR, listRefWavs, resolveRefDir, withRefVoices } from '../lib/core/ref-wavs.js';
import { TtsManager } from '../lib/core/tts-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, '..', 'python', 'tts_worker.py');
/** 唯一能 import numpy 的解释器;缺了就跳过"真起 worker"那条。 */
const PREP_PYTHON = process.env.DSH_VOICE_TEST_PYTHON || '';

const opts = { ttsRoot: '/t', modelsRoot: '/m', engine: 'kokoro' };

/** 假子进程 + 假参考目录:只验证编排,不碰真实文件系统。 */
function makeDeps(refs, { current = 'cosyvoice' } = {}) {
  const createProc = spec => ({
    id: spec.id,
    ready: false,
    info: undefined,
    async start() {
      this.ready = true;
      return this;
    },
    async unload() { this.ready = false; },
    async voices() { return { voices: ['preset_a', 'preset_b'], voice: spec.defaultVoice }; },
    async setVoice(voice) { return { voices: undefined, voice }; },
    async speak() { return { wav: Buffer.from('x'), sampleRate: 24000, audioSeconds: 1, voice: 'x' }; },
    async stats() { return { engine: spec.id }; },
    dispose() {},
  });
  return {
    createProc,
    exists: () => true,
    queryVram: async () => 5000,
    listRefs: () => refs,
  };
}

const REFS = [
    { id: '/refs/我的声音.wav', label: '我的声音' },
    { id: '/refs/narrator.flac', label: 'narrator' },
];

// ---------------------------------------------------------------------------
// 第 1 层:目录发现
// ---------------------------------------------------------------------------
test('空串/纯空白的参考音频目录一律回落到默认目录', () => {
    assert.equal(resolveRefDir(''), DEFAULT_REF_DIR);
    assert.equal(resolveRefDir('   '), DEFAULT_REF_DIR);
    assert.equal(resolveRefDir(undefined), DEFAULT_REF_DIR);
    assert.equal(resolveRefDir(null), DEFAULT_REF_DIR);
    assert.equal(resolveRefDir('/tmp/my-refs'), '/tmp/my-refs');
    // 默认目录落在 DSH_HOME 下,scratch 环境才能天然隔离。
    assert.ok(DEFAULT_REF_DIR.endsWith(path.join('.dsh', 'voice-refs')) || DEFAULT_REF_DIR.includes('voice-refs'));
});

test('listRefWavs 只认 wav/flac,跳过隐藏文件、sidecar 和目录', () => {
    const files = { '/r/a.wav': true, '/r/b.flac': true, '/r/b.txt': true, '/r/c.mp3': true, '/r/.hidden.wav': true };
    const out = listRefWavs('/r', {
        readdir: () => ['a.wav', 'b.flac', 'b.txt', 'c.mp3', '.hidden.wav', 'subdir'],
        isFile: p => files[p] === true,
    });
    assert.deepEqual(out, [
        { id: '/r/a.wav', label: 'a' },
        { id: '/r/b.flac', label: 'b' },
    ]);
});

test('参考目录不存在是常态,不是错误', () => {
    assert.deepEqual(listRefWavs('/nope', { readdir: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } }), []);
});

test('listRefWavs 按文件名排序,同名不同扩展名不会互相吃掉', () => {
    const out = listRefWavs('/r', {
        readdir: () => ['b.wav', 'a.flac', 'a.wav'],
        isFile: () => true,
    });
    assert.deepEqual(out.map(r => r.label), ['a', 'a', 'b']);
});

// ---------------------------------------------------------------------------
// 第 2 层:合并进音色目录
// ---------------------------------------------------------------------------
test('withRefVoices 追在引擎音色后面,且不重复', () => {
    assert.deepEqual(withRefVoices(['p1'], REFS), ['p1', ...REFS]);
    assert.deepEqual(withRefVoices([], REFS), REFS);
    // 已经列过的路径不再追加。
    assert.deepEqual(withRefVoices([REFS[0]], [REFS[0]]), [REFS[0]]);
    // 没有参考音频时必须原样返回(不能再造一份,否则每次 status 都触发重渲染)。
    const input = ['p1'];
    assert.equal(withRefVoices(input, []), input);
});

test('分组形状的音色目录(Kokoro 的 zh/en)原样返回,绝不追加文件路径', () => {
    const grouped = { zh: ['zf_001'], en: ['af_heart'] };
    assert.equal(withRefVoices(grouped, REFS), grouped);
});

test('克隆引擎的音色列表里出现参考音频,预置音色引擎里不出现', async () => {
    const mgr = new TtsManager({ ...opts, engine: 'cosyvoice', refDir: '/refs' }, () => {}, makeDeps(REFS));
    const clone = await mgr.listVoices();
    assert.deepEqual(clone.voices, ['preset_a', 'preset_b', ...REFS]);
    assert.equal(clone.voiceKind, undefined); // listVoices 只回列表,kind 走 status

    const preset = new TtsManager({ ...opts, engine: 'kokoro', refDir: '/refs' }, () => {}, makeDeps(REFS));
    const kokoro = await preset.listVoices();
    assert.deepEqual(kokoro.voices, ['preset_a', 'preset_b'], 'Kokoro 是预置音色引擎,不该出现文件路径');
    await mgr.dispose();
    await preset.dispose();
});

test('status 里带着参考音频目录,面板才能告诉用户文件放哪儿', async () => {
    const mgr = new TtsManager({ ...opts, engine: 'cosyvoice', refDir: '' }, () => {}, makeDeps(REFS));
    const status = await mgr.status();
    assert.equal(status.refDir, DEFAULT_REF_DIR);
    // 还没加载任何引擎时也不该为空 —— 面板打开就该看到提示。
    assert.equal(status.active, null);
    await mgr.dispose();
});

test('刷新音色列表时参考音频跟着一起刷新(用户放完文件不必重启)', async () => {
    let refs = [];
    const deps = makeDeps(refs);
    deps.listRefs = () => refs;
    const mgr = new TtsManager({ ...opts, engine: 'cosyvoice' }, () => {}, deps);
    assert.deepEqual((await mgr.listVoices()).voices, ['preset_a', 'preset_b']);
    refs = REFS;
    assert.deepEqual((await mgr.listVoices()).voices, ['preset_a', 'preset_b', ...REFS]);
    await mgr.dispose();
});

// ---------------------------------------------------------------------------
// 第 3 层:真 worker —— 文件型音色的身份必须是绝对路径
// ---------------------------------------------------------------------------
function talkToWorker(args, requests, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const child = execFile(PREP_PYTHON, [WORKER, ...args],
            { timeout, maxBuffer: 8 * 1024 * 1024 },
            (error, out) => (error && !out ? reject(error) : resolve(out)));
        child.stdin.on('error', () => { });
        child.stdin.end(requests.map(r => JSON.stringify(r)).join('\n') + '\n');
    });
}

test('真 worker:用户自己的参考音频以绝对路径为身份(重启才解析得回来)', async t => {
    if (!existsSync(PREP_PYTHON)) {
        t.skip(`缺少 ${PREP_PYTHON}`);
        return;
    }
    const asset = process.env.DSH_VOICE_TEST_REFERENCE || '';
    if (!existsSync(asset)) {
        t.skip(`缺少 ${asset}`);
        return;
    }
    // 拷到临时目录:内容仍是合法 wav,但不再是"出厂资产",所以必须按用户参考音频处理。
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-refs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const mine = path.join(dir, '我的声音.wav');
    copyFileSync(asset, mine);
    writeFileSync(path.join(dir, '我的声音.txt'), '希望你以后能够做的比我还好呦。\n');
    const out = await talkToWorker(['--engine', 'cosyvoice', '--autoload', '0'], [
        { id: 1, cmd: 'setVoice', voice: mine },
        { id: 2, cmd: 'setVoice', voice: 'cross_lingual_zh' },
        // 出厂资产即使被当成文件传进来,也必须回到预置身份(否则 prompt text 会丢,
        // zero-shot 会静默退化成 cross-lingual)。
        { id: 3, cmd: 'setVoice', voice: asset },
        { id: 4, cmd: 'voices' },
    ]);
    const replies = out.trim().split('\n').map(line => JSON.parse(line));
    const byId = Object.fromEntries(replies.filter(r => r.id).map(r => [r.id, r]));
    // 旧实现这里会回 "我的声音.wav"(basename)→ 宿主存下来 → 重启后解析不回来。
    assert.equal(byId[1]?.voice, mine, '文件型音色的身份必须是绝对路径,不能是 basename');
    assert.equal(byId[2]?.voice, 'cross_lingual_zh', '预置名仍然按名字解析');
    assert.equal(byId[3]?.voice, 'zero_shot_zh', '出厂资产按路径传入时仍回到预置身份');
    assert.ok((byId[4]?.voices ?? []).includes('zero_shot_zh'), '出厂参考音频仍然在列表里');
});

test('真 worker:不存在的音色名要报错,而不是悄悄用默认音色', async t => {
    if (!existsSync(PREP_PYTHON)) {
        t.skip(`缺少 ${PREP_PYTHON}`);
        return;
    }
    const out = await talkToWorker(['--engine', 'cosyvoice', '--autoload', '0'], [
        { id: 1, cmd: 'setVoice', voice: '/nope/不存在.wav' },
    ]);
    const replies = out.trim().split('\n').map(line => JSON.parse(line)).filter(r => r.id);
    const reply = replies.find(r => r.id === 1);
    assert.equal(reply?.ok, false);
    assert.match(String(reply?.error), /unknown cosyvoice reference/);
});

test('真 worker:已移除的 f5tts 不再是合法引擎', async t => {
    if (!existsSync(PREP_PYTHON)) {
        t.skip(`缺少 ${PREP_PYTHON}`);
        return;
    }
    const result = await new Promise(resolve => {
        execFile(PREP_PYTHON, [WORKER, '--engine', 'f5tts', '--autoload', '0'],
            { timeout: 20000 }, (error, _out, err) => resolve({ error, err }));
    });
    assert.ok(result.error, 'f5tts 必须被 argparse 拒绝');
    assert.match(String(result.err), /invalid choice/);
});

/**
 * 克隆音色在面板上的**显示**名。标识是绝对路径,但提示文字里糊一整行
 * <data-dir>/voice-refs/我的声音.wav 是没法看的 —— 只改显示,state.voice 不动。
 */
test('音色显示名:路径型音色显示文件名,预置音色原样', async () => {
    const { voiceLabel } = await import('../lib/client/tts-store.js');
    assert.equal(voiceLabel('/example/user/.dsh/voice-refs/我的声音.wav'), '我的声音');
    assert.equal(voiceLabel('/example/user/.dsh/voice-refs/我的声音.flac'), '我的声音');
    assert.equal(voiceLabel('C:\\refs\\clone.wav'), 'clone');
    // 预置音色、Kokoro 的成对串、空值都不能被改动 —— 它们不是路径。
    assert.equal(voiceLabel('zero_shot_zh'), 'zero_shot_zh');
    assert.equal(voiceLabel('zh=zf_001,en=af_heart'), 'zh=zf_001,en=af_heart');
    assert.equal(voiceLabel(''), '');
    assert.equal(voiceLabel(null), '');
    assert.equal(voiceLabel(undefined), '');
    // 点号在中间不能被当成扩展名吃掉。
    assert.equal(voiceLabel('/refs/a.b.wav'), 'a.b');
});
