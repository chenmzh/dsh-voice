/**
 * 「语音」设置 tab 的状态源。
 *
 * 这个 store 站在两个数据源之间,而它们**职责不同**,不是主备关系:
 *
 *   - `settingsScope`(DSH 的用户设置文档,落在 `~/.dsh/settings.yaml` 的
 *     `voice:` 段)是**权威且可写**的:面板里改的值写进用户层,重启后还在,
 *     清掉又退回 cordis.patch.yml 那一层。所有字段写入都走它。
 *   - `/voice/config` 与 `/tts/config` 是**兜底且补充**的:没装 settings
 *     provider 时 scope 会停在 unavailable,那时面板仍然要能显示出当前实际
 *     生效的值(来自 host 的解析结果),否则这个 tab 会一片空白。它还提供
 *     scope 里没有的东西:STT 语言表的**中文标签**、引擎目录、参考音频目录
 *     的当前内容。
 *
 * 于是规则很简单,而且是**单一来源优先级**:读 scope 有值就用 scope 的,
 * 没有才用 host 的;写只走 scope;克隆音色文件走 RPC(它操作磁盘文件,
 * 不是设置文档里的字段)。
 */
import { TTS_ENDPOINTS } from '../core/wire.js';

const VOICE_CHANNEL = '/voice';
const TTS_CHANNEL = '/tts';

function initialState() {
    return {
        /** 'loading' 首读中 | 'ready' 可读(可写与否看 writable) */
        status: 'loading',
        /** 解析后的完整设置。 */
        value: null,
        /** 用户层里**显式改过**的字段 —— 面板据此标记,并允许单独恢复默认。 */
        overridden: [],
        /** settings 文档是否接受写入(memory 模式 / 没 provider 都是 false)。 */
        writable: false,
        /** 'host' 与宿主文档同步 | 'memory' 只在本进程内。 */
        mode: 'host',
        /** 正在写(按钮置忙,防连点)。 */
        saving: false,
        /** 面板顶部错误条。 */
        error: '',
        /** 面板顶部说明条。 */
        note: '',
        /**
         * host 注册设置命名空间失败的原因(用户 settings.yaml 里的 voice 段
         * 有非法值)。非空时面板必须显示:否则用户只会看到"面板是灰的、
         * 我改的值没生效",而文件里那行错字无从查起。
         */
        settingsError: '',
        /** 语音输入语言下拉的可选值(带中文标签,由 host 下发)。 */
        languages: [],
        /** 朗读语言指令下拉的可选值(同样由 host 下发,见 core/tts-instruct.js)。 */
        instructLanguages: [],
        /** 朗读引擎目录(host 已按 ttsVisibleEngines 过滤)。 */
        engines: [],
        /**
         * **全部**引擎(不受"显示哪些引擎"过滤)。
         * 面板那份勾选框必须用它渲染:只列可见的话,取消勾选之后就再也勾不回来了。
         */
        engineChoices: [],
        /** 参考音频目录(绝对路径,要显示给用户看)。 */
        refDir: '',
        /** 目录里现在有哪些参考音频。 */
        refs: [],
        refsBusy: false,
    };
}

/** 逐字段比较:数组/对象按内容比,否则每次刷新都会让面板整块重渲染。 */
function sameField(a, b) {
    if (a === b)
        return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length)
            return false;
        return a.every((item, i) => {
            const other = b[i];
            if (item === other)
                return true;
            if (item !== null && other !== null && typeof item === 'object' && typeof other === 'object')
                return JSON.stringify(item) === JSON.stringify(other);
            return false;
        });
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object')
        return JSON.stringify(a) === JSON.stringify(b);
    return false;
}

