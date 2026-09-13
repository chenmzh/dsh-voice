/**
 * 朗读控制器:客户端侧的唯一状态源。
 *
 * 组件只通过 { getSnapshot, subscribe } 接触它(hooks compartment → useTts()),
 * 不直接调 RPC,也不自己管音频队列。
 *
 * 三条刻意为之的设计:
 *  1. **刷新页面不加载模型**。start() 只读配置。用户选过的引擎存在 localStorage,
 *     但要等第一次真的朗读时才作为 `engine` 参数下发 —— 那时才切、才加载。
 *  2. **选中 ≠ 已加载**。选择器展示的是"想用哪个",status.active 才是"显存里
 *     现在是谁"。两者不同时 UI 要如实说出来,用户才知道换模型真的卸载了旧的。
 *  3. **切句先于加载**。segments 是纯文本 RPC(不碰 GPU),所以第一句话的合成
 *     请求可以马上发出去,模型加载与用户看到"正在朗读"是并行的。
 */
import { AudioQueue } from './audio-player.js';
import { createSessionReader } from './session-text.js';
import { createTtsService, wavBlob } from './tts-service.js';

const STORAGE_ENGINE = 'dsh-voice.tts.engine';
const STORAGE_AUTO = 'dsh-voice.tts.autoRead';

/** 分组键的中文显示名(Kokoro 这类双语引擎会分组回音色)。 */
const GROUP_LABELS = { zh: '中文音色', en: '英文音色' };

/**
 * 音色的**显示**名。克隆音色的标识是参考音频的绝对路径(见 core/ref-wavs.js),
 * 直接显示会在面板里糊出一整行 ``<data-dir>/voice-refs/我的声音.wav``。
 * 只影响提示文字,state.voice 始终保留完整路径 —— 那是身份,不能动。
 */
export function voiceLabel(voice) {
    const text = String(voice ?? '');
    if (!text.includes('/') && !text.includes('\\'))
        return text;
    const base = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1);
    return base.replace(/\.(wav|flac)$/i, '') || text;
}

/**
 * 音色列表有两种形状:多数引擎回一个名字数组,而 Kokoro 是双语模型,回
 * ``{zh: [...], en: [...]}``,且它的音色标识是 ``zh=<zh>,en=<en>`` 成对串。
 *
 * 这里统一成「分组」结构,并且保证 voices 一定是数组。这不是洁癖:渲染层
 * 直接 ``voices.map``,一旦拿到对象就抛异常,而槽位渲染异常会把整块 UI 摘掉
 * —— 实测在面板里点「载入音色」后整个朗读按钮从输入框消失(Kokoro 又是默认
 * 引擎,所以人人都会踩)。未识别的形状一律退化成空列表而不是崩溃。
 */
export function normalizeVoices(raw) {
    if (Array.isArray(raw)) {
        const voices = raw.filter(item => (typeof item === 'string' && item !== '') || (item !== null && typeof item === 'object'));
        return { voices, voiceGroups: voices.length ? [{ key: null, label: null, items: voices }] : [] };
    }
    if (raw !== null && typeof raw === 'object') {
        const voiceGroups = [];
        const voices = [];
        for (const [key, list] of Object.entries(raw)) {
            if (!Array.isArray(list) || list.length === 0)
                continue;
            voiceGroups.push({ key, label: GROUP_LABELS[key] ?? key, items: list });
            voices.push(...list);
        }
        return { voices, voiceGroups };
    }
    return { voices: [], voiceGroups: [] };
}

/** 初始快照。字段全部是原始值/数组,便于 React 做引用比较。 */
function initialState() {
    return {
        started: false,
        engines: [],
        /** 用户想用的引擎(可能尚未加载)。 */
        preferred: null,
        /** 显存里真正驻留的引擎。 */
        active: null,
        status: 'idle',
        error: null,
        voice: '',
        voices: [],
        /** 分组后的音色目录(见 normalizeVoices);Kokoro 会有 zh/en 两组。 */
        voiceGroups: [],
        /** 上面这份目录属于哪个引擎 —— 换引擎时必须作废,否则渲染旧引擎的音色名。 */
        voiceEngine: null,
        voiceKind: 'preset',
        /** 参考音频目录(克隆音色的来源);面板据此告示用户"文件放哪儿"。 */
        refDir: '',
        autoRead: false,
        speaking: false,
        busy: false,
        /** 正在朗读哪条消息(用于按钮显示停止态)。 */
        speakingMessageId: null,
        note: '',
        vramUsedMb: null,
        loadSeconds: null,
        lastEvent: '',
    };
}

