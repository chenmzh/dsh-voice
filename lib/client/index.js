import { installSelectionReader } from './selection-reader.js';
import { installMessageActions } from './message-actions.js';
import { VoiceRuntime } from './runtime.js';
import { createVoiceService } from './voice-service.js';
import { hotkeyLabel, parseHotkey } from './hotkey.js';
import { Emitter } from '../core/emitter.js';
import { DEFAULTS, isVoiceEngine } from '../core/config.js';
import { MicButton } from './mic-button.js';
import { SpeakButton } from './speak-button.js';
import { TtsPicker } from './tts-picker.js';
import { TtsController } from './tts-store.js';
import { VoiceSettingsStore } from './settings-store.js';
import { VoiceSettingsSection } from './settings-section.js';

/** 设置命名空间,必须与 host 半的 core/settings-schema.js 一致。 */
const VOICE_NAMESPACE = 'voice';
export const name = 'dsh-voice';
/**
 * `settingsScope` **不在**这里:它是可选依赖,写进静态 inject 会让整个语音
 * 插件(麦克风、朗读)在没装设置界面的部署上直接起不来。它通过
 * `ctx.inject(['settingsScope'], …)` 在下面单独接。
 */
export const inject = ['sessions', 'slots', 'connection'];
export function apply(ctx, config = {}) {
    ctx.effect(() => installMessageActions(), 'dsh-voice: historical message actions');
    /** 设置作用域:可能在 start() 之后才绑定好,所以用一层可变引用交给 store。 */
    let boundScope = null;
    // web shell 用 loader.create({ name }) 创建 client 条目,行内 config 不会
    // 传给 client apply。这里用共享默认值兜底,再由 host 半经 /voice.config
    // 把真正生效的行内配置同步回来(值守卫在 core/config.ts,host schema
    // 覆盖不到 RPC 下发的路径)。
    const clientConfig = {
        engine: isVoiceEngine(config.engine) ? config.engine : DEFAULTS.engine,
        hotkey: typeof config.hotkey === 'string' && config.hotkey.trim() !== '' ? config.hotkey : DEFAULTS.hotkey,
    };
    const configEvents = new Emitter();
    const runtime = new VoiceRuntime(ctx, { engine: clientConfig.engine });
    let disposed = false;
    ctx.effect(() => () => { disposed = true; runtime.dispose(); }, 'dsh-voice: microphone lifetime');
    // 业务状态经标准 hooks compartment 进组件:组件只拿到 useListening/usePartial
    // 与纯回调,不接触整个 runtime 对象,也不自行 useSyncExternalStore。
    const listeningSource = {
        getSnapshot: () => runtime.isListening(),
        subscribe: (cb) => runtime.subscribe(cb),
    };
    const startingSource = {
        getSnapshot: () => runtime.isStarting(),
        subscribe: (cb) => runtime.subscribe(cb),
    };
    const partialSource = {
        getSnapshot: () => runtime.getPartial(),
        subscribe: (cb) => runtime.subscribe(cb),
    };
    const hotkeySource = {
        getSnapshot: () => hotkeyLabel(clientConfig.hotkey),
        subscribe: (cb) => configEvents.on(cb),
    };
    // 麦克风按钮(会话槽)
    ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'voice-mic',
        order: 0,
        inject: (sessionId) => ({
            onToggle: () => {
                void runtime.toggleMic(sessionId).catch((err) => {
                    console.error('dsh-voice mic:', err);
                });
            },
            hooks: { listening: listeningSource, starting: startingSource, partial: partialSource, hotkey: hotkeySource },
        }),
    }, MicButton));
    // 全局快捷键:开关当前会话的麦克风。hotkey 变量在 /voice.config 返回后
    // 原地更新,keydown 监听器每次读取最新值,无需重建 effect。
    let hotkey = parseHotkey(clientConfig.hotkey);
    ctx.effect(() => {
        const onKey = (event) => {
            if (hotkey === null)
                return;
            if (event.ctrlKey !== hotkey.ctrl || event.altKey !== hotkey.alt || event.shiftKey !== hotkey.shift)
                return;
            if (event.code !== hotkey.code)
                return;
            // 输入框/编辑器聚焦时不抢快捷键(避免与输入法/编辑操作冲突)
            const target = event.target;
            if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable))
                return;
            event.preventDefault();
            const current = ctx.sessions.list.getSnapshot().current;
            if (current === undefined)
                return;
            void runtime.toggleMic(current).catch((err) => {
                console.error('dsh-voice mic:', err);
            });
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, 'dsh-voice: global hotkey');
    const voice = createVoiceService((channel, endpoint, payload) => ctx.connection.rpc.call(channel, endpoint, payload));
    // ---- 朗读 ----
    // 控制器是客户端唯一状态源;组件只拿到 hooks 与纯回调,不接触 RPC/音频队列。
    const tts = new TtsController({
        rpc: (channel, endpoint, payload) => ctx.connection.rpc.call(channel, endpoint, payload),
        sessions: ctx.sessions,
        log: message => console.warn('dsh-voice tts:', message),
    });
    ctx.effect(() => () => { tts.dispose(); }, 'dsh-voice: read-aloud lifetime');
    ctx.effect(() => installSelectionReader(tts), 'dsh-voice: selected passage read-aloud');
    void tts.start();
    // 当前会话切换时重绑自动朗读(自动朗读只作用于当前会话)。
    ctx.effect(() => {
        const sync = () => tts.bindSession(ctx.sessions.list.getSnapshot().current);
        sync();
        return ctx.sessions.list.subscribe(sync);
    }, 'dsh-voice: read-aloud session binding');
    // 每一条已定稿回复右下角的朗读按钮。这个槽位只在该轮最后一条已定稿消息上渲染,
    // 所以消息必然完整,不需要自己判断"回复结束"。
    ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'voice-speak',
        order: 20,
        label: '朗读',
        inject: (sessionId) => ({
            onSpeak: (messageId) => {
                void tts.speakMessage(sessionId, messageId);
            },
            hooks: { tts },
        }),
    }, SpeakButton));
    // 输入框右侧的模型/人声选择器(该槽位目前为空,且无 owner)。
    ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'voice-tts',
        order: 50,
        label: '朗读设置',
        inject: () => ({
            onSelect: engine => { void tts.select(engine); },
            onUnload: () => { void tts.unload(); },
            onAutoRead: enabled => {
                // Both checkboxes write the same host setting when available.
                if (settingsStore.getSnapshot().writable) void settingsStore.set('ttsAutoRead', enabled);
                else tts.setAutoRead(enabled);
            },
            onSetVoice: v => { void tts.setVoice(v); },
            onLoadVoices: () => { void tts.loadVoices(tts.state.preferred ?? undefined); },
            hooks: { tts },
        }),
    }, TtsPicker));
    // ---- 设置面板里的「语音」页 ------------------------------------------
    // 状态源与动作都在 store 里,组件只负责画;这样面板逻辑可以用纯函数测。
    const settingsStore = new VoiceSettingsStore({
        bindScope: () => boundScope,
        onVoiceSelected: () => tts.refreshConfig(),
        rpc: (channel, endpoint, payload) => ctx.connection.rpc.call(channel, endpoint, payload),
        log: message => console.warn('dsh-voice settings:', message),
    });
    // 可选依赖:设置服务不在位时这个回调永远不跑,麦克风与朗读照常工作,
    // 面板则显示 host 下发的只读值并说明"要去改配置文件"。
    ctx.inject(['settingsScope'], (scoped) => {
        boundScope = scoped.settingsScope.bind({ namespace: VOICE_NAMESPACE });
        settingsStore.attachScope(boundScope);
        const syncAutoRead = () => {
            const enabled = boundScope?.getSnapshot()?.value?.ttsAutoRead;
            if (typeof enabled === 'boolean') tts.setAutoRead(enabled);
        };
        const unsubscribe = boundScope.subscribe(syncAutoRead);
        syncAutoRead();
        return () => {
            unsubscribe();
            boundScope = null;
            settingsStore.attachScope(null);
        };
    });
    ctx.effect(() => () => settingsStore.dispose(), 'dsh-voice: settings page lifetime');
    void settingsStore.start();
    const settingsSource = {
        getSnapshot: () => settingsStore.getSnapshot(),
        subscribe: (cb) => settingsStore.subscribe(cb),
    };
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'voice',
        // 40 排在模型(10)之后,但仍在插件配置页之前:语音是常用设置,
        // 但不如模型选择那么"每次都要动"。
        order: 40,
        label: () => '语音',
        inject: () => ({
            store: settingsStore,
            hooks: { settings: settingsSource },
        }),
    }, VoiceSettingsSection));
    // 行内 config 只到 host 半;client 半从这里取回真实值并覆盖 schema 默认。
    void voice.fetchConfig().then((remote) => {
        if (disposed) return;
        if (isVoiceEngine(remote.engine)) {
            clientConfig.engine = remote.engine;
            runtime.setEngine(remote.engine);
        }
        if (typeof remote.hotkey === 'string' && remote.hotkey.trim() !== '' && remote.hotkey !== clientConfig.hotkey) {
            clientConfig.hotkey = remote.hotkey;
            hotkey = parseHotkey(remote.hotkey);
            configEvents.emit();
        }
    }).catch((err) => {
        console.warn('dsh-voice: /voice.config 不可用,使用 client 默认配置', err);
    });
}