export class VoiceSettingsStore {
    /**
     * @param options.bindScope - `() => SettingsScope|null`。必须是回调而不是
     *   现成的 scope:bind 要在插件的 fiber 上调用(见 dsh-client-ui-settings)。
     * @param options.rpc - (channel, endpoint, payload) => Promise<{ok,value,error}>
     * @param options.log - 诊断出口。
     */
    constructor({ bindScope, rpc, onVoiceSelected = async () => {}, log = () => { } } = {}) {
        this.onVoiceSelected = onVoiceSelected;
        this.bindScope = bindScope ?? (() => null);
        this.rpc = rpc;
        this.log = log;
        this.state = initialState();
        this.listeners = new Set();
        this.scope = null;
        this.unsubscribe = null;
        /** scope 快照里的解析值;null = 还没拿到。 */
        this.scopeValue = null;
        /** /voice/config 里的兜底值;null = 还没拿到。 */
        this.hostValue = null;
        this.userKeys = [];
        this.disposed = false;
        this.started = false;
    }

    getSnapshot = () => this.state;

    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    update(patch) {
        let changed = false;
        for (const [key, next] of Object.entries(patch)) {
            if (!sameField(this.state[key], next)) {
                changed = true;
                break;
            }
        }
        if (!changed)
            return;
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) {
            try {
                listener();
            }
            catch (error) {
                this.log(`语音设置订阅者抛错: ${String(error)}`);
            }
        }
    }

    async start() {
        if (this.started || this.disposed)
            return;
        this.started = true;
        if (this.scope === null) {
            try {
                this.attachScope(this.bindScope());
            }
            catch (error) {
                this.log(`语音设置作用域绑定失败: ${String(error)}`);
                this.attachScope(null);
            }
        }
        await this.refresh();
    }

    /**
     * 接上/摘掉设置作用域。
     *
     * 之所以是"可后接"的,而不是构造时一次定死:`settingsScope` 在本插件里是
     * **可选**依赖 —— 设置界面没装载时麦克风和朗读必须照常工作,所以作用域
     * 可能在 start() 之后才出现,也可能中途消失。
     * @param scope - 绑好的作用域;null 表示摘掉(退回 host 下发的只读值)。
     */
    attachScope(scope) {
        if (this.disposed)
            return;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.scope = scope;
        if (scope === null) {
            // 摘掉之后不能留着旧的解析值:那份值已经没人负责写回了,
            // 必须退回 host 下发的"当前实际生效"值。
            this.scopeValue = null;
            this.userKeys = [];
            this.publish();
            return;
        }
        this.unsubscribe = scope.subscribe(() => this.syncFromScope());
        this.syncFromScope();
    }

    /** 把 scope 快照折进面板状态。scope 是权威源,读到什么就是什么。 */
    syncFromScope() {
        if (this.scope === null || this.disposed)
            return;
        const snapshot = this.scope.getSnapshot();
        const user = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : null;
        if (snapshot.value !== undefined)
            this.scopeValue = snapshot.value;
        this.userKeys = user === null ? [] : Object.keys(user);
        this.publish();
    }

    /**
     * 重算对外那一个快照。
     * 单一来源优先级:scope 有解析值就用它(它是三层解析的结果,host 下发的
     * 那份只是同一个对象的副本);scope 没有才退回 host 下发的那份。
     */
    publish(extra = {}) {
        const value = this.scopeValue ?? this.hostValue;
        const writable = this.scope !== null && this.scope.getSnapshot?.().writable === true;
        const mode = this.scope?.getSnapshot?.().mode ?? 'memory';
        this.update({
            value,
            overridden: this.userKeys,
            writable,
            mode,
            // 有值就算 ready。没有 scope 时 writable=false,面板会把控件置灰
            // 并说明"要改请改配置文件",而不是假装能改。
            status: value === null ? 'loading' : 'ready',
            ...extra,
        });
    }

    /** 从 host 拉语言表 / 引擎目录 / 参考音频目录。 */
    async refresh() {
        const [voice, tts] = await Promise.all([
            this.call(VOICE_CHANNEL, 'config'),
            this.call(TTS_CHANNEL, 'config'),
        ]);
        const patch = {};
        if (voice !== null) {
            if (Array.isArray(voice.languages))
                patch.languages = voice.languages;
            if (Array.isArray(voice.instructLanguages))
                patch.instructLanguages = voice.instructLanguages;
            if (Array.isArray(voice.ttsEngines))
                patch.engineChoices = voice.ttsEngines;
            if (voice.settings !== null && typeof voice.settings === 'object')
                this.hostValue = voice.settings;
            if (typeof voice.settingsError === 'string')
                patch.settingsError = voice.settingsError;
        }
        if (tts !== null) {
            if (Array.isArray(tts.engines))
                patch.engines = tts.engines;
            if (typeof tts.refDir === 'string' && tts.refDir)
                patch.refDir = tts.refDir;
            if (Array.isArray(tts.refs))
                patch.refs = tts.refs;
        }
        this.publish(patch);
    }

    async call(channel, endpoint, payload = {}) {
        try {
            const res = await this.rpc(channel, endpoint, payload);
            if (res?.ok !== true)
                throw new Error(res?.error?.message ?? 'RPC 失败');
            return res.value;
        }
        catch (error) {
            this.log(`语音设置 ${channel}/${endpoint} 失败: ${String(error)}`);
            return null;
        }
    }

    /** 重新列一次参考音频目录。不加载模型(见 wire.js 的 refs 端点说明)。 */
    async refreshRefs() {
        this.update({ refsBusy: true });
        const value = await this.call(TTS_CHANNEL, TTS_ENDPOINTS.refs, {});
        const patch = { refsBusy: false };
        if (value !== null) {
            if (Array.isArray(value.refs))
                patch.refs = value.refs;
            if (typeof value.refDir === 'string' && value.refDir)
                patch.refDir = value.refDir;
        }
        this.update(patch);
    }

    /**
     * 写一个字段。值必须是 JSON 可序列化的:scope.set 会把它原样存进用户层,
     * 传进一个 React 事件对象会以"非 JSON 值"被拒。
     */
    async set(field, value) {
        if (this.scope === null) {
            this.update({ error: '设置文档不可写：这个部署没有装载 settings provider，请改 cordis.patch.yml 后重启' });
            return false;
        }
        this.update({ saving: true, error: '', note: '' });
        try {
            await this.scope.set(field, value);
            this.syncFromScope();
            this.update({ saving: false, note: '已保存' });
            // 可见引擎变了,引擎目录要跟着重取(host 是按它过滤的)。
            if (field === 'ttsVisibleEngines')
                await this.refresh();
            return true;
        }
        catch (error) {
            this.update({ saving: false, error: `保存失败：${String(error?.message ?? error)}` });
            return false;
        }
    }

    /** 单个字段恢复默认(从用户层清掉,退回 cordis.patch.yml / schema 默认)。 */
    async resetField(field) {
        if (this.scope === null)
            return false;
        this.update({ saving: true, error: '', note: '' });
        try {
            await this.scope.unset(field);
            this.syncFromScope();
            this.update({ saving: false, note: '已恢复默认' });
            await this.refresh();
            return true;
        }
        catch (error) {
            this.update({ saving: false, error: `恢复失败：${String(error?.message ?? error)}` });
            return false;
        }
    }

    /**
     * 全部恢复默认。
     * 用 mutate+unset 而不是"写一份空对象":unset 只删掉用户层里**确实存在**
     * 的键,而写空值会把每个字段都变成"用户显式设成空",那是另一回事
     * (而且会被 schema 拒掉)。
     */
    async resetAll() {
        if (this.scope === null)
            return false;
        const fields = this.userKeys;
        if (fields.length === 0) {
            this.update({ note: '当前没有任何自定义设置' });
            return true;
        }
        this.update({ saving: true, error: '', note: '' });
        try {
            await this.scope.mutate(fields.map(field => ({ op: 'unset', path: [field] })));
            this.syncFromScope();
            this.update({ saving: false, note: '已全部恢复默认' });
            await this.refresh();
            return true;
        }
        catch (error) {
            this.update({ saving: false, error: `恢复失败：${String(error?.message ?? error)}` });
            return false;
        }
    }

    /** 导入一个克隆音色(音频内容由组件读成 base64)。 */
    async saveRef({ name, audio, text, ext }, engine) {
        this.update({ refsBusy: true, error: '', note: '' });
        const value = await this.call(TTS_CHANNEL, TTS_ENDPOINTS.saveRef, { name, audio, text, ext });
        if (value === null) {
            this.update({ refsBusy: false, error: '导入失败（宿主拒绝了这次写入，详见宿主日志）' });
            return false;
        }
        this.update({ refsBusy: false, note: `已导入音色「${value.saved?.label ?? name}」` });
        if (Array.isArray(value.refs))
            this.update({ refs: value.refs });
        if (typeof value.refDir === 'string' && value.refDir)
            this.update({ refDir: value.refDir });
        if (engine && value.saved?.id) {
            const selected = await this.useRef(value.saved.id, engine);
            if (!selected) this.update({ error: '音色已保存，但未能设为当前音色，请在列表中点“使用”重试。' });
        }
        // 这里**不**再调 refresh():导入/删除的回包已经带回了刚重扫的目录,
        // 而 refresh 会去读 /tts/config 的那一份 —— 它可能是这次写入**之前**
        // 就已经在路上的响应,后写覆盖先写,用户就会看到"导入成功了但列表里
        // 还是没有"。写入类的回包在这一点上是权威的。
        return true;
    }

    /** Persist engine and its voice together; preserve every other engine's voice. */
    async useRef(id, engine) {
        if (!this.state.writable || !this.scope) return false;
        if (!this.state.engineChoices.some(e => e.id === engine && e.voiceKind === 'clone' && e.installed !== false)) {
            this.update({ error: '请选择可用的克隆引擎' });
            return false;
        }
        this.update({ saving: true, error: '', note: '' });
        try {
            const value = this.scope.getSnapshot().value ?? this.state.value ?? {};
            const ops = [
                { op: 'set', path: ['ttsEngine'], value: engine },
                { op: 'set', path: ['ttsVoice'], value: { ...value.ttsVoice, [engine]: id } },
            ];
            if (value.ttsVisibleEngines?.length && !value.ttsVisibleEngines.includes(engine))
                ops.push({ op: 'set', path: ['ttsVisibleEngines'], value: [...value.ttsVisibleEngines, engine] });
            await this.scope.mutate(ops);
            this.syncFromScope();
            await this.onVoiceSelected();
            this.update({ note: '已选用音色', saving: false });
            return true;
        } catch (error) {
            this.update({ saving: false, error: `使用音色失败：${error?.message ?? error}` });
            return false;
        }
    }

    async previewRef(id, engine, text, isCurrent = () => true) {
        if (!text?.trim()) throw new Error('请填写示例文本');
        if (!await this.useRef(id, engine)) throw new Error(this.state.error || '设置不可写');
        const call = async (endpoint, payload) => {
            if (!isCurrent() || this.disposed) throw new Error('试听已取消');
            const res = await this.rpc(TTS_CHANNEL, endpoint, payload);
            if (!res?.ok) throw new Error(res?.error?.message ?? '朗读服务不可用');
            return res.value;
        };
        // Explicit setVoice validates the clip before synthesis. A failed clone must
        // not quietly play the previous/default voice through speak's fallback.
        await call(TTS_ENDPOINTS.select, { engine });
        await call(TTS_ENDPOINTS.setVoice, { voice: id });
        const result = await call(TTS_ENDPOINTS.speak, { text: text.trim().slice(0, 200), engine, voice: id });
        if (!result?.wav) throw new Error('引擎没有生成示例音频，请检查参考音频和文本后重试');
        return result;
    }

    /** 删掉一个克隆音色(连同同名 .txt)。 */
    async deleteRef(name) {
        this.update({ refsBusy: true, error: '', note: '' });
        const value = await this.call(TTS_CHANNEL, TTS_ENDPOINTS.deleteRef, { name });
        if (value === null) {
            this.update({ refsBusy: false, error: '删除失败' });
            return false;
        }
        this.update({ refsBusy: false, note: value.removed ? `已删除「${name}」` : `没找到「${name}」` });
        if (Array.isArray(value.refs))
            this.update({ refs: value.refs });
        // 同 saveRef:不再 refresh,回包里的列表就是写入后的那一份。
        return true;
    }

    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}