function readStorage(key, fallback) {
    try {
        const value = window.localStorage.getItem(key);
        return value === null ? fallback : value;
    }
    catch {
        return fallback;
    }
}

function writeStorage(key, value) {
    try {
        window.localStorage.setItem(key, value);
    }
    catch {
        /* 隐私模式下会抛,忽略即可 */
    }
}

/** 数组要按内容比较:宿主每次 status 都回一份新数组,引用比较会导致永久重渲染。 */
function valueEquals(a, b) {
    if (a === b)
        return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] === b[i])
                continue;
            if (typeof a[i] === 'object' && typeof b[i] === 'object') {
                if (JSON.stringify(a[i]) !== JSON.stringify(b[i]))
                    return false;
                continue;
            }
            return false;
        }
        return true;
    }
    return false;
}

export class TtsController {
    constructor({ rpc, sessions, log = () => { } }) {
        this.log = log;
        this.service = createTtsService(rpc);
        this.reader = createSessionReader(sessions);
        this.audio = new AudioQueue(log);
        this.state = initialState();
        this.listeners = new Set();
        this.poll = null;
        this.speechGeneration = 0;
        this.autoGeneration = 0;
        this.autoQueue = null;
        this.unbindSession = null;
        this.boundSession = undefined;
        this.disposed = false;
        this.state.autoRead = readStorage(STORAGE_AUTO, null) !== '0';
        const saved = readStorage(STORAGE_ENGINE, '');
        this.savedEngine = saved || null;
    }

    // ---- 订阅面(useSyncExternalStore 契约) ----
    subscribe = (cb) => {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    };
    getSnapshot = () => this.state;
    /** 只有真的变化才换对象引用,否则 React 会无限重渲染。 */
    update(patch) {
        let changed = false;
        for (const [key, value] of Object.entries(patch)) {
            if (!valueEquals(this.state[key], value)) {
                changed = true;
                break;
            }
        }
        if (!changed)
            return;
        this.state = { ...this.state, ...patch };
        for (const cb of this.listeners)
            cb();
    }

    // ---- 生命周期 ----
    async start() {
        if (this.state.started || this.disposed)
            return;
        this.update({ started: true });
        // 首次用户手势解锁自动播放:否则自动朗读会被浏览器拦下。
        const unlock = () => this.audio.unlock();
        document.addEventListener('pointerdown', unlock, { once: true });
        document.addEventListener('keydown', unlock, { once: true });
        await this.refreshConfig();
    }

    async refreshConfig() {
        try {
            const config = await this.service.fetchConfig();
            const engines = config.engines ?? [];
            // 引擎选择现在是**宿主侧持久化**的(设置文档里的 ttsEngine,由
            // /tts/select 与设置面板共同写):所以 host 给的就是权威值。
            // localStorage 只剩"宿主不认这个 id 时"的兜底 —— 它比宿主更旧,
            // 不能让一个陈旧的浏览器本地值盖掉刚在设置面板里改过的东西。
            const known = engines.some(e => e.id === this.savedEngine);
            const preferred = engines.some(e => e.id === config.engine)
                ? config.engine
                : (known ? this.savedEngine : engines[0]?.id ?? config.engine);
            this.savedEngine = preferred;
            this.update({
                engines,
                preferred,
                autoRead: typeof config.autoRead === 'boolean' ? config.autoRead : this.state.autoRead,
                refDir: config.refDir ?? this.state.refDir,
            });
            await this.refreshStatus();
        }
        catch (error) {
            this.log(`TTS 配置读取失败: ${String(error)}`);
            this.update({ error: `朗读服务不可用:${String(error?.message ?? error)}` });
        }
    }

    /**
     * 读一次状态快照。宿主侧是非阻塞的,加载中会返回 loading。
     * 只有处于 loading 时才起轮询,避免常态空转。
     */
    async refreshStatus() {
        try {
            const status = await this.service.status();
            // 只有显式的 null 才表示"显存里没有模型";字段缺失一律沿用旧值。
            const active = status.active === undefined ? this.state.active : status.active;
            this.update({
                engines: status.engines ?? this.state.engines,
                active,
                status: status.state ?? 'idle',
                error: status.error ?? null,
                // 同 active:字段缺失不等于"音色被清空",显式的 '' 才是。
                voice: status.voice === undefined ? this.state.voice : status.voice,
                ...this.applyVoices(status.voices, active),
                voiceKind: status.voiceKind ?? this.state.voiceKind,
                refDir: status.refDir ?? this.state.refDir,
                vramUsedMb: status.vramUsedMb ?? null,
                loadSeconds: status.loadSeconds ?? null,
                lastEvent: status.lastEvent ?? '',
            });
        }
        catch (error) {
            this.log(`TTS 状态读取失败: ${String(error)}`);
            this.update({ error: String(error?.message ?? error) });
        }
        this.schedulePoll();
        return this.state;
    }

