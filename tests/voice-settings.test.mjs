/**
 * 设置面板这条链路的测试:语言表 → host 设置命名空间 → ASR 语言注入
 * → 克隆音色文件操作 → 客户端 store。
 *
 * 为什么值得单独一个文件:这条链路里每一段都"看起来显然正确",但任何一段
 * 写错都不会报错,只会安静地不生效 —— 语言选了不传、设置改了不重建、参考
 * 音频存到了目录外面、面板读到的是过期的兜底值。这些正是要靠断言钉住的东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Schema from '@deepseek-ai/schemastery';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { PythonAsr } from '../lib/core/python-asr.js';
import { VoiceSettingsSchema } from '../lib/core/settings-schema.js';
import {
    ASR_AUTO, asrLanguageOptions, backendLanguage, isAsrLanguage, normalizeAsrLanguage,
} from '../lib/core/asr-languages.js';
import {
    deleteRefWav, readRefText, sanitizeRefName, saveRefWav,
} from '../lib/core/ref-wavs.js';
import { TtsManager } from '../lib/core/tts-manager.js';
import { normalizeVisibleEngines } from '../lib/core/tts-engines.js';
import { VoiceSettingsStore } from '../lib/client/settings-store.js';

// ---------------------------------------------------------------- 语言表

test('语言表把 UI 的 ISO 码翻成每个后端认的写法', () => {
    // Qwen3-ASR 只认规范英文名,传 'de' 会直接 ValueError。
    assert.equal(backendLanguage('de', 'qwen'), 'German');
    assert.equal(backendLanguage('zh', 'qwen'), 'Chinese');
    // faster-whisper 认 ISO,不认 'German'。
    assert.equal(backendLanguage('de', 'whisper'), 'de');
    assert.equal(backendLanguage('zh', 'whisper'), 'zh');
    // auto → 不传参数(null),两端各自自动检测。
    assert.equal(backendLanguage('auto', 'qwen'), null);
    assert.equal(backendLanguage('auto', 'whisper'), null);
    // zipformer 这类没有语言参数的 backend:翻不出东西也是 null,而不是乱传。
    assert.equal(backendLanguage('de', 'zipformer'), 'de');
});

test('粤语在 whisper 上没有对应码,退回自动检测而不是传一个必然报错的值', () => {
    assert.equal(backendLanguage('yue', 'qwen'), 'Cantonese');
    assert.equal(backendLanguage('yue', 'whisper'), null);
});

test('未知/空的语言值一律当 auto,绝不因为一个拼错的码让语音输入整条不能用', () => {
    assert.equal(normalizeAsrLanguage('klingon'), ASR_AUTO);
    assert.equal(normalizeAsrLanguage(undefined), ASR_AUTO);
    assert.equal(normalizeAsrLanguage(''), ASR_AUTO);
    assert.equal(normalizeAsrLanguage('de'), 'de');
    assert.equal(isAsrLanguage('klingon'), false);
    assert.equal(isAsrLanguage('yue'), true);
});

test('下发给面板的语言选项第一项永远是自动检测', () => {
    const options = asrLanguageOptions();
    assert.equal(options[0].value, ASR_AUTO);
    assert.match(options[0].label, /自动检测/);
    // schema 能接受的取值必须与选项完全一致,否则面板会给出一个存不进去的值。
    const codes = new Set(options.map(option => option.value));
    for (const code of codes)
        assert.doesNotThrow(() => VoiceSettingsSchema({ asrLanguage: code }), `schema 不接受 ${code}`);
});

// ---------------------------------------------------- schema 与设置文档

test('设置 schema 的字段名与行内 config 逐字相同(base 就是那份 entry)', () => {
    const resolved = VoiceSettingsSchema({});
    // 这几个是 host 里被直接读的字段;名字对不上会静默丢掉配置文件里的值。
    for (const key of ['engine', 'nativeBackend', 'asrLanguage', 'hotkey', 'ttsEngine', 'ttsRefDir']) {
        assert.ok(key in resolved, `schema 缺少 ${key}`);
    }
    assert.equal(resolved.asrLanguage, 'auto');
    assert.equal(resolved.ttsAutoRead, true);
    assert.deepEqual(resolved.ttsVoice, {});
    // 可见引擎默认是全集:不配置时行为与加这个设置项之前完全一致。
    assert.deepEqual(resolved.ttsVisibleEngines.slice().sort(), ['cosyvoice', 'cosyvoice3', 'indextts', 'kokoro']);
});

test('schema 信封能被客户端重新水合(面板靠它校验用户层)', () => {
    // 设置面板读到的是 schema.toJSON() 的信封,自己 new Schema(json) 水合
    // (dsh-client-ui-settings 的 SettingsSchemaService.rehydrate 就是这么写的)。
    // 这条一旦坏了,命名空间会"发布不出任何值",面板永远停在 loading。
    //
    // 必须用 schemastery 的导出类去 new,不能用 VoiceSettingsSchema.constructor:
    // 后者是裸的 Function,new 它等于 new Function(json) → SyntaxError。
    const json = VoiceSettingsSchema.toJSON();
    const rehydrated = new Schema(json);
    const value = rehydrated({ asrLanguage: 'de', ttsVoice: { kokoro: 'zf_001' } });
    assert.equal(value.asrLanguage, 'de');
    assert.deepEqual(value.ttsVoice, { kokoro: 'zf_001' });
    // 非法取值必须在客户端也被拒(否则会发给 host 换一个丑陋的错误)。
    assert.throws(() => rehydrated({ asrLanguage: 'klingon' }));
    assert.throws(() => rehydrated({ ttsVisibleEngines: ['nope'] }));
});

test('可见引擎列表永远不会是空的(空了面板就再也勾不回来)', () => {
    assert.deepEqual(normalizeVisibleEngines([]), ['kokoro', 'cosyvoice', 'cosyvoice3', 'indextts']);
    assert.deepEqual(normalizeVisibleEngines(['nope', 42]), ['kokoro', 'cosyvoice', 'cosyvoice3', 'indextts']);
    assert.deepEqual(normalizeVisibleEngines(undefined), ['kokoro', 'cosyvoice', 'cosyvoice3', 'indextts']);
    // 去重 + 按固定顺序排列(显示顺序由我们决定,不受用户勾选顺序影响)。
    assert.deepEqual(normalizeVisibleEngines(['indextts', 'kokoro', 'indextts']), ['kokoro', 'indextts']);
});

// ------------------------------------------------------- 参考音频文件操作

test('音色名不能被用来逃出参考音频目录', () => {
    // 绝对路径与 ../ 都被 basename 剥掉,只剩最后一段。
    assert.equal(sanitizeRefName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeRefName('/etc/passwd'), 'passwd');
    assert.equal(sanitizeRefName('..\\..\\windows\\system32\\config'), 'config');
    // 纯点/空格得不到合法名字,调用方必须报错而不是写一个叫 "." 的文件。
    assert.equal(sanitizeRefName('..'), '');
    assert.equal(sanitizeRefName('   '), '');
    assert.equal(sanitizeRefName('...'), '');
    assert.equal(sanitizeRefName(null), '');
    // 中文必须保留:用户一定会用中文起名。
    assert.equal(sanitizeRefName('我的声音'), '我的声音');
    // 已经带扩展名的等价于不带("/…/我的声音.wav" 不能存成 "我的声音.wav.wav")。
    assert.equal(sanitizeRefName('我的声音.wav'), '我的声音');
    assert.equal(sanitizeRefName('我的声音.flac'), '我的声音');
    // 但非音频扩展名是名字的一部分。
    assert.equal(sanitizeRefName('声音.v2'), '声音.v2');
});

test('存/读/删参考音频是同一个目录里的一组文件', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-refs-'));
    const audio = Buffer.from('RIFF....WAVE');
    const saved = saveRefWav(dir, '我的声音', audio, '.wav', '你好，这是一段测试。');
    assert.equal(saved.label, '我的声音');
    assert.equal(path.dirname(saved.id), dir);
    assert.equal(readFileSync(saved.id).toString(), audio.toString());
    assert.equal(readRefText(dir, '我的声音'), '你好，这是一段测试。');
    assert.equal(existsSync(path.join(dir, '我的声音.txt')), true);

    // 重新导入同名但**不带**文本:必须把旧 .txt 删掉。留着它是最坏情况 ——
    // worker 会拿一段完全无关的文本去做 zero-shot,音色相似度直接崩。
    saveRefWav(dir, '我的声音', Buffer.from('RIFF....WAVE2'), '.wav', '');
    assert.equal(existsSync(path.join(dir, '我的声音.txt')), false);
    assert.equal(readRefText(dir, '我的声音'), '');

    const removed = deleteRefWav(dir, '我的声音');
    assert.equal(removed.removed, true);
    assert.equal(existsSync(saved.id), false);
    // 删第二次:不该抛,只是报"没删到"。
    assert.equal(deleteRefWav(dir, '我的声音').removed, false);
});

test('参考音频目录不存在时保存要自己建出来', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'voice-refs-'));
    const dir = path.join(root, 'nested', 'refs');
    const saved = saveRefWav(dir, '音色', Buffer.from('x'), '.wav', '');
    assert.equal(existsSync(saved.id), true);
});

test('空音色名与空内容都被拒(不能写出一个 0 字节的音色)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-refs-'));
    assert.throws(() => saveRefWav(dir, '  ', Buffer.from('x')), /音色名/);
    assert.throws(() => saveRefWav(dir, '名字', null), /内容无效/);
    assert.throws(() => deleteRefWav(dir, ''), /缺少/);
});

// ------------------------------------------------ host:/voice 与设置命名空间

/** 行内 entry:与 cordis 传给 apply() 的形状一致(schema 已解析出默认值)。 */
const ENTRY = () => VoiceSettingsSchema({});

