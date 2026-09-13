/**
 * 多引擎 TTS 管理器:同一时刻只允许一个引擎驻留显存。
 *
 * 用户的核心要求是"换模型的时候旧的要卸载"。这里把它实现成一条硬规则:
 *   current.id !== desired  →  先 await 旧进程真正退出(CUDA context 随进程消失),
 *                              再拉起新进程。
 * 顺序绝不能反过来 —— 先加载新的会让两个模型同时占显存,IndexTTS(7GB)+
 * CosyVoice3(3.7GB)在 16GB 卡上叠加就会 OOM。
 *
 * 状态机(所有迁移都过同一条串行队列,避免并发点击把进程搞乱):
 *   idle → loading → ready | error
 * 加载很慢(CosyVoice3 / IndexTTS 各 ~24s,总共可能 40s+),所以 select()
 * 立即返回、后台加载,由客户端轮询 status() —— 不让 RPC 挂在加载上。
 *   desired 用"最后一次点击生效":加载途中再点别的引擎,加载完会继续切过去。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PythonTts } from './python-tts.js';
import { prepareSegments } from './text-prep.js';
import { listRefWavs, resolveRefDir, withRefVoices } from './ref-wavs.js';
import { isTtsEngine, normalizeVisibleEngines, resolveEngineSpec, TTS_ENGINES } from './tts-engines.js';
import { buildInstruct } from './tts-instruct.js';

/** 默认引擎:最快、最省显存、原生数字正确,适合"朗读回复"这种高频短文本。 */
export const DEFAULT_ENGINE = 'kokoro';

/**
 * 一份 voices 载荷到底有没有带音色列表。
 *
 * 两种合法形状:多数引擎是名字数组;Kokoro 是双语模型,回 ``{zh:[...],en:[...]}``。
 * 空数组/空对象/undefined 一律算"没带" —— 这很关键,因为 worker 的 setVoice 就
 * 不回声列表,而 `?? []` 这种兜底会把"没带"伪装成"列表是空的",于是切一次音色
 * 就把整份音色目录清了(status 轮询随后让选择器退回占位)。
 */
export function hasVoices(value) {
    if (Array.isArray(value))
        return value.length > 0;
    if (value !== null && typeof value === 'object')
        return Object.values(value).some(list => Array.isArray(list) && list.length > 0);
    return false;
}

export class TtsManager {
    /** @param options - ttsRoot/modelsRoot/engine 覆盖;deps 是测试接缝。 */
    constructor({ ttsRoot, modelsRoot, engine = DEFAULT_ENGINE, device = 'cuda', textnormPath, textPrepPython, refDir, voices, visibleEngines, prep } = {}, log = () => {}, deps = {}) {
        this.ttsRoot = ttsRoot;
        this.modelsRoot = modelsRoot;
        this.device = device;
        this.log = log;
        this.deps = deps;
        this.createProc = deps.createProc ?? (spec => new PythonTts(spec, log, deps.procDeps ?? {}));
        this.queryVram = deps.queryVram ?? (() => queryGpuMemoryUsed());
        this.exists = deps.exists ?? existsSync;
        /**
         * 参考音频目录:克隆引擎的"自配音色"就住在这里(见 ref-wavs.js)。
         * 每次列音色都重新扫一遍 —— 用户放完文件不需要重启任何东西。
         * 所以这里存的是"目录"而不是"列表":listRefs 在调用时才读 this.refDir,
         * 设置面板改了目录之后下一次列举就是新目录。
         */
        this.refDir = resolveRefDir(refDir);
        this.listRefs = deps.listRefs ?? (() => listRefWavs(this.refDir));
        /**
         * 文本预处理的路径放在 this 上,而不是闭包捕获:applySettings 要能改它们。
         * 这两个值以前是被 ensurePrep 解析成绝对路径的,靠的是"每次调用都重新解析"
         * (见 text-prep.js 的 resolvePrep),所以改完立刻生效。
         */
        this.textnormPath = textnormPath;
        this.textPrepPython = textPrepPython;
        /** 文本预处理接缝:测试里换掉它就不必起 python。 */
        this.segment = deps.segment ?? ((text, options) => prepareSegments(text, {
            ...options,
            textnormPath: options.textnormPath ?? this.textnormPath,
            python: options.python ?? this.textPrepPython,
        }));
        /**
         * 逐引擎记住用户选的音色(设置文档里的 ttsVoice)。
         * 音色标识不通用:Kokoro 是 "zh=zf_001,en=af_heart",克隆引擎是绝对路径,
         * 所以必须按引擎分开存。加载完引擎时优先用它,而不是 spec.defaultVoice。
         */
        this.preferredVoices = voices !== null && typeof voices === 'object' && !Array.isArray(voices)
            ? { ...voices } : {};
        /**
         * 面板里显示哪些引擎(设置项 ttsVisibleEngines)。构造时先给全集,
         * host 会在 installSection 的首次 onChange 里用真实设置覆盖它。
         */
        this.visibleEngines = normalizeVisibleEngines(visibleEngines);
        /** 设置里的引擎偏好(与 desired 分开:desired 是"实际要加载的")。 */
        this.settingsEngine = isTtsEngine(engine) ? engine : DEFAULT_ENGINE;
        /** 置位后下一次 reconcile 会先卸载再加载,用于"路径变了但引擎没变"。 */
        this.forceReload = false;
        /** 用户选择的引擎(可能还在加载)。 */
        this.desired = isTtsEngine(engine) ? engine : DEFAULT_ENGINE;
        /** 当前真正驻留的引擎。 */
        this.current = null;
        /** 'idle' | 'loading' | 'ready' | 'error' */
        this.state = 'idle';
        this.error = null;
        this.loadSeconds = null;
        this.voices = [];
        this.voice = '';
        /**
         * 当前生效的 CosyVoice3 朗读指令(见 tts-instruct.js)。null = 不带指令,
         * 走原来的缓存音色快路径。这是**热字段**:它只影响每次请求的载荷,
         * 改它绝不该重载模型。
         */
        this.instruct = null;
        this.lastEvent = '';
        this.vramUsedMb = null;
        this.disposed = false;
        /** 串行队列:保证"卸载旧 → 加载新"不会被并发请求穿插。 */
        this.queue = Promise.resolve();
    }