    schedulePoll() {
        const wantPoll = this.state.status === 'loading';
        if (wantPoll && this.poll === null) {
            this.poll = setInterval(() => { void this.refreshStatus(); }, 700);
        }
        else if (!wantPoll && this.poll !== null) {
            clearInterval(this.poll);
            this.poll = null;
        }
    }

    // ---- 引擎选择 ----
    /** 用户显式点了某个引擎:立刻切(宿商会先卸载旧的),并加载新的。 */
    async select(engine) {
        if (this.disposed || !engine)
            return;
        this.savedEngine = engine;
        writeStorage(STORAGE_ENGINE, engine);
        const previous = this.state.active;
        this.update({
            preferred: engine,
            error: null,
            note: previous && previous !== engine ? '正在卸载上一个模型…' : '正在加载…',
        });
        try {
            const status = await this.service.select(engine);
            this.applyStatus(status);
        }
        catch (error) {
            this.update({ error: `切换失败:${String(error?.message ?? error)}` });
        }
    }

    async unload() {
        if (this.disposed)
            return;
        this.update({ note: '正在卸载…' });
        try {
            const status = await this.service.unload();
            this.applyStatus(status);
            this.update({ note: status.lastEvent || '已卸载' });
        }
        catch (error) {
            this.update({ error: `卸载失败:${String(error?.message ?? error)}` });
        }
    }

    /**
     * 把宿主回的 voices 载荷翻译成状态补丁。
     *
     * 关键规则:**载荷没带列表时保留已有分组,不要清空**。宿主有好几条路径不发
     * 音色列表(worker 的 setVoice 就只回 voice),早期版本在这里无条件覆盖,于是
     * 「选完音色 → 下一次 status 轮询」把分组打回单个占位选择框,用户看起来就是
     * 刚配的人声丢了。
     *
     * 唯一必须清空的情况是**引擎真的换了**(含被卸载,active 变 null):旧引擎的
     * 音色名对新引擎没有意义。
     *
     * 同理,`active` 缺失(undefined)时沿用旧值而不是当成 null —— 否则一份不完整
     * 的快照就会被误读成"模型已经卸载",顺手把音色目录也清了。显式的 null 才表示
     * 显存里真的没有模型。
     */
    applyVoices(rawVoices, activeEngine) {
        const nextEngine = activeEngine ?? null;
        const engineChanged = nextEngine !== (this.state.voiceEngine ?? null);
        const normalized = normalizeVoices(rawVoices);
        if (normalized.voiceGroups.length)
            return { ...normalized, voiceEngine: nextEngine };
        if (engineChanged)
            return { voices: [], voiceGroups: [], voiceEngine: nextEngine };
        return {};
    }

    applyStatus(status) {
        const active = status.active === undefined ? this.state.active : status.active;
        this.update({
            engines: status.engines ?? this.state.engines,
            active,
            status: status.state ?? 'idle',
            error: status.error ?? null,
            voice: status.voice ?? this.state.voice,
            ...this.applyVoices(status.voices, active),
            voiceKind: status.voiceKind ?? this.state.voiceKind,
            refDir: status.refDir ?? this.state.refDir,
            vramUsedMb: status.vramUsedMb ?? null,
            loadSeconds: status.loadSeconds ?? null,
            lastEvent: status.lastEvent || this.state.lastEvent,
            note: status.lastEvent || this.state.note,
        });
        this.schedulePoll();
    }

    // ---- 音色(人声配置)----
    setAutoRead(enabled) {
        if (!enabled) this.autoGeneration++;
        this.update({ autoRead: enabled });
        writeStorage(STORAGE_AUTO, enabled ? '1' : '0');
    }

    async setVoice(voice) {
        if (this.disposed || !voice)
            return;
        this.update({ note: '正在应用音色…' });
        try {
            const result = await this.service.setVoice(voice);
            this.update({
                voice: result.voice ?? voice,
                ...this.applyVoices(result.voices, this.state.active),
                note: `音色:${voiceLabel(result.voice ?? voice)}`,
            });
        }
        catch (error) {
            this.update({ error: `音色设置失败:${String(error?.message ?? error)}` });
        }
    }