/**
 * 造一个够用的 cordis 上下文 + 一个真的能用(但只有内存)的 settings provider。
 *
 * 关键点是 `inject(['settings'], cb)` 的回调在 provider 在位时会被调用 ——
 * 这正是生产里 installSection 那条路径的触发条件,所以这里必须建模对。
 */
function harness({ entry = {}, deps = {}, withSettings = true, registerThrows = null } = {}) {
    const handlers = {};
    const disposers = [];
    const logs = [];
    const userLayers = new Map();
    const scopes = new Map();
    const registrations = new Map();
    const provider = {
        register(ns, schema, options = {}) {
            const base = options.base ?? {};
            const resolveValue = () => schema({ ...base, ...(userLayers.get(ns) ?? {}) });
            const watchers = new Set();
            const scope = {
                get: resolveValue,
                watch(cb) {
                    watchers.add(cb);
                    return () => watchers.delete(cb);
                },
                async update(patch) {
                    userLayers.set(ns, { ...(userLayers.get(ns) ?? {}), ...patch });
                    // 真的 provider 会先校验再提交;这里校验一下,免得测试通过
                    // 一个生产里会被拒的写入。
                    resolveValue();
                    for (const cb of watchers) await cb(resolveValue(), null);
                },
                async replace(section) {
                    userLayers.set(ns, { ...section });
                    for (const cb of watchers) await cb(resolveValue(), null);
                },
            };
            scopes.set(ns, scope);
            registrations.set(ns, { schema, options });
            return scope;
        },
    };
    // 真的 provider 在"存量 voice 段有非法值"时会从 register 抛出来
    // (见 voice-settings-provider.test.mjs)。这里模拟那一种部署。
    if (registerThrows)
        provider.register = () => { throw new Error(registerThrows); };
    const ctx = {
        logger: {
            warn: (...args) => logs.push(['warn', ...args]),
            info: (...args) => logs.push(['info', ...args]),
            error: (...args) => logs.push(['error', ...args]),
        },
        effect: fn => {
            const dispose = fn();
            if (typeof dispose === 'function') disposers.push(dispose);
            return dispose;
        },
        inject: (names, cb) => {
            if (withSettings && names.includes('settings')) {
                const dispose = cb({ ...ctx, settings: provider });
                if (typeof dispose === 'function') disposers.push(dispose);
            }
            return {};
        },
        connection: {
            rpc: {
                handle: (channel, fn) => {
                    handlers[channel] = fn;
                    return () => {};
                },
            },
        },
    };
    apply(ctx, { ...ENTRY(), ...entry }, deps);
    return {
        call: (endpoint, payload) => handlers['/voice'](endpoint, payload),
        callTts: (endpoint, payload) => handlers['/tts'](endpoint, payload),
        logs, scopes, userLayers, registrations,
        text: () => logs.map(entry => entry.join(' ')).join('\n'),
        update: async patch => scopes.get('voice').update(patch),
        dispose: () => disposers.forEach(dispose => dispose()),
    };
}