    /** 引擎描述(含绝对路径)。 */
    spec(id) {
        return resolveEngineSpec(id, { ttsRoot: this.ttsRoot, modelsRoot: this.modelsRoot });
    }

    /**
     * 把设置面板里的新值应用到**已经在跑**的这个管理器上。
     *
     * 分两类处理,因为代价差好几个数量级:
     *   - 热替换字段(路径、参考音频目录、可见引擎、音色偏好)直接改,下次
     *     调用就生效 —— 改个参考音频目录绝不该让 CosyVoice3 白重载 24 秒。
     *   - 影响子进程的字段(引擎、安装根目录、模型根目录、设备)必须真的换
     *     进程,交给 select()/forceReload 走它那套"先卸载旧进程再加载新进程"
     *     的显存安全路径。
     *
     * @param next - 解析后的完整 voice 设置。
     */
    applySettings(next = {}) {
        if (this.disposed)
            return;
        // 与"上一份设置快照"比是不可靠的:第一次调用的上一份快照并不存在,
        // 而那恰好就是启动路径。直接和**当前存活状态**比,才能同时满足两条
        // 都需要的性质:
        //   - 启动时还没有任何进程,不该因为设置刷新就把 24s 的模型拉进显存;
        //   - 引擎已经驻留时(用户改了安装根目录/设备)必须真的换进程,否则
        //     新路径永远不会生效。
        const beforeRoot = this.ttsRoot;
        const beforeModels = this.modelsRoot;
        const beforeDevice = this.device;
        this.ttsRoot = next.ttsRoot ?? this.ttsRoot;
        this.modelsRoot = next.ttsModelsRoot ?? this.modelsRoot;
        this.device = next.ttsDevice ?? this.device;
        this.textnormPath = next.ttsTextnormPath ?? this.textnormPath;
        this.textPrepPython = next.ttsPrepPython ?? this.textPrepPython;
        this.refDir = resolveRefDir(next.ttsRefDir);
        this.visibleEngines = normalizeVisibleEngines(next.ttsVisibleEngines);
        /**
         * 朗读语言指令是热字段:它只改每次合成的载荷,不影响子进程。
         * 只有真的对它感兴趣时才去算(auto + 空文本时 buildInstruct 返回 null,
         * 面板上一句话都不改的用户完全走原路径)。
         */
        this.instruct = buildInstruct(next.ttsInstructLanguage, next.ttsInstructText);
        this.preferredVoices = next.ttsVoice !== null && typeof next.ttsVoice === 'object'
            ? { ...next.ttsVoice } : this.preferredVoices;
        if (isTtsEngine(next.ttsEngine))
            this.settingsEngine = next.ttsEngine;
        // 设置里的引擎是权威,但必须落在可见集合内:否则面板显示不出当前
        // 正在用的引擎,用户会以为切换没生效。
        const want = this.visibleEngines.includes(this.settingsEngine)
            ? this.settingsEngine : this.visibleEngines[0];
        // 路径/设备变了但引擎没变:select 会因为"同引擎已就绪"直接短路,
        // 所以必须显式要求下次 reconcile 先卸载(否则新路径永远不生效)。
        if (beforeRoot !== this.ttsRoot || beforeModels !== this.modelsRoot || beforeDevice !== this.device)
            this.forceReload = true;
        // 没有进程驻留时只把 desired 对齐就够了:真正的加载留给下一次
        // ensureReady(点朗读),这样一次纯粹的页面刷新不会占显存。
        // 有进程时才需要真的换 —— 而且必须走 switchTo,它会先卸载旧的。
        if (this.current && (want !== this.desired || this.forceReload))
            void this.switchTo(want);
        else
            // 没有旧进程可卸:这条 forceReload 已经无事可做,留着会让下一次
            // 无关的 reconcile 白多走一遍"卸载"(见 reconcile 的循环)。
            this.forceReload = false;
        this.desired = want;
    }

