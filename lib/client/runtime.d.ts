/**
 * VoiceRuntime —— 客户端语音运行时(deep module)。
 *
 * 接口(MicButton / 快捷键只碰这几个方法):
 * - getEngine(): 解析后的引擎(browser | native);
 * - isListening() / subscribe(cb): 监听状态与变更通知(供 useSyncExternalStore);
 * - toggleMic(sessionId): 开关一轮识别;
 * - stopMic(sessionId): 停止并提交(幂等,双引擎一致);
 * - getPartial(): 当前部分识别文本(实时回显)。
 *
 * 定稿语义统一:onText(final=true) 交付"本轮累计定稿全文"(替换式);
 * 采声、停麦竞速、自然结束等引擎差异全部关在 adapter 实现里(见 asr.ts),
 * runtime 只按统一契约编排:onEnd → 停麦提交;onError → 终止并丢弃文本。
 * SpeechRecognizer.stop() 契约:resolve 时定稿已交付完毕、resolve 后不再有
 * 任何回调 —— 停麦双提交竞态在结构上不存在,轮次守卫只防"启动期间被打断"。
 * 单麦克风语义:全局同时只有一轮识别;别的会话点停/快捷键会停掉当前轮,
 * 文本仍提交给开启本轮的那个会话(activeSession)。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type SpeechRecognizer } from './asr.js';
import { type VoiceService } from './voice-service.js';
import type { ResolvedEngine, VoiceEngine } from '../types.js';
export interface VoiceRuntimeConfig {
    /** 'auto' = ping host 探测;'browser'/'native' 强制 */
    engine: VoiceEngine;
}
/** 测试/替换 seam(默认即生产实现;外部 interface 不受影响)。 */
export interface VoiceRuntimeDeps {
    /** 按引擎构造识别器(默认:createRecognizer,适配器自持采声) */
    createRecognizer?: (engine: ResolvedEngine, sessionId: string) => SpeechRecognizer;
    /** 提交定稿文本(默认:追加到 conversation 输入草稿，不发送) */
    submit?: (sessionId: string, text: string) => Promise<void>;
    /** /voice 通道调用面(默认:从 ctx.connection.rpc 构建;测试注入替身) */
    rpc?: VoiceService;
}
export declare class VoiceRuntime {
    private readonly ctx;
    private config;
    private engine;
    private listening;
    private recognizer;
    /** 本轮累计定稿文本(停麦时提交;onText(final) 替换式更新) */
    private pendingText;
    /** 当前部分识别文本(边说边出字,未定稿) */
    private partialText;
    /** 轮次守卫:启动被打断、停麦后作废一切迟到回调 */
    private round;
    /** 停止进行中:onEnd/onError 与用户点停并发时防重入 */
    private stopping;
    /** 开启本轮识别的会话;停麦提交一律归它(跨会话点停不串台) */
    private activeSession;
    private readonly listeners;
    private readonly deps;
    constructor(ctx: ClientContext, config: VoiceRuntimeConfig, deps?: VoiceRuntimeDeps);
    /** 每轮 native/auto 点击均调用 /voice.ping，等待模型就绪后才开始采声。 */
    getEngine(): Promise<ResolvedEngine>;
    /**
     * host /voice.config 到达后更新引擎选择。空闲时立即失效解析缓存,
     * 下一轮从新配置开始;正在识别的一轮不打断。
     */
    setEngine(engine: VoiceEngine): void;
    isListening(): boolean;
    isStarting(): boolean;
    /** 取消待启动/录音，释放麦克风，不写入或发送草稿。 */
    dispose(): void;
    subscribe(cb: () => void): () => void;
    private notify;
    /** 开关一轮识别。resolve 表示状态已切换(识别结果在后续回调提交)。 */
    toggleMic(sessionId: string): Promise<void>;
    /** 停止识别;定稿文本非空则追加到输入框草稿，不发送消息。幂等;轮次守卫杜绝迟到回调。 */
    stopMic(sessionId: string): Promise<void>;
    /** 当前部分识别文本(按钮提示实时回显用)。 */
    getPartial(): string;
    private reportMicError;
    private appendDraft;
}