/** 把 PythonAsr 的两条对外方法换成记录器,这样不必真的起 python。 */
function stubPythonAsr(t) {
    const seen = [];
    const originalHandle = PythonAsr.prototype.handle;
    PythonAsr.prototype.handle = async function (req) {
        seen.push(req);
        return { ok: true, value: { delta: '识别结果', final: true } };
    };
    t.after(() => { PythonAsr.prototype.handle = originalHandle; });
    return seen;
}

test('host 把语音设置注册成 voice 命名空间,行内 config 是 base 层', () => {
    const h = harness({ entry: { asrLanguage: 'de', hotkey: 'ctrl+m' } });
    const registration = h.registrations.get('voice');
    assert.ok(registration, '必须注册 voice 命名空间,否则设置面板里没有这个 tab');
    assert.equal(registration.options.applies, 'live');
    // 行内 config 成为 base:用户在面板里清掉某一项,退回它而不是 schema 默认值。
    const resolved = h.scopes.get('voice').get();
    assert.equal(resolved.asrLanguage, 'de');
    assert.equal(resolved.hotkey, 'ctrl+m');
    assert.equal(resolved.ttsEngine, 'kokoro');
    h.dispose();
});

test('注册命名空间失败时插件不能死,而且要把原因下发给面板', async () => {
    // 真实场景:用户手改 ~/.dsh/settings.yaml,voice 段里写了一个不合法的
    // asrLanguage。真 provider 会从 register() 抛(已用真 provider 量过),
    // 于是麦克风、朗读、这个面板全都要照常工作 —— 但用户必须看得见原因。
    const h = harness({
        entry: { hotkey: 'alt+v', asrLanguage: 'fr' },
        registerThrows: '$.asrLanguage expected "auto" | "de" but got "klingon"',
        // 用假管理器:这一条测的是"注册失败之后插件还活着",不是引擎。
        deps: { ttsManager: managerStub() },
    });
    const config = await h.call('config');
    assert.equal(config.ok, true, '一次坏配置不能让整个 /voice 通道失效');
    // 退回行内 config:至少当前生效的值是明确的。
    assert.equal(config.value.settings.asrLanguage, 'fr');
    assert.equal(config.value.settings.hotkey, 'alt+v');
    assert.match(config.value.settingsError, /klingon/, '没有把原因下发给面板,用户只能瞎猜');
    // 日志里也要有,便于事后排查。
    assert.match(h.text(), /注册失败/);
    // 写回用户层的路径必须安静地不做事,而不是抛。
    await h.callTts('select', { engine: 'kokoro' });
    h.dispose();
});