    /**
     * 参考音频音色(预置音色引擎没有这东西,直接给空列表)。
     * 每次调用都重扫目录:用户往目录里放完文件,点一次「载入音色」就能看到。
     */
    refVoices(engineId = this.current?.id ?? this.desired) {
        if (this.spec(engineId)?.voiceKind === 'preset')
            return [];
        try {
            return this.listRefs();
        }
        catch (error) {
            this.log(`TTS 参考音频目录读取失败: ${String(error)}`);
            return [];
        }
    }

    /** 引擎自报的音色 + 参考音频 = 客户端看到的那一份目录。 */
    mergeVoices(voices) {
        return withRefVoices(voices, this.refVoices());
    }

    /** venv 与模型目录都在才算装好,UI 用它置灰未安装的引擎。 */
    installed(id) {
        const spec = this.spec(id);
        if (!spec)
            return false;
        if (!this.exists(spec.python))
            return false;
        // Kokoro 的权重走 HF 缓存,modelDir 为空表示不额外校验。
        if (spec.modelDir && !this.exists(spec.modelDir))
            return false;
        return true;
    }

    /** 串行执行,并把失败挡在队列外(否则一次失败会毒化后续所有操作)。 */
    enqueue(task) {
        const run = this.queue.then(task);
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }

    /** 对外快照。加载中也能安全调用(纯读内存状态,不碰子进程)。 */
    async status() {
        const used = await this.readVram();
        const active = this.current?.id ?? null;
        const spec = active ? this.spec(active) : null;
        return {
            active,
            desired: this.desired,
            state: this.current ? 'ready' : this.state,
            error: this.error,
            engine: active ?? this.desired,
            voice: this.voice,
            voices: this.voices,
            voiceKind: spec?.voiceKind ?? this.spec(this.desired)?.voiceKind ?? 'preset',
            refDir: this.refDir,
            loadSeconds: this.loadSeconds,
            lastEvent: this.lastEvent,
            vramUsedMb: used,
            vramFreeGb: used === null ? null : gpuFreeGb(used),
            engines: this.catalog(),
        };
    }

    /**
     * 引擎目录,供选择器渲染。
     *
     * 默认只列出 `visibleEngines`(设置面板里勾选的那些):用户嫌下拉太长时,
     * 取消勾选就能把不用的引擎藏起来。过滤的只是"面板显示什么",不是能力 ——
     * 被藏起来的引擎照样能加载,只是不出现在朗读下拉里。
     *
     * `visibleOnly=false` 是给设置面板自己用的:那个"显示哪些引擎"的勾选框
     * 必须列出**全部**引擎,否则一旦取消勾选就再也勾不回来了。
     */
    catalog(visibleOnly = true) {
        const ids = visibleOnly ? this.visibleEngines : Object.keys(TTS_ENGINES);
        return ids.filter(id => TTS_ENGINES[id] !== undefined).map(id => {
            const def = TTS_ENGINES[id];
            return {
                id,
                label: def.label,
                medal: def.medal,
                voiceKind: def.voiceKind,
                defaultVoice: def.defaultVoice,
                rtf: def.rtf,
                vramGb: def.vramGb,
                loadSeconds: def.loadSeconds,
                license: def.license,
                commercial: def.commercial,
                clone: def.clone,
                nativeDigits: def.nativeDigits,
                blurb: def.blurb,
                installed: this.installed(id),
            };
        });
    }