    /** 载入音色列表(会按需加载引擎,所以只在用户展开音色面板时调)。 */
    async loadVoices(engine) {
        try {
            const result = await this.service.voices(engine);
            const active = result.engine ?? this.state.active;
            this.update({
                ...this.applyVoices(result.voices, active),
                voice: result.voice ?? this.state.voice,
                active,
            });
            // 「载入音色」会把模型真的装进显存,但上面这个响应里没有显存数字 ——
            // 不补一次状态快照的话,面板会一直显示上一次读到的旧值(实测出现过
            // "整卡已用显存:2 MB · 驻留:Kokoro-82M",用户据此以为没占显存)。
            await this.refreshStatus();
            this.schedulePoll();
        }
        catch (error) {
            this.update({ error: `音色列表读取失败:${String(error?.message ?? error)}` });
        }
    }

    // ---- 朗读 ----
    /** 会话切换时重绑自动朗读。 */
    bindSession(sessionId) {
        if (this.disposed || sessionId === this.boundSession)
            return;
        this.autoGeneration++;
        this.boundSession = sessionId;
        this.unbindSession?.();
        this.unbindSession = null;
        if (sessionId === undefined)
            return;
        this.unbindSession = this.reader.onAssistantMessage(sessionId, ({ messageId, text }) => {
            if (!this.state.autoRead || this.disposed)
                return;
            const queuedGeneration = this.autoGeneration;
            const read = async () => {
                // A new automatic reply must also wait for a manually selected passage.
                if (this.state.busy || this.state.speaking) {
                    await new Promise(resolve => {
                        const unsubscribe = this.subscribe(() => {
                            if (this.disposed || queuedGeneration !== this.autoGeneration || (!this.state.busy && !this.state.speaking)) {
                                unsubscribe();
                                resolve();
                            }
                        });
                    });
                }
                if (queuedGeneration !== this.autoGeneration || !this.state.autoRead || this.disposed) return;
                return this.speakText(text, { engine: this.savedEngine ?? undefined, messageId, automatic: true });
            };
            this.autoQueue = (this.autoQueue ? this.autoQueue.then(read) : read()).catch(error => this.log(String(error)));
        });
    }

    /** 点某条消息的朗读按钮。 */
    async speakMessage(sessionId, messageId) {
        // 正在读这条 → 再点就是停止。
        if (this.state.speakingMessageId === messageId && (this.state.speaking || this.state.busy)) {
            this.stop();
            return;
        }
        const text = this.reader.assistantText(sessionId, messageId);
        if (!text.trim()) {
            this.update({ error: '这条回复没有可朗读的文本' });
            return;
        }
        await this.speakText(text, { engine: this.savedEngine ?? undefined, messageId });
    }