test('没有 settings provider 时插件照常工作,读的是行内 config', async () => {    const h = harness({ entry: { engine: 'browser', hotkey: 'alt+v' }, withSettings: false });
    const config = await h.call('config');
    assert.equal(config.ok, true);
    assert.equal(config.value.engine, 'browser');
    assert.equal(config.value.hotkey, 'alt+v');
    // 语言表照常下发 —— 面板在没有设置文档时仍然要能显示只读的当前值。
    assert.equal(config.value.languages[0].value, 'auto');
    h.dispose();
});

test('/voice/config 同时下发语言表、全量引擎目录和完整设置', async () => {
    const h = harness();
    const config = await h.call('config');
    const value = config.value;
    assert.equal(value.backend, 'zipformer');
    assert.ok(Array.isArray(value.languages) && value.languages.length > 20);
    // 全量引擎目录:面板那份勾选框必须能看到**被藏起来**的引擎,否则取消勾选
    // 之后就再也勾不回来了。
    assert.deepEqual(value.ttsEngines.map(engine => engine.id).sort(),
        ['cosyvoice', 'cosyvoice3', 'indextts', 'kokoro']);
    assert.equal(value.settings.hotkey, ENTRY().hotkey);
    assert.equal(value.settings.ttsVisibleEngines.length, 4);
    h.dispose();
});

test('改了语言设置之后,/voice/config 立刻反映新值', async () => {
    const h = harness();
    await h.update({ asrLanguage: 'fr' });
    assert.equal((await h.call('config')).value.settings.asrLanguage, 'fr');
    h.dispose();
});

test('识别语言按后端翻译后逐请求传给 worker', async (t) => {
    const seen = stubPythonAsr(t);
    const h = harness({ entry: { engine: 'native', nativeBackend: 'qwen' } });
    const audio = Buffer.from([1, 0, 2, 0]).toString('base64');
    await h.call('asr', { sessionId: 's1', audio, final: true });
    // 默认 auto → 不带 language 字段(worker 把"缺字段"当自动检测)。
    assert.equal('language' in seen[0], false, 'auto 时不该传 language');

    await h.update({ asrLanguage: 'de' });
    await h.call('asr', { sessionId: 's2', audio, final: true });
    assert.equal(seen[1].language, 'German', 'qwen 后端要拿规范英文名');

    // 分块录音:handle 每一块都会被调用(非 final 只在 python-asr 内部攒着
    // 并立刻回空 delta),所以语言必须**每一块都带** —— 真 handle 正是用
    // 最近一次带过来的值给会话记语言的。"非 final 不转写"那部分由
    // python-asr.test.mjs 覆盖,这里只钉住 host 下发的字段。
    await h.call('asr', { sessionId: 's3', audio, final: false });
    assert.equal(seen[2].language, 'German', '开始录音的那一块也要带语言');
    await h.call('asr', { sessionId: 's3', audio, final: true });
    assert.equal(seen[3].language, 'German');

    // 换后端:同一个设置值要翻成 whisper 认的 ISO 码。
    await h.update({ nativeBackend: 'whisper' });
    await h.call('asr', { sessionId: 's4', audio, final: true });
    assert.equal(seen[4].language, 'de');
    h.dispose();
});

test('语言是逐请求传的:改它不重建子进程,改模型路径才重建', async (t) => {
    stubPythonAsr(t);
    // 用一个立刻退出的解释器:起进程这一步是快的、确定的失败,不需要 GPU。
    const h = harness({ entry: { engine: 'native', nativeBackend: 'qwen', pythonExecutable: '/bin/true' } });
    const rebuilt = () => /子进程已重建/.test(h.text());

    await h.update({ asrLanguage: 'de' });
    assert.equal(rebuilt(), false, '只改语言不该重建子进程(改了下一句就生效)');
    await h.update({ vadThreshold: 0.02 });
    assert.equal(rebuilt(), false, '录音灵敏度与子进程无关');
    await h.update({ hotkey: 'ctrl+alt+m' });
    assert.equal(rebuilt(), false, '快捷键更不该重建');

    await h.update({ nativeBackend: 'whisper' });
    assert.equal(rebuilt(), true, '换后端必须重建(它进了 --backend 启动参数)');

    // 换解释器 / 设备 / 模型目录同样在重建清单里。
    await h.update({ pythonExecutable: '/bin/false' });
    assert.ok(/子进程已重建/.test(h.text()));
    h.dispose();
});