    /** 显存读数:失败一律当作"不知道",绝不因为拿不到 nvidia-smi 就报错。 */
    async readVram() {
        if (this.deps.queryVram)
            return this.queryVram();
        if (this.vramUsedMb === null)
            this.vramUsedMb = await queryGpuMemoryUsed();
        return this.vramUsedMb;
    }

    /** 刷新显存读数(卸载/加载后调用,让状态里的数字是新的)。 */
    async refreshVram() {
        this.vramUsedMb = await queryGpuMemoryUsed();
        return this.vramUsedMb;
    }

    /**
     * 选择引擎。立即返回(不等待加载),后台完成"卸载旧的 → 加载新的"。
     * @returns 当前状态快照。
     */
    async select(id) {
        if (!isTtsEngine(id))
            throw new Error(`未知 TTS 引擎: ${id}`);
        if (this.disposed)
            throw new Error('TTS 管理器已关闭');
        // 同引擎且已就绪:什么都不做,避免白白重载 5~40s。
        if (this.current?.id === id && this.current.proc.ready && this.state === 'ready') {
            this.desired = id;
            return this.status();
        }
        return this.switchTo(id);
    }

    /**
     * 无条件把 desired 切到 id 并排队重载(不检查"已经就绪")。
     * 与 select 分开,是因为设置面板可能改了**安装路径/设备**而引擎 id 没变 ——
     * 那时必须真的换进程,不能被 select 的短路挡回来。
     */
    async switchTo(id) {
        this.desired = id;
        if (this.current?.id !== id || this.state !== 'loading') {
            this.state = 'loading';
            this.error = null;
        }
        void this.enqueue(() => this.reconcile());
        return this.status();
    }

    /**
     * 把实际驻留的引擎对齐到 desired。
     * 循环而不是单次 if:加载途中用户又点了别的引擎,这里会继续切,直到稳定。
     */
    async reconcile() {
        do {
            const want = this.desired;
            // forceReload:引擎 id 没变但安装路径/设备变了(设置面板改的)。
            // 那种情况下必须先把旧进程卸掉,否则下面那句 "id 已相等就 break"
            // 会让新路径永远不生效。
            if (this.current && (this.current.id !== want || this.forceReload)) {
                this.forceReload = false;
                const old = this.current;
                this.current = null;
                this.voices = [];
                this.voice = '';
                const before = await this.refreshVram();
                try {
                    await old.proc.unload();
                }
                catch (error) {
                    this.log(`TTS[${old.id}] 卸载异常: ${String(error)}`);
                }
                const after = await this.refreshVram();
                this.lastEvent = before !== null && after !== null
                    ? `已卸载 ${this.spec(old.id)?.label ?? old.id},显存 ${before} → ${after} MB`
                    : `已卸载 ${this.spec(old.id)?.label ?? old.id}`;
            }
            if (this.current && this.current.id === this.desired)
                break;
            if (this.current)
                continue;
            // 到这里 current 必为 null:开始加载 desired。
            if (this.disposed)
                return;
            const spec = this.spec(this.desired);
            if (!spec)
                return;
            if (!this.installed(this.desired)) {
                this.state = 'error';
                this.error = `${spec.label} 未安装完成(缺少 venv 或模型文件)`;
                return;
            }
            this.state = 'loading';
            this.error = null;
            const started = Date.now();
            const proc = this.createProc(spec);
            try {
                await proc.start();
            }
            catch (error) {
                this.state = 'error';
                this.error = `${spec.label} 加载失败: ${String(error?.message ?? error)}`;
                this.log(`TTS[${spec.id}] 加载失败: ${String(error)}`);
                try {
                    await proc.unload();
                }
                catch { /* 已经死了 */ }
                void this.refreshVram();
                return;
            }
            this.loadSeconds = Math.round((Date.now() - started) / 100) / 10;
            this.current = { id: spec.id, proc };
            this.state = 'ready';
            // 用户上次给这个引擎选的音色优先于引擎默认值 —— 这就是"重启后
            // 还记得我选的是哪个音色"这一条。设置面板改的也是这份偏好。
            const preferred = this.preferredVoices[spec.id];
            this.voice = typeof preferred === 'string' && preferred.trim() ? preferred : (spec.defaultVoice ?? '');
            this.lastEvent = `已加载 ${spec.label},耗时 ${this.loadSeconds}s`;
            void this.refreshVram();
            try {
                await this.syncVoices(proc);
            }
            catch (error) {
                this.log(`TTS[${spec.id}] 音色列表获取失败: ${String(error)}`);
            }
        } while (this.current?.id !== this.desired);
    }

