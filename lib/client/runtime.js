import { createRecognizer } from './asr.js';
import { createVoiceService } from './voice-service.js';
import { Emitter } from '../core/emitter.js';
export class VoiceRuntime {
    ctx;
    config;
    engine = null;
    listening = false;
    starting = false;
    disposed = false;
    recognizer = null;
    /** 本轮累计定稿文本(停麦时提交;onText(final) 替换式更新) */
    pendingText = '';
    /** 当前部分识别文本(边说边出字,未定稿) */
    partialText = '';
    /** 轮次守卫:启动被打断、停麦后作废一切迟到回调 */
    round = 0;
    /** 停止进行中:onEnd/onError 与用户点停并发时防重入 */
    stopping = false;
    /** 开启本轮识别的会话;停麦提交一律归它(跨会话点停不串台) */
    activeSession = null;
    listeners = new Emitter();
    deps;
    constructor(ctx, config, deps = {}) {
        this.ctx = ctx;
        this.config = config;
        const rpc = deps.rpc ?? createVoiceService((channel, endpoint, payload) => this.ctx.connection.rpc.call(channel, endpoint, payload));
        this.deps = {
            createRecognizer: deps.createRecognizer ?? ((engine, sessionId) => createRecognizer(engine, sessionId, (payload) => rpc.asr(payload))),
            submit: deps.submit ?? ((sessionId, text) => this.appendDraft(sessionId, text)),
            rpc,
        };
    }
    /** 每次点击都握手:等待 host 按需启动模型，不能复用旧的存活状态。 */
    async getEngine() {
        if (this.config.engine === 'browser') return 'browser';
        const { engine } = await this.deps.rpc.ping();
        if (engine !== 'native' && engine !== 'browser') throw new Error('语音服务返回了无效引擎');
        if (this.config.engine === 'native' && engine !== 'native')
            throw new Error('本地语音服务不可用');
        return engine;
    }
    /**
     * host /voice.config 到达后更新引擎选择。空闲时立即失效解析缓存,
     * 下一轮从新配置开始;正在识别的一轮不打断。
     */
    setEngine(engine) {
        if (this.config.engine === engine)
            return;
        this.config = { ...this.config, engine };
        if (!this.listening)
            this.engine = null;
    }
    isListening() {
        return this.listening;
    }
    isStarting() {
        return this.starting;
    }
    subscribe(cb) {
        return this.listeners.on(cb);
    }
    notify() {
        this.listeners.emit();
    }
    /** 点击即启动模型；握手成功后才采声，加载时再次点击可取消本轮。 */
    async toggleMic(sessionId) {
        if (this.disposed) return;
        if (this.listening) {
            await this.stopMic(this.activeSession ?? sessionId);
            return;
        }
        const round = ++this.round;
        this.activeSession = sessionId;
        this.listening = true;
        this.starting = true;
        this.pendingText = '';
        this.partialText = '';
        this.notify();
        try {
            const engine = await this.getEngine();
            if (this.round !== round) return;
            const rec = this.deps.createRecognizer(engine, sessionId);
            rec.onText((text, final) => {
                if (this.round !== round) return;
                if (final) {
                    this.pendingText = text;
                    this.partialText = '';
                } else {
                    this.partialText = text;
                }
                this.notify();
            });
            rec.onError((err) => {
                if (this.round !== round) return;
                this.pendingText = '';
                this.partialText = '';
                void this.stopMic(sessionId).then(() => { console.error('dsh-voice ASR:', err); });
            });
            rec.onEnd(() => {
                if (this.round !== round) return;
                void this.stopMic(sessionId);
            });
            this.recognizer = rec;
            await rec.start();
            if (this.round !== round) {
                void rec.stop().catch(() => {});
                return;
            }
            this.starting = false;
            this.notify();
        } catch (err) {
            if (this.round !== round) return; // 已取消的加载结果不影响新一轮
            this.round += 1;
            this.recognizer = null;
            this.activeSession = null;
            this.listening = false;
            this.starting = false;
            this.engine = null;
            this.notify();
            this.reportMicError(sessionId, err);
            throw err;
        }
    }
    /** 停止识别;定稿文本非空则追加到输入框草稿，不发送消息。幂等;轮次守卫杜绝迟到回调。 */
    async stopMic(sessionId) {
        const rec = this.recognizer;
        if (rec === null) {
            // 未开始或启动中(引擎探测):作废进行中的启动
            this.round += 1;
            this.activeSession = null;
            this.listening = false;
            this.starting = false;
            this.engine = null;
            this.notify();
            return;
        }
        const target = this.activeSession ?? sessionId;
        if (this.stopping)
            return; // 防重入:并发进来的停止直接返回,在途的负责收尾
        this.stopping = true;
        this.starting = false;
        this.notify();
        try {
            await rec.stop(); // 契约:resolve 后不再有任何回调
        }
        catch (err) {
            console.error('dsh-voice ASR 收尾失败:', err);
        this.pendingText = ''; this.partialText = '';
        const scope = this.ctx.sessions.scope(target);
        const conversation = scope?.get('conversation');
        conversation?.input.for(scope).notify('error', '语音转写失败：' + String(err));
        }
        if (this.disposed) return;
        this.round += 1; // 作废一切迟到回调
        this.stopping = false;
        this.recognizer = null;
        this.activeSession = null;
        const text = (this.pendingText + this.partialText).trim();
        this.pendingText = '';
        this.partialText = '';
        this.listening = false;
        // 下一轮重新按当前 config 解析引擎:host /voice.config 即使在上一轮
        // 识别过程中到达,也会从下一轮开始生效。
        this.engine = null;
        this.notify();
        if (text !== '')
            await this.deps.submit(target, text);
    }
    /** 插件卸载/HMR 时取消录音意图；迟到的加载结果不得重新打开麦克风。 */
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.round += 1;
        const rec = this.recognizer;
        this.recognizer = null;
        this.activeSession = null;
        this.pendingText = '';
        this.partialText = '';
        this.listening = false;
        this.starting = false;
        this.stopping = false;
        this.notify();
        if (rec) void rec.stop().catch(() => {});
    }
    /** 当前部分识别文本(按钮提示实时回显用)。 */
    getPartial() {
        if (this.starting) return this.config.engine === 'browser'
            ? '正在准备麦克风…' : '正在启动语音服务、加载模型，请稍候…';
        return this.stopping ? '正在转写，请稍候…' : this.partialText;
    }
    reportMicError(sessionId, error) {
    const messages = {
        NotFoundError: '没有检测到可用麦克风。请先连接麦克风或带麦克风的耳机，并在系统声音设置中确认输入设备，然后重试。',
        DevicesNotFoundError: '没有检测到可用麦克风。请先连接麦克风或带麦克风的耳机，并在系统声音设置中确认输入设备，然后重试。',
        NotAllowedError: '麦克风访问被拒绝。请检查浏览器中本网站的麦克风权限，以及系统的麦克风隐私设置。',
        PermissionDeniedError: '麦克风访问被拒绝。请检查浏览器中本网站的麦克风权限，以及系统的麦克风隐私设置。',
        NotReadableError: '麦克风无法读取，可能被其他程序占用或设备异常。请检查系统输入设备后重试。',
        OverconstrainedError: '麦克风不支持请求的录音参数，请检查系统默认输入设备后重试。',
    };
    const scope = this.ctx.sessions.scope(sessionId);
    const conversation = scope?.get('conversation');
    conversation?.input.for(scope).notify('error', messages[error?.name] ?? ('无法开始语音输入：' + String(error)));
}
    async appendDraft(sessionId, text) {
        const scope = this.ctx.sessions.scope(sessionId);
        if (scope === undefined)
            return;
        const conversation = scope.get('conversation');
        if (conversation === undefined)
            return;
        const input = conversation.input.for(scope);
        const state = input.state.getSnapshot();
        // Input spans use a single placeholder per reference chip.
        const end = state.draft.length - state.occurrences.reduce((n, ref) => n + ref.length - 1, 0);
        const separator = state.draft !== '' && !/\s$/u.test(state.draft) ? '\n' : '';
        const inserted = (state.phase === 'plain' || state.phase === 'claimed') && scope.bail('slash/input-insert-text', {
            text: separator + text,
            span: { start: end, end, draftRev: state.draftRev },
        }) === true;
        if (!inserted) {
            input.notify('error', '语音转写未写入草稿，请复制后手动粘贴：\n' + text);
        }
    }
}
