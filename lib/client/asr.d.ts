import { type MicCapture } from './audio.js';
import type { AsrChunkPayload, AsrChunkResponse, ResolvedEngine } from '../types.js';
export interface SpeechRecognizer {
    start(): Promise<void>;
    stop(): Promise<void>;
    onText(cb: (text: string, final: boolean) => void): () => void;
    onError(cb: (err: Error) => void): () => void;
    onEnd(cb: () => void): () => void;
}
/** 按引擎构造识别器(默认工厂;engine 值到适配器的唯一映射)。 */
export declare function createRecognizer(engine: ResolvedEngine, sessionId: string, callAsr: (payload: AsrChunkPayload) => Promise<AsrChunkResponse>): SpeechRecognizer;
/** 浏览器 Web Speech API 识别(V0.5,零原生依赖,在线)。 */
export declare class WebSpeechRecognizer implements SpeechRecognizer {
    private readonly lang;
    private readonly finalizeTimeoutMs;
    private recognition;
    private readonly text;
    private readonly errors;
    private readonly ends;
    /** 已收到定稿(final 到达即置位;停麦时无需再等) */
    private finalized;
    /** 是否收到过任何文本(无文本时停麦无需等待) */
    private gotText;
    /** 最近一次停止是否由用户发起(区分自然结束) */
    private userStopped;
    private stopPromise;
    private finalWaiter;
    constructor(lang?: string, finalizeTimeoutMs?: number);
    start(): Promise<void>;
    stop(): Promise<void>;
    onText(cb: (delta: string, final: boolean) => void): () => void;
    onError(cb: (err: Error) => void): () => void;
    onEnd(cb: () => void): () => void;
}
export interface NativeRecognizerOptions {
    sessionId: string;
    callAsr: (payload: AsrChunkPayload) => Promise<AsrChunkResponse>;
    /** 采声(默认 navigator 采麦 + ScriptProcessor;测试注入替身) */
    capture?: (onChunk: (int16: Int16Array) => void) => Promise<MicCapture>;
}
/**
 * 原生识别:浏览器采声 → base64 PCM 分块 → host 原生 ASR → 增量文本回传。
 * 自持采声,内部完成 采声→编码→分块推送 全链路;调用方只负责开始/停止。
 * 分块经内部 promise 链串行化,不依赖平台 RPC 对并发调用的保序。
 * 单块 RPC 失败在内部吸收(记日志继续),不打断本轮;
 * 只有采声失败会在 start() 时 reject。
 * final 交付"本轮累计定稿全文":host 的 VAD 每段独立定稿回传,
 * 这里内部累计成替换式全文,与 WebSpeechRecognizer 语义对齐。
 */
export declare class NativeRecognizer implements SpeechRecognizer {
    private readonly options;
    private readonly text;
    private readonly errors;
    private readonly ends;
    /** 串行推送链:前一块 dispatch 完成后才发下一块 */
    private queue;
    private capture;
    private stopped;
    private stopPromise;
    /** 本轮累计定稿文本(start() 重置) */
    private finalizedText;
    constructor(options: NativeRecognizerOptions);
    start(): Promise<void>;
    private onChunk;
    private enqueue;
    private dispatch;
    stop(): Promise<void>;
    onText(cb: (delta: string, final: boolean) => void): () => void;
    onError(cb: (err: Error) => void): () => void;
    onEnd(cb: () => void): () => void;
}