    /** 拉一次音色列表并缓存(失败不影响朗读)。 */
    async syncVoices(proc) {
        const info = await proc.voices();
        this.voices = this.mergeVoices(hasVoices(info.voices) ? info.voices : []);
        if (info.voice)
            this.voice = info.voice;
        if (this.loadSeconds === null && proc.info?.loadSeconds)
            this.loadSeconds = proc.info.loadSeconds;
        // 设置里的音色偏好是权威:worker 自己记住的音色可能来自上一次会话,
        // 而用户在设置面板里明确改过之后,这里必须把它推回去。
        const engine = this.current?.id;
        const preferred = engine ? this.preferredVoices[engine] : undefined;
        if (typeof preferred === 'string' && preferred.trim() && preferred !== this.voice) {
            try {
                const applied = await proc.setVoice(preferred);
                this.voice = applied.voice ?? preferred;
            }
            catch (error) {
                // 参考音频被删掉/改名了也会走到这里:不该让整个加载失败,
                // 退回引擎报的音色,并在状态里留一句可读的原因。
                this.log(`TTS 恢复音色 ${preferred} 失败: ${String(error)}`);
                this.lastEvent = `音色偏好不可用,已退回 ${this.voice || '默认音色'}`;
            }
        }
    }

    /** 主动卸载(UI 的"卸载"按钮 / 省显存)。 */
    async unload() {
        return this.enqueue(async () => {
            const target = this.current;
            this.current = null;
            this.state = 'idle';
            this.voices = [];
            this.voice = '';
            if (!target) {
                this.lastEvent = '当前没有已加载的引擎';
                await this.refreshVram();
                return this.status();
            }
            const before = await this.refreshVram();
            try {
                await target.proc.unload();
            }
            catch (error) {
                this.log(`TTS[${target.id}] 卸载异常: ${String(error)}`);
            }
            const after = await this.refreshVram();
            this.lastEvent = before !== null && after !== null
                ? `已卸载 ${this.spec(target.id)?.label ?? target.id},显存 ${before} → ${after} MB`
                : `已卸载 ${this.spec(target.id)?.label ?? target.id}`;
            return this.status();
        }).then(() => this.status());
    }

    /**
     * 把回复切成可逐句合成的片段。**不需要引擎已加载**,也不会触发加载 ——
     * 客户端可以先拿到句子列表,再让第一句的 speak 去承担加载代价。
     *
     * @param text - 回复原文(Markdown 也可以,这里会剥掉)
     * @param engineId - 用哪个引擎的规则来展开数字。默认取当前选择,但客户端
     *   常常"还没切换就已经想知道切成什么样",所以允许显式指定 —— 必须与真正
     *   合成的引擎一致,否则数字形式对不上,ASR 侧会看到虚高的错误率。
     */
    async segments(text, engineId, options = {}) {
        if (this.disposed)
            throw new Error('TTS 管理器已关闭');
        const engine = isTtsEngine(engineId) ? engineId : this.desired;
        const result = await this.segment(String(text ?? ''), { engine, ...(options.markdown === false ? { markdown: false } : {}) });
        return { ...result, engine, desired: this.desired };
    }

    /** 音色列表;未就绪则先加载。 */
    async listVoices() {
        await this.ensureReady();
        const info = await this.current.proc.voices();
        // 这是权威枚举,可以真的清空(引擎确实一个音色都没有的情况)——
        // 但列表永远是"引擎音色 + 参考音频目录"的合并结果。
        this.voices = this.mergeVoices(hasVoices(info.voices) ? info.voices : []);
        if (info.voice)
            this.voice = info.voice;
        return { voices: this.voices, voice: this.voice, engine: this.current.id };
    }

