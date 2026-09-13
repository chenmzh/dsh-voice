import { resolveEngine } from './core/engine.js';
import { HostAsr } from './core/host-asr.js';
import { OnnxModel } from './core/native-asr.js';
import { PythonAsr } from './core/python-asr.js';
import { rpcError, VOICE_CHANNEL, VOICE_ENDPOINTS, TTS_CHANNEL, TTS_ENDPOINTS } from './core/wire.js';
import { TtsManager } from './core/tts-manager.js';
import { backendLanguage, asrLanguageOptions } from './core/asr-languages.js';
import { instructLanguageOptions } from './core/tts-instruct.js';
import { deleteRefWav, listRefWavs, readRefText, saveRefWav } from './core/ref-wavs.js';
import { VoiceSettingsSchema, VOICE_NAMESPACE } from './core/settings-schema.js';
import { isTtsEngine } from './core/tts-engines.js';
export const name = 'dsh-voice-host';
export const inject = ['connection', 'webServer'];
/**
 * host 半的 Config **就是**设置命名空间的 schema(见 core/settings-schema.js)。
 * 一个对象兼两职,是为了让"行内 config 能填什么"和"设置面板能改什么"
 * 永远不可能漂移 —— 两处各写一份 schema 是这类插件最经典的坏法。
 */
export const Config = VoiceSettingsSchema;

/**
 * 改了这些设置就得重建 ASR 子进程:它们全部进了 worker 的启动参数
 * (--backend / --model / --device)或解释器选择,热更新没有意义。
 * 语言**不**在这一类里 —— 它是逐请求传的,改完下一句录音就生效。
 */
const ASR_PROCESS_KEYS = [
    'nativeBackend', 'pythonExecutable', 'asrDevice',
    'qwenModelDir', 'whisperModelDir', 'pythonModelDir', 'modelDir', 'asrDir',
];