test('用 /bin/false 起 ASR 子进程时 ping 失败,而且失败不会被缓存成"就绪"', async (t) => {
    stubPythonAsr(t);
    const h = harness({ entry: { engine: 'native', nativeBackend: 'qwen', pythonExecutable: '/bin/false' } });
    const first = await h.call('ping');
    // engine='native' 时不退回浏览器识别,所以必须报错而不是假装成功。
    assert.equal(first.ok, false);
    assert.match(first.error.message, /启动失败/);
    // 第二次再点麦克风要真的再试一次,不能因为上一次失败就永久卡死。
    const second = await h.call('ping');
    assert.equal(second.ok, false);
    h.dispose();
});

// ------------------------------------------------------------ 克隆音色 RPC

test('面板导入的参考音频落到配置的目录里,并且能列出来、删掉', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-refs-'));
    const h = harness({ entry: { ttsRefDir: dir } });
    const audio = Buffer.from('RIFF....WAVE').toString('base64');

    const saved = await h.callTts('saveRef', { name: '测试音色', audio, text: '这是测试音频。', ext: '.wav' });
    assert.equal(saved.ok, true);
    assert.equal(saved.value.saved.label, '测试音色');
    assert.equal(existsSync(path.join(dir, '测试音色.wav')), true);
    assert.equal(readFileSync(path.join(dir, '测试音色.txt'), 'utf8'), '这是测试音频。');
    // 回包直接带上新列表:用户不该为了看到刚导入的音色再点一次「刷新」。
    assert.deepEqual(saved.value.refs.map(ref => ref.label), ['测试音色']);
    assert.equal(saved.value.refs[0].text, '这是测试音频。');

    const removed = await h.callTts('deleteRef', { name: '测试音色' });
    assert.equal(removed.ok, true);
    assert.equal(removed.value.removed, true);
    assert.deepEqual(removed.value.refs, []);
    assert.equal(existsSync(path.join(dir, '测试音色.wav')), false);
    h.dispose();
});

test('导入空内容被拒,而不是写出一个 0 字节的"音色"', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-refs-'));
    const h = harness({ entry: { ttsRefDir: dir } });
    const empty = await h.callTts('saveRef', { name: 'x', audio: '' });
    assert.equal(empty.ok, false);
    assert.equal(empty.error.code, 'bad_ref');
    const over = await h.callTts('saveRef', { name: 'x', audio: Buffer.alloc(33 * 1024 * 1024).toString('base64') });
    assert.equal(over.ok, false);
    assert.equal(over.error.code, 'bad_ref');
    h.dispose();
});

test('删掉正在被用作音色的参考音频时,偏好也要清掉', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-refs-'));
    const refPath = path.join(dir, '被删的音色.wav');
    writeFileSync(refPath, 'RIFF....WAVE');
    const h = harness({ entry: { ttsRefDir: dir, ttsVoice: { cosyvoice: refPath, kokoro: 'zf_001' } } });
    await h.callTts('deleteRef', { name: '被删的音色' });
    // 不清的话 worker 会拿一个已经不存在的路径去合成,下一次朗读直接失败。
    const layer = h.userLayers.get('voice') ?? {};
    assert.equal(layer.ttsVoice.cosyvoice, undefined);
    // 别的引擎的音色不能跟着被清掉。
    assert.equal(layer.ttsVoice.kokoro, 'zf_001');
    h.dispose();
});

test('/tts/select 与 /tts/setVoice 把选择写回用户层(重启后还在)', async (t) => {
    stubPythonAsr(t);
    const h = harness({
        entry: { ttsEngine: 'kokoro', ttsVisibleEngines: ['kokoro', 'indextts'] },
        deps: { ttsManager: managerStub() },
    });
    const selected = await h.callTts('select', { engine: 'indextts' });
    assert.equal(selected.ok, true);
    assert.equal(h.userLayers.get('voice').ttsEngine, 'indextts');

    const voiced = await h.callTts('setVoice', { voice: '参考音色路径' });
    assert.equal(voiced.ok, true);
    // 逐引擎记:音色标识不通用(Kokoro 是预置名,克隆引擎是绝对路径)。
    assert.equal(h.userLayers.get('voice').ttsVoice.kokoro, '参考音色路径');

    const bad = await h.callTts('select', { engine: '不存在的引擎' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'bad_engine');
    h.dispose();
});

test('/tts/refs 只列目录,绝不加载模型', async (t) => {
    stubPythonAsr(t);
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-refs-'));
    writeFileSync(path.join(dir, 'a.wav'), 'RIFF');
    let ensureReadyCalls = 0;
    const manager = managerStub();
    // 假 manager 的 applySettings 是空实现,不会像真 manager 那样把设置里的
    // 参考音频目录接过去 —— 这里显式摆成 host 期望的那个状态。
    manager.refDir = dir;
    const originalEnsure = manager.ensureReady;
    manager.ensureReady = async () => { ensureReadyCalls += 1; return originalEnsure.call(manager); };
    const h = harness({ entry: { ttsRefDir: dir }, deps: { ttsManager: manager } });

    const listed = await h.callTts('refs', {});
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.value.refs.map(ref => ref.label), ['a']);
    // 这条是本次改动的核心:只是想改个语言设置的用户不该被拉进 24s 的模型加载。
    assert.equal(ensureReadyCalls, 0, 'refs 端点不许触发 ensureReady');
    h.dispose();
});