    /** 切换音色(预置音色名 / zh=..,en=.. / 参考音频名)。 */
    async setVoice(voice) {
        await this.ensureReady();
        const info = await this.current.proc.setVoice(voice);
        // worker 不回音色列表:只在真的带了列表时才覆盖,否则保留上一份。
        if (hasVoices(info.voices))
            this.voices = info.voices;
        this.voice = info.voice ?? voice;
        // 记进偏好,这样换走引擎再换回来、或者重新加载,都还记得这个选择。
        // 真正落盘是 host 的事(见 index.js 的 /tts/setVoice)。
        this.preferredVoices[this.current.id] = this.voice;
        this.lastEvent = `音色已切换为 ${this.voice}`;
        return { voices: this.voices, voice: this.voice, engine: this.current.id };
    }

    /**
     * 等待"想要的引擎"就绪。
     * 串行队列天然把并发调用折叠:第一个真正加载,其余等同一个队列。
     */
    async ensureReady() {
        if (this.disposed)
            throw new Error('TTS 管理器已关闭');
        if (this.current?.id === this.desired && this.current.proc.ready && this.state === 'ready')
            return this.current;
        await this.enqueue(() => this.reconcile());
        if (!this.current || this.current.id !== this.desired)
            throw new Error(this.error ?? 'TTS 引擎未就绪');
        return this.current;
    }

    /**
     * 合成一段文本。
     * @param payload - { text, voice?, engine? }
     * @returns { wav: Buffer|null, sampleRate, audioSeconds, synthSeconds, voice, engine }
     */
    async speak({ text, voice, engine, prepared }) {
        const content = String(text ?? '');
        if (!content.trim())
            throw new Error('没有可朗读的文本');
        if (engine && engine !== this.desired) {
            await this.select(engine);
            // select 是后台加载:这里必须等到真的就绪再合成。
            await this.waitReady();
        }
        const target = await this.ensureReady();
        if (voice && voice !== this.voice) {
            try {
                const info = await target.proc.setVoice(voice);
                this.voice = info.voice ?? voice;
                if (hasVoices(info.voices))
                    this.voices = info.voices;
            }
            catch (error) {
                this.log(`TTS 音色 ${voice} 设置失败: ${String(error)}`);
            }
        }
        const started = Date.now();
        // 注意:合成请求**不带 cmd**。worker 的调度是"cmd 为 None 就走合成",
        // 任何非 None 的未知 cmd 都会回 unknown cmd —— 传 'speak' 会被拒。
        //
        // instruct 只在非空时才进载荷:auto 的情况下请求形状与之前逐字相同,
        // 而这些引擎里只有 CosyVoice 系列认这个字段。
        const result = await target.proc.speak({
            text: content,
            ...(prepared === true ? { prepared: true } : {}),
            voice: this.voice,
            ...(this.instruct ? { instruct: this.instruct } : {}),
        });
        if (result.skipped && !result.wav)
            return { ...result, engine: target.id, wallSeconds: 0 };
        return { ...result, engine: target.id, wallSeconds: Math.round((Date.now() - started) / 100) / 10 };
    }

    /** 等到 state 离开 loading(给"点了选择器后马上要合成"的场景用)。 */
    async waitReady(timeoutMs = 300000) {
        const deadline = Date.now() + timeoutMs;
        while (this.state === 'loading' || (this.desired && this.current?.id !== this.desired)) {
            if (Date.now() > deadline)
                throw new Error('等待 TTS 引擎就绪超时');
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (this.state === 'error')
            throw new Error(this.error ?? 'TTS 引擎不可用');
    }

    async stats() {
        if (!this.current)
            return { engine: null, state: this.state, voices: [], vramUsedMb: await this.readVram() };
        const info = await this.current.proc.stats();
        return { ...info, engine: this.current.id, vramUsedMb: await this.readVram() };
    }

    /** 关插件时必须真的把子进程收掉,否则显存会一直被占着。 */
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        const target = this.current;
        this.current = null;
        if (!target)
            return;
        try {
            await target.proc.unload();
        }
        catch (error) {
            this.log(`TTS 关闭异常: ${String(error)}`);
        }
        target.proc.dispose();
    }
}

/** nvidia-smi 读整卡已用显存(MB)。拿不到就是 null,绝不抛。 */
export function queryGpuMemoryUsed() {
    return new Promise(resolve => {
        execFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { timeout: 5000 }, (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            const value = Number.parseInt(String(stdout).split('\n')[0].trim(), 10);
            resolve(Number.isFinite(value) ? value : null);
        });
    });
}

/** 由整卡已用显存反推空闲量(整卡 16384MB)。 */
export function gpuFreeGb(usedMb) {
    const total = 16384;
    if (typeof usedMb !== 'number')
        return null;
    return Math.round((total - usedMb) / 102.4) / 10;
}