export function apply(ctx, config, deps = {}) {
    const logger = ctx.logger;
    // ---- 唯一的配置来源 ----------------------------------------------------
    // 没装 settings provider 时 source 永远是 `() => config`,也就是行内
    // cordis.patch.yml 那一份 —— 插件在两种部署下都照常工作。
    let resolved = config;
    let source = () => resolved;
    /** 设置作用域(仅当 provider 在位);写回用户层要用它。 */
    let scope = null;
    /**
     * 注册命名空间失败的原因(设置文档里的 voice 段有非法值就会走到这里)。
     * 空表示一切正常。下发给面板,让用户知道该去修文件里的哪一项。
     */
    let settingsError = '';
    /** 已经应用过的 ASR 相关设置,用于 diff 出"要不要重建子进程"。 */
    let appliedAsr = { ...config };
    const current = () => source();

    // ---- 语音输入(STT)----------------------------------------------------
    let model = null;
    /** 当前这一代 PythonAsr(settings 改了会换新的一代)。 */
    let python = null;
    let hostAsr = null;
    let loading = null;
    /**
     * 代际号。ensureReady 里发起的加载会记住当时的代际,回来时若已经过期
     * 就把结果丢掉 —— 否则一个在飞的 ensureReady 会把**已经 dispose 的**
     * 旧资源当成 ready 交给调用方,而旧进程已经死了。
     */
    let asrGen = 0;
    let disposed = false;
    const makePython = () => {
        const settings = current();
        return settings.nativeBackend === 'qwen' || settings.nativeBackend === 'whisper'
            ? new PythonAsr(settings, message => logger.warn('ASR worker: %s', message)) : null;
    };
    python = makePython();
    ctx.effect(() => () => {
        disposed = true;
        asrGen += 1;
        python?.dispose();
        python = null;
    }, 'dsh-voice: private ASR worker');
    const loadModel = deps.loadModel ?? (async () => {
        // Check the actual child on EVERY start; never cache a dead PythonAsr as ready.
        if (python) return python.start();
        const settings = current();
        if (!settings.modelDir?.trim()) throw new Error('未配置本地语音模型目录');
        if (model !== null) return model;
        const candidate = new OnnxModel(settings);
        await candidate.start();
        model = candidate;
        return model;
    });
    const ensureReady = () => {
        if (disposed) return Promise.reject(new Error('语音插件已关闭'));
        if (loading !== null) return loading;
        const gen = asrGen;
        const flight = Promise.resolve().then(loadModel).then(resource => {
            if (disposed) throw new Error('语音插件已关闭');
            if (gen !== asrGen) throw new Error('语音识别设置刚被改动，请重新点击麦克风');
            if (resource === null) throw new Error('本地语音模型不可用');
            return resource;
        });
        loading = flight;
        // 两个分支都要清,但只能在"还是我这一趟"时清:期间若发生过重建,
        // 新的一趟已经在跑,这里清掉会把它的并发折叠破坏掉。
        const done = () => { if (loading === flight) loading = null; };
        flight.then(done, done);
        return flight;
    };
    /**
     * 设置里影响子进程的字段变了:换代。
     * 旧进程立刻 dispose(它的 PCM 会话状态本来就在 host 侧,不在 worker 里)。
     */
    const rebuildAsr = () => {
        asrGen += 1;
        loading = null;
        model = null;
        hostAsr = null;
        const old = python;
        python = null;
        try {
            old?.dispose();
        }
        catch (error) {
            logger.warn('ASR worker 关闭异常: %s', String(error));
        }
        python = makePython();
        logger.info('语音识别设置已改变，子进程已重建（backend=%s）', current().nativeBackend);
    };
    // No eager kick: opening/refreshing the page must not load model weights.
    ctx.effect(() => ctx.connection.rpc.handle(VOICE_CHANNEL, async (endpoint, payload) => {
        switch (endpoint) {
            case VOICE_ENDPOINTS.config:
                return { ok: true, value: {
                    engine: current().engine,
                    hotkey: current().hotkey,
                    backend: current().nativeBackend ?? 'zipformer',
                    // 语言表随配置一起下发:客户端不必自己维护一份 ISO 码表,
                    // 也不会出现"面板里有、host 不认"的取值。
                    languages: asrLanguageOptions(),
                    // 朗读语言指令表同理:host 是唯一一份,面板不自己维护。
                    instructLanguages: instructLanguageOptions(),
                    asrLanguage: current().asrLanguage,
                    asrDevice: current().asrDevice,
                    // 全部引擎(不受"显示哪些引擎"过滤):设置面板要用它渲染那份
                    // 勾选框 —— 只列可见的话,取消勾选之后就再也勾不回来了。
                    ttsEngines: tts.catalog(false),
                    // 完整解析后的设置。设置面板优先用 settingsScope 读(那是
                    // 权威且能标出"哪项被你改过"),但 provider 不在位时它会是
                    // unavailable —— 这条路径保证面板在任何部署下都能显示。
                    settings: current(),
                    // 注册命名空间失败的原因(非空 = 用户文档里的 voice 段有非法
                    // 值)。面板要把它显示出来,否则用户不知道去哪里改。
                    settingsError,
                } };
            case VOICE_ENDPOINTS.ping: {
                // Mic-click handshake: resolve only when the selected model is ready.
                if (current().engine === 'browser') return { ok: true, value: { engine: 'browser' } };
                try {
                    await ensureReady();
                    return { ok: true, value: { engine: 'native' } };
                } catch (err) {
                    logger.warn('native ASR 初始化失败: %s', String(err));
                    if (resolveEngine(current().engine, false) === 'browser')
                        return { ok: true, value: { engine: 'browser' } };
                    return rpcError('native_unavailable', '语音模型启动失败，请再次点击麦克风重试：' + String(err));
                }
            }
            case VOICE_ENDPOINTS.asr: {
                if (current().engine === 'browser') return rpcError('native_unavailable', 'native ASR 未启用');
                try {
                    // Python buffers chunks without loading again. Its final transcribe()
                    // rechecks liveness, also supporting clients predating the handshake.
                    if (python) {
                        // 语言由 host 决定,不接受客户端传(客户端可以不知道这张表)。
                        // 翻成该后端认的写法:qwen 要 'German',whisper 要 'de'。
                        const settings = current();
                        const language = backendLanguage(settings.asrLanguage, settings.nativeBackend);
                        // 自动检测 / 该后端没有语言参数时是 null:那种情况**不传这个
                        // 字段**,而不是传一个 null。worker 把"字段缺失"当自动检测,
                        // 两种写法的区别在于"后端收到了一个它不认识的语言参数"。
                        return await python.handle(language === null
                            ? payload
                            : { ...payload, language });
                    }
                    const resource = await ensureReady();
                    if (hostAsr === null)
                        hostAsr = new HostAsr({ log: msg => logger.warn('native ASR %s', msg) });
                    return hostAsr.handle(resource, payload);
                } catch (err) {
                    return rpcError('native_unavailable', String(err));
                }
            }
            default:
                return rpcError('unknown_endpoint', 'unknown endpoint: ' + endpoint);
        }
    }, { authority: 'loopback' }), 'dsh-voice: /voice rpc channel');
    // ---- 朗读(TTS)----
    // 独立通道。管理器只在第一次真的要朗读时才加载模型,所以刷新页面、
    // 打开页面都不会占显存;换引擎时旧进程会被真的卸载(见 tts-manager.js)。
    const initial = current();
    const tts = deps.ttsManager ?? new TtsManager({
        ttsRoot: initial.ttsRoot,
        modelsRoot: initial.ttsModelsRoot,
        engine: initial.ttsEngine,
        device: initial.ttsDevice,
        textnormPath: initial.ttsTextnormPath,
        textPrepPython: initial.ttsPrepPython,
        refDir: initial.ttsRefDir,
        voices: initial.ttsVoice,
        visibleEngines: initial.ttsVisibleEngines,
    }, message => logger.warn('TTS %s', message));
    ctx.effect(() => () => {
        void tts.dispose();
    }, 'dsh-voice: resident TTS engine');
    /**
     * 把当前解析后的设置推进去。
     * 幂等,而且只做 diff —— onChange 在 attach/detach/每一次提交都会调,
     * 不能每次都让 TTS 重新加载模型。
     */
    const applySettings = () => {
        const settings = current();
        if (ASR_PROCESS_KEYS.some(key => appliedAsr[key] !== settings[key])) {
            appliedAsr = { ...settings };
            rebuildAsr();
        }
        else {
            appliedAsr = { ...settings };
        }
        tts.applySettings(settings);
    };
    // ---- 设置命名空间 ------------------------------------------------------
    // 直接在 provider 上注册 `voice` 命名空间,并把行内 config 声明成 **base**
    // 层。三层解析因此是:schema 默认值 → cordis.patch.yml 那一行 → 用户层。
    // 于是现有部署一行 yml 都不用改,面板里改的值覆盖在它上面,清掉又退回它。
    //
    // 为什么不用 installSection:它的语义一样,但不把 scope 句柄交出来,而我们要
    // 写回用户层(/tts/select、/tts/setVoice 的持久化)和监听变化,所以自己
    // register 更直接。provider 不在位时 ctx.inject 的回调根本不会跑,
    // source 保持 `() => config` —— 这就是 installSection 承诺的那条回退路径。
    ctx.inject(['settings'], settingsCtx => {
        settingsCtx.effect(() => {
            let registration;
            try {
                registration = settingsCtx.settings.register(VOICE_NAMESPACE, VoiceSettingsSchema, {
                    base: config,
                    // 改完立刻生效:host 自己负责重建子进程/重配管理器,不需要重启。
                    applies: 'live',
                });
            }
            catch (error) {
                // schema 校验不过(设置文档被手改坏了)会让注册直接抛。这不是
                // 致命错误:插件继续用行内 config 工作,只是面板里没有可写的
                // 设置文档。但**必须让用户看见原因** —— 否则他只会看到"设置面板
                // 是灰的、我改的值没生效",而文件里那行错字无从查起。
                settingsError = String(error?.message ?? error);
                logger.warn('语音设置命名空间注册失败,继续用行内配置: %s', settingsError);
                return () => {};
            }
            settingsError = '';
            scope = registration;
            source = () => registration.get();
            const stop = registration.watch(() => applySettings());
            // attach 时也要应用一次:这一次才把设置里的可见引擎/音色偏好
            // 真正推进管理器(构造参数只覆盖了第一版快照)。
            applySettings();
            logger.info('语音设置已挂到设置面板（命名空间 %s）', VOICE_NAMESPACE);
            return () => {
                stop();
                scope = null;
                // provider 走了:退回行内 config,并把变化重新应用一遍,
                // 免得管理器停在用户层那份已经无人负责的值上。
                source = () => resolved;
                applySettings();
            };
        }, 'dsh-voice: settings namespace');
    });
    /**
     * 把用户的选择写回用户层(设置文档),失败只记日志。
     * 这是"朗读面板里选的引擎/音色,在设置面板和重启后仍然是对的"的来源。
     */
    const persist = patch => {
        if (scope === null) return;
        scope.update(patch).catch(error => logger.warn('语音设置写回失败: %s', String(error)));
    };
    /** 参考音频目录里现在有什么(面板的克隆音色列表用)。 */
    const refList = () => listRefWavs(tts.refDir).map(item => ({
        id: item.id,
        label: item.label,
        text: readRefText(tts.refDir, item.label),
    }));
    ctx.effect(() => ctx.connection.rpc.handle(TTS_CHANNEL, async (endpoint, payload) => {
        try {
            switch (endpoint) {
                case TTS_ENDPOINTS.config:
                    return { ok: true, value: {
                        engine: tts.desired,
                        // 缺省视为开启:与 mic 分支同样对"配置里没写"做防御。
                        autoRead: current().ttsAutoRead !== false,
                        // 面板要能立刻告诉用户"参考音频放哪儿",所以这条不走
                        // status(它不该为了显示一行提示去加载模型)。
                        refDir: tts.refDir,
                        engines: tts.catalog(),
                        // 参考音频目录很小,扫一次就是几次 readdir/stat;
                        // 附在这里省掉一次往返,也让面板一打开就有内容。
                        refs: refList(),
                    } };
                case TTS_ENDPOINTS.refs:
                    // 纯目录列举,不碰模型(见 wire.js 的说明)。
                    return { ok: true, value: { refs: refList(), refDir: tts.refDir } };
                case TTS_ENDPOINTS.status:
                    // 纯读快照,绝不等待加载 —— 客户端靠轮询它显示进度。
                    return { ok: true, value: await tts.status() };
                case TTS_ENDPOINTS.select: {
                    const id = payload?.engine;
                    if (!isTtsEngine(id))
                        return rpcError('bad_engine', `未知 TTS 引擎: ${String(id)}`);
                    const value = await tts.select(id);
                    // 面板里的选择是持久的:写进用户层,下次打开还是它。
                    persist({ ttsEngine: id });
                    return { ok: true, value };
                }
                case TTS_ENDPOINTS.unload:
                    return { ok: true, value: await tts.unload() };
                case TTS_ENDPOINTS.segments:
                    // 纯文本工作:不加载模型,客户端因此能马上拿到句子列表。
                    // engine 可与当前选择不同(客户端可能还没真正切换)。
                    return { ok: true, value: await tts.segments(payload?.text, payload?.engine, { markdown: payload?.markdown }) };
                case TTS_ENDPOINTS.voices: {
                    if (payload?.engine && payload.engine !== tts.desired)
                        await tts.select(payload.engine);
                    return { ok: true, value: await tts.listVoices() };
                }
                case TTS_ENDPOINTS.setVoice: {
                    const voice = String(payload?.voice ?? '');
                    if (!voice)
                        return rpcError('bad_voice', '音色名为空');
                    const value = await tts.setVoice(voice);
                    // 逐引擎记:音色标识不通用(Kokoro 是预置名,克隆引擎是路径)。
                    persist({ ttsVoice: { ...tts.preferredVoices, [value.engine]: value.voice } });
                    return { ok: true, value };
                }
                case TTS_ENDPOINTS.saveRef: {
                    const name = String(payload?.name ?? '');
                    const audio = typeof payload?.audio === 'string' ? Buffer.from(payload.audio, 'base64') : null;
                    if (audio === null || audio.length === 0)
                        return rpcError('bad_ref', '没有收到音频内容');
                    if (audio.length > 32 * 1024 * 1024)
                        return rpcError('bad_ref', '参考音频过大（上限 32MB）');
                    const saved = saveRefWav(tts.refDir, name, audio, payload?.ext ?? '.wav', String(payload?.text ?? ''));
                    // 存完不等用户再点一次「载入音色」:直接把新列表回给他。
                    return { ok: true, value: { saved, refs: refList(), refDir: tts.refDir } };
                }
                case TTS_ENDPOINTS.deleteRef: {
                    const removed = deleteRefWav(tts.refDir, String(payload?.name ?? ''));
                    // 删掉的可能正是当前音色:worker 记的是一个已经不存在的路径,
                    // 下一次朗读会失败。这里顺手把偏好清掉,让它退回引擎默认。
                    const gone = Object.entries(tts.preferredVoices)
                        .filter(([, voice]) => typeof voice === 'string' && voice.includes(removed.id))
                        .map(([engine]) => engine);
                    if (gone.length > 0) {
                        const next = { ...tts.preferredVoices };
                        for (const engine of gone) delete next[engine];
                        tts.preferredVoices = next;
                        persist({ ttsVoice: next });
                    }
                    return { ok: true, value: { ...removed, refs: refList(), refDir: tts.refDir } };
                }
                case TTS_ENDPOINTS.speak: {
                    const result = await tts.speak({
                        text: payload?.text,
                        prepared: payload?.prepared === true,
                        voice: payload?.voice,
                        engine: payload?.engine,
                    });
                    if (!result.wav)
                        return { ok: true, value: { skipped: result.skipped ?? 'empty', engine: result.engine } };
                    return { ok: true, value: {
                        // 直接回 16bit PCM WAV 的 base64:客户端 Blob 之后交给 <audio>。
                        wav: result.wav.toString('base64'),
                        mime: 'audio/wav',
                        sampleRate: result.sampleRate,
                        audioSeconds: result.audioSeconds,
                        synthSeconds: result.synthSeconds,
                        wallSeconds: result.wallSeconds,
                        voice: result.voice,
                        engine: result.engine,
                    } };
                }
                default:
                    return rpcError('unknown_endpoint', 'unknown endpoint: ' + endpoint);
            }
        }
        catch (err) {
            logger.warn('TTS %s 失败: %s', endpoint, String(err));
            return rpcError('tts_failed', String(err?.message ?? err));
        }
    }, { authority: 'loopback' }), 'dsh-voice: /tts rpc channel');
    // 设置面板里改了任何一项都会走到 applySettings(见上面的 watch)。
    // 这里再调一次:provider 不在位时上面的 effect 不会跑,而构造参数只
    // 覆盖了第一版快照,管理器仍然需要一次"对齐到当前设置"。
    applySettings();
}