    /**
     * 主流程:切句 → 逐句合成 → 顺序播放。
     * 每一句合成后立刻入队,所以第一句在整段合成完之前就响了。
     */
    async speakText(text, { engine, messageId = null, plainText = false, automatic = false } = {}) {
        if (this.disposed)
            return;
        const content = String(text ?? '');
        if (!content.trim()) {
            this.update({ error: '没有可朗读的文本' });
            return;
        }
        if (!automatic) this.autoGeneration++;
        const generation = ++this.speechGeneration;
        this.audio.stop();
        this.audio.unlock();
        const target = engine ?? this.state.preferred ?? undefined;
        this.update({ busy: true, error: null, note: '正在准备文本…', speaking: false, speakingMessageId: messageId });
        /** 朗读可能顺手把模型装进显存;装了就补一次状态快照,面板的显存数字才是真的。 */
        let engineChanged = false;
        /** 单句失败记账:失败不能中断朗读,但必须让用户看见。 */
        const failed = [];
        let spoken = 0;
        try {
            const prepared = await this.service.segments(content, target, plainText ? { markdown: false } : {});
            if (generation !== this.speechGeneration)
                return;
            const segments = prepared.segments ?? [];
            if (segments.length === 0) {
                this.update({ busy: false, speakingMessageId: null, note: '没有可朗读的内容' });
                return;
            }
            const label = this.state.engines.find(e => e.id === (target ?? this.state.preferred))?.label ?? (target ?? '');
            this.update({
                note: prepared.degraded
                    ? `${label}:文本预处理降级,仍将朗读 ${segments.length} 句`
                    : `${label}:共 ${segments.length} 句,正在合成第 1 句…`,
            });
            // 第一句要顺带承担模型加载(可能 20s+),后面每句就快了。
            this.update({ note: this.state.active && this.state.active === target
                ? `${label}:共 ${segments.length} 句`
                : `${label}:首次朗读需要加载模型,可能要几十秒…` });
            for (let i = 0; i < segments.length; i++) {
                if (generation !== this.speechGeneration)
                    return;
                // Decorative symbols alone have no spoken words; never send them to the model.
                if (!/[\p{L}\p{N}]/u.test(segments[i])) continue;
                this.update({ note: `${label}:正在合成第 ${i + 1}/${segments.length} 句…` });
                // 单句合成失败**绝不能**中断整段朗读。以前这里直接把异常抛给外层
                // catch,于是"某一句合成不出来"表现成"读到一半就停了" —— 用户听到的
                // 就是回复后半截永远不响(CosyVoice 对纯标点碎片报
                // "produced no audio chunks" 就是这么暴露的)。这里重试一次,
                // 仍失败就记账跳过,继续合成后面的句子。
                let result = null;
                let lastError = null;
                for (let attempt = 0; attempt < 2 && result === null; attempt++) {
                    try {
                        result = await this.service.speak(segments[i], { ...(target ? { engine: target } : {}), prepared: plainText || !prepared.degraded });
                        if (!result?.wav && /[\p{L}\p{N}]/u.test(segments[i])) {
                            const reason = result?.skipped ?? '没有返回音频';
                            result = null;
                            throw new Error(reason);
                        }
                    }
                    catch (error) {
                        lastError = error;
                        if (generation !== this.speechGeneration)
                            return;
                    }
                }
                // 合成是异步的,用户完全可能在这一句还没合成完时就点了小喇叭。
                // stop() 只自增 generation 并清空播放队列,它**取消不了**这句已经
                // 发出去的 RPC —— 模型加载时那句要等几十秒,用户的"过了一段时间
                // 又自己读起来"就是它。所以结果回来时必须重新确认自己还是"当前
                // 这一轮":否则这一句会在用户已经停止之后被入队,而 AudioQueue
                // 见 playing 已是 false,又会重新 drain 把它放出来。
                if (generation !== this.speechGeneration)
                    return;
                if (result === null) {
                    failed.push({ index: i + 1, text: segments[i], error: String(lastError?.message ?? lastError) });
                    this.log(`TTS 第 ${i + 1}/${segments.length} 句合成失败,跳过: ${String(lastError?.message ?? lastError)}`);
                    continue;
                }
                if (result.skipped) {
                    this.log(`TTS 跳过第 ${i + 1} 句: ${result.skipped}`);
                    continue;
                }
                if (result.wav) {
                    spoken++;
                    this.audio.enqueue(wavBlob(result.wav, result.mime));
                    if (result.engine && result.engine !== this.state.active)
                        engineChanged = true;
                    this.update({
                        speaking: true,
                        active: result.engine ?? this.state.active,
                        note: `${label}:正在朗读第 ${i + 1}/${segments.length} 句`,
                    });
                    // 第一句往往就是"加载模型"那句;这里补一次快照,面板上的
                    // 显存/驻留状态立刻是真的,而不是等下一次轮询(ready 后根本不轮询)。
                    if (engineChanged) {
                        engineChanged = false;
                        await this.refreshStatus();
                    }
                }
            }
            if (generation === this.speechGeneration) {
                await this.audio.waitUntilIdle?.();
                if (generation !== this.speechGeneration) return;
                await this.refreshStatus();
                if (generation !== this.speechGeneration) return;
                // 有句子失败必须说出来,否则用户只看到"读到一半就停了"却无从判断。
                if (failed.length > 0 && spoken === 0) {
                    this.update({ note: '', busy: false, speaking: false, speakingMessageId: null,
                        error: `${label}:${segments.length} 句全部合成失败(${failed[0].error})` });
                }
                else if (failed.length > 0) {
                    this.update({ note: `${label}:朗读完成,${failed.length} 句合成失败已跳过(第 ${failed.map(f => f.index).join('、')} 句)`,
                        error: null, busy: false, speaking: false, speakingMessageId: null });
                }
                else {
                    this.update({ note: '朗读完成', busy: false, speaking: false, speakingMessageId: null });
                }
            }
        }
        catch (error) {
            if (generation !== this.speechGeneration)
                return;
            this.log(`TTS 朗读失败: ${String(error)}`);
            this.update({ busy: false, speaking: false, speakingMessageId: null, error: `朗读失败:${String(error?.message ?? error)}`, note: '' });
        }
    }

    /** 停止朗读(不卸载模型)。 */
    stop() {
        this.autoGeneration++;
        this.speechGeneration++;
        this.audio.stop();
        this.update({ speaking: false, busy: false, speakingMessageId: null, note: '已停止' });
    }

    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.speechGeneration++;
        this.autoGeneration++;
        this.unbindSession?.();
        if (this.poll !== null) {
            clearInterval(this.poll);
            this.poll = null;
        }
        this.audio.dispose();
        this.update({ busy: false, speaking: false, speakingMessageId: null });
        this.listeners.clear();
    }
}