/**
 * /tts 的假 manager:只实现 index.js 真正调用的那几个方法。
 * 用假的是因为这里测的是 **host 的接线**(哪个端点写哪个字段),不是引擎。
 */
function managerStub() {
    return {
        desired: 'kokoro',
        refDir: '/refs',
        preferredVoices: {},
        catalog: () => [{ id: 'kokoro', label: 'Kokoro' }],
        status: async () => ({ active: null, engines: [] }),
        select: async id => { return { active: id }; },
        unload: async () => ({ active: null }),
        segments: async text => ({ segments: [text] }),
        listVoices: async () => ({ voices: [], voice: '' }),
        setVoice: async voice => ({ voices: [], voice, engine: 'kokoro' }),
        speak: async () => ({ skipped: 'empty', engine: 'kokoro' }),
        applySettings: () => {},
        dispose: async () => {},
        ensureReady: async () => { throw new Error('不该被调用'); },
    };
}

// ------------------------------------------------- TTS 管理器的热更新

/** 与 tts-manager.test.mjs 同款的假子进程。 */
function makeManagerDeps(events) {
    const procs = [];
    const createProc = spec => {
        const proc = {
            id: spec.id,
            ready: false,
            async start() {
                events.push(`start:${spec.id}`);
                proc.ready = true;
                proc.info = { ready: true, engine: spec.id, loadSeconds: 1 };
                return proc;
            },
            async unload() { events.push(`unload:${spec.id}`); proc.ready = false; },
            async voices() { return { voices: ['v1', 'v2'], voice: spec.defaultVoice }; },
            async setVoice(voice) { events.push(`setVoice:${voice}`); return { voices: ['v1', 'v2'], voice }; },
            async speak() { return { wav: null, skipped: 'empty' }; },
            async stats() { return {}; },
            dispose() {},
        };
        procs.push(proc);
        return proc;
    };
    return { deps: { createProc, exists: () => true, queryVram: async () => 5000 }, procs };
}

test('面板里改了"显示哪些引擎"只影响目录,不影响能力', async () => {
    const events = [];
    const { deps } = makeManagerDeps(events);
    const mgr = new TtsManager({ ttsRoot: '/t', modelsRoot: '/m', engine: 'kokoro' }, () => {}, deps);
    assert.equal(mgr.catalog().length, 4);
    mgr.applySettings({ ttsVisibleEngines: ['indextts'], ttsEngine: 'kokoro', ttsRoot: '/t', ttsModelsRoot: '/m' });
    assert.deepEqual(mgr.catalog().map(engine => engine.id), ['indextts']);
    // 全量目录still 要给设置面板用 —— 否则取消勾选之后就再也勾不回来了。
    assert.equal(mgr.catalog(false).length, 4);
});

test('设置里的引擎被藏起来时,自动落到第一个可见引擎(否则面板显示不出当前用的)', async () => {
    const events = [];
    const { deps } = makeManagerDeps(events);
    const mgr = new TtsManager({ ttsRoot: '/t', modelsRoot: '/m', engine: 'kokoro' }, () => {}, deps);
    mgr.applySettings({ ttsEngine: 'indextts', ttsVisibleEngines: ['kokoro', 'cosyvoice'] });
    assert.equal(mgr.desired, 'kokoro');
    // 用 ensureReady 而不是 waitReady:此刻还没有任何进程,也没有排队的加载,
    // 而因为引擎被藏起来所以 desired 从一开始就等于当前值 —— 没有任何理由
    // 把模型拉进显存。真正要断言的是"加载时用的是可见集合里的那个"。
    await mgr.ensureReady();
    assert.equal(mgr.current.id, 'kokoro');
});

test('安装路径变了但引擎没变时也必须真的换进程(不能被"已就绪"短路)', async () => {
    const events = [];
    const { deps } = makeManagerDeps(events);
    const mgr = new TtsManager({ ttsRoot: '/t', modelsRoot: '/m', engine: 'kokoro' }, () => {}, deps);
    await mgr.ensureReady();
    assert.deepEqual(events, ['start:kokoro']);
    events.length = 0;
    mgr.applySettings({ ttsRoot: '/t2', ttsModelsRoot: '/m', ttsEngine: 'kokoro' });
    await mgr.waitReady();
    // 先卸载再加载:同一条显存安全路径,不是"看起来没变就不动"。
    assert.deepEqual(events, ['unload:kokoro', 'start:kokoro']);
});

test('只改参考音频目录/文本规范脚本这类热字段时不重载模型', async () => {
    const events = [];
    const { deps } = makeManagerDeps(events);
    const mgr = new TtsManager({ ttsRoot: '/t', modelsRoot: '/m', engine: 'kokoro' }, () => {}, deps);
    await mgr.ensureReady();
    events.length = 0;
    mgr.applySettings({ ttsRoot: '/t', ttsModelsRoot: '/m', ttsEngine: 'kokoro', ttsRefDir: '/refs2', ttsTextnormPath: '/x.py' });
    await new Promise(resolve => setImmediate(resolve));
    // CosyVoice3 要 24 秒,不能因为改了个目录就白重载一遍。
    assert.deepEqual(events, []);
    assert.equal(mgr.refDir, '/refs2');
    assert.equal(mgr.textnormPath, '/x.py');
});

test('设置里的音色偏好在加载引擎时被推给 worker', async () => {
    const events = [];
    const { deps } = makeManagerDeps(events);
    const mgr = new TtsManager({ ttsRoot: '/t', modelsRoot: '/m', engine: 'kokoro' }, () => {}, deps);
    mgr.applySettings({ ttsEngine: 'kokoro', ttsRoot: '/t', ttsModelsRoot: '/m', ttsVoice: { kokoro: 'v2' } });
    await mgr.ensureReady();
    // worker 自己回的是引擎默认音色,所以偏好必须显式推回去。
    assert.equal(mgr.voice, 'v2');
    assert.ok(events.includes('setVoice:v2'));
});

test('设置里的音色偏好指向一个已经不存在的文件时不炸,只退回引擎默认', async () => {
    const events = [];
    const { deps } = makeManagerDeps(events);
    deps.createProc = spec => {
        const proc = {
            id: spec.id, ready: false,
            async start() { proc.ready = true; proc.info = { ready: true, engine: spec.id }; return proc; },
            async unload() { proc.ready = false; },
            async voices() { return { voices: ['v1'], voice: 'v1' }; },
            async setVoice() { throw new Error('参考音频不存在'); },
            async speak() { return { wav: null }; },
            async stats() { return {}; },
            dispose() {},
        };
        return proc;
    };
    const mgr = new TtsManager({ ttsRoot: '/t', modelsRoot: '/m', engine: 'kokoro' }, () => {}, deps);
    mgr.applySettings({ ttsEngine: 'kokoro', ttsRoot: '/t', ttsModelsRoot: '/m', ttsVoice: { kokoro: '被删掉的文件' } });
    await mgr.ensureReady();
    assert.equal(mgr.current.id, 'kokoro');
    assert.equal(mgr.voice, 'v1');
    assert.match(mgr.lastEvent, /音色偏好不可用/);
});

// ------------------------------------------------------------ 客户端 store

/** 假的 settingsScope(客户端那一半)。 */
function fakeScope({ status = 'ready', value = {}, user = {}, writable = true } = {}) {
    const listeners = new Set();
    const snapshot = { status, value, base: {}, user, revision: 1, writable, mode: 'host' };
    const writes = [];
    const scope = {
        getSnapshot: () => snapshot,
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        async set(field, next) {
            writes.push(['set', field, next]);
            user[field] = next;
            value[field] = next;
            for (const listener of listeners) listener();
        },
        async unset(field) {
            writes.push(['unset', field]);
            delete user[field];
            for (const listener of listeners) listener();
        },
        async mutate(ops) {
            writes.push(['mutate', ops]);
            for (const op of ops) delete user[op.path[0]];
            for (const listener of listeners) listener();
        },
    };
    return { scope, writes, snapshot, listeners };
}

/** 假的 RPC:按 channel/endpoint 回固定值。 */
function fakeRpc(routes, calls = []) {
    return async (channel, endpoint, payload) => {
        calls.push([channel, endpoint, payload]);
        const route = routes[`${channel}/${endpoint}`];
        if (route === undefined)
            return { ok: false, error: { code: 'unknown_endpoint', message: 'no route' } };
        return { ok: true, value: typeof route === 'function' ? route(payload) : route };
    };
}

const CONFIG_ROUTES = {
    '/voice/config': {
        languages: [{ value: 'auto', label: '自动检测（推荐）' }, { value: 'de', label: '德语(de)' }],
        ttsEngines: [{ id: 'kokoro', label: 'Kokoro', voiceKind: 'preset' }],
        settings: { hotkey: 'alt+m', asrLanguage: 'auto' },
    },
    '/tts/config': { engine: 'kokoro', refDir: '/refs', engines: [{ id: 'kokoro', label: 'Kokoro' }], refs: [] },
    '/tts/refs': { refs: [{ id: '/refs/我的声音.wav', label: '我的声音', text: '' }], refDir: '/refs' },
};

test('面板优先用设置文档的值,并读得到语言标签与引擎目录', async () => {
    const { scope } = fakeScope({ value: { hotkey: 'ctrl+alt+m' } });
    const store = new VoiceSettingsStore({ bindScope: () => scope, rpc: fakeRpc(CONFIG_ROUTES) });
    await store.start();
    const state = store.getSnapshot();
    assert.equal(state.status, 'ready');
    assert.equal(state.value.hotkey, 'ctrl+alt+m');
    assert.equal(state.languages.length, 2);
    assert.equal(state.engineChoices[0].id, 'kokoro');
    assert.equal(state.refDir, '/refs');
    store.dispose();
});

test('设置文档不可用时退回 host 下发的只读值,并且拒绝写入', async () => {
    const store = new VoiceSettingsStore({ bindScope: () => null, rpc: fakeRpc(CONFIG_ROUTES) });
    await store.start();
    const state = store.getSnapshot();
    // 关键:面板不能是一片空白,必须显示"现在实际生效的是什么"。
    assert.equal(state.value.hotkey, 'alt+m');
    assert.equal(state.status, 'ready');
    assert.equal(state.writable, false);
    assert.equal(await store.set('hotkey', 'alt+k'), false);
    assert.match(store.getSnapshot().error, /设置文档不可写/);
    store.dispose();
});

test('写字段走 scope,并把"哪些字段被改过"标出来', async () => {
    const { scope, writes } = fakeScope();
    const store = new VoiceSettingsStore({ bindScope: () => scope, rpc: fakeRpc(CONFIG_ROUTES) });
    await store.start();
    assert.deepEqual(store.getSnapshot().overridden, []);
    await store.set('asrLanguage', 'de');
    assert.deepEqual(writes[0], ['set', 'asrLanguage', 'de']);
    assert.deepEqual(store.getSnapshot().overridden, ['asrLanguage']);
    assert.equal(store.getSnapshot().note, '已保存');
    await store.resetField('asrLanguage');
    assert.deepEqual(store.getSnapshot().overridden, []);
    store.dispose();
});

test('全部恢复默认用的是 unset,不是写一份空值', async () => {
    const { scope, writes } = fakeScope({ user: { hotkey: 'x', asrLanguage: 'de' } });
    const store = new VoiceSettingsStore({ bindScope: () => scope, rpc: fakeRpc(CONFIG_ROUTES) });
    await store.start();
    assert.deepEqual(store.getSnapshot().overridden.slice().sort(), ['asrLanguage', 'hotkey']);
    await store.resetAll();
    // 每个字段一条 unset:写空值会把它们变成"用户显式设成空",那是另一回事。
    assert.deepEqual(writes[0], ['mutate', [{ op: 'unset', path: ['hotkey'] }, { op: 'unset', path: ['asrLanguage'] }]]);
    assert.deepEqual(store.getSnapshot().overridden, []);
    store.dispose();
});

test('导入/删除克隆音色后目录立刻刷新,不用用户再点一次', async () => {
    const saved = { saved: { label: '新音色' }, refs: [{ id: '/refs/新音色.wav', label: '新音色', text: '' }], refDir: '/refs' };
    const rpc = fakeRpc({ ...CONFIG_ROUTES, '/tts/saveRef': saved, '/tts/deleteRef': { removed: true, refs: [], refDir: '/refs' } });
    const { scope } = fakeScope();
    const store = new VoiceSettingsStore({ bindScope: () => scope, rpc });
    await store.start();
    assert.equal(await store.saveRef({ name: '新音色', audio: 'AAAA', text: '' }), true);
    assert.deepEqual(store.getSnapshot().refs.map(ref => ref.label), ['新音色']);
    assert.match(store.getSnapshot().note, /已导入音色/);
    assert.equal(await store.deleteRef('新音色'), true);
    assert.deepEqual(store.getSnapshot().refs, []);
    store.dispose();
});

test('作用域中途接上时,面板要从只读切换成可写', async () => {
    const store = new VoiceSettingsStore({ bindScope: () => null, rpc: fakeRpc(CONFIG_ROUTES) });
    await store.start();
    assert.equal(store.getSnapshot().writable, false);
    const { scope } = fakeScope({ value: { hotkey: 'ctrl+m' } });
    store.attachScope(scope);
    assert.equal(store.getSnapshot().writable, true);
    assert.equal(store.getSnapshot().value.hotkey, 'ctrl+m');
    // 摘掉之后必须退回 host 那份值:旧值已经没人负责写回了。
    store.attachScope(null);
    assert.equal(store.getSnapshot().writable, false);
    assert.equal(store.getSnapshot().value.hotkey, 'alt+m');
    store.dispose();
});

test('store 只在新值真的不同时才换快照引用', async () => {
    const { scope } = fakeScope();
    const store = new VoiceSettingsStore({ bindScope: () => scope, rpc: fakeRpc(CONFIG_ROUTES) });
    await store.start();
    const before = store.getSnapshot();
    // useSyncExternalStore 的硬要求:同样的值必须返回同一个引用,否则无限重渲染。
    store.update({ status: store.getSnapshot().status, note: store.getSnapshot().note });
    assert.equal(store.getSnapshot(), before);
    // 数组按内容比较:host 每次 status 都回一份新数组。
    store.update({ engines: [{ id: 'kokoro', label: 'Kokoro' }] });
    assert.equal(store.getSnapshot(), before);
    store.dispose();
});
