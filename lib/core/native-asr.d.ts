/** 原生 ASR 模型选项(host 的 Config 与其同形;可选字段回退值取 core/config.ts
 * 的共享 DEFAULTS,单一来源,避免默认值双写)。 */
export interface AsrModelOptions {
    /** 模型根目录的绝对路径 */
    modelDir: string;
    /** ASR 模型子目录: asr-zh(纯中文)| asr-zh-en-2025(中英双语,均 zipformer2) */
    asrDir?: string;
    /** VAD 静音阈值(0-1;对齐 voxelf 默认 0.3) */
    vadThreshold?: number;
    /** 判定一句话说完的尾部静音秒数(对齐 voxelf 默认 0.5) */
    minSilenceSeconds?: number;
    /** 尾音补偿时长(秒):VAD 段弹出后追加段后的音频再识别,
     * 补偿渐弱尾音被 VAD 截断(voxelf 的 vad_tail_pad,默认 0.6) */
    tailPadSeconds?: number;
}
interface OnlineRecognizerLike {
    createStream(): OnlineStreamLike;
    isReady(stream: unknown): boolean;
    decode(stream: unknown): void;
    getResult(stream: unknown): {
        text: string;
    };
}
interface OnlineStreamLike {
    acceptWaveform(chunk: {
        sampleRate: number;
        samples: Float32Array;
    }): void;
    inputFinished(): void;
}
interface VadLike {
    acceptWaveform(samples: Float32Array): void;
    isDetected(): boolean;
    isEmpty(): boolean;
    front(): {
        samples: Float32Array;
    };
    pop(): void;
    flush(): void;
}
interface OnnxModuleLike {
    OnlineRecognizer: new (config: unknown) => OnlineRecognizerLike;
    Vad: new (config: unknown, windowSize: number) => VadLike;
}
/** 共享的模型权重:加载一次,供任意会话 openSession。 */
export declare class OnnxModel {
    private readonly options;
    private onnx;
    private recognizer;
    private loadFailed;
    constructor(options: AsrModelOptions);
    private load;
    start(): Promise<void>;
    /** 打开一个识别会话(权重共享,VAD/流状态独立);模型未加载返回 null。 */
    openSession(): OnnxSession | null;
}
/** 一次识别会话的独立状态:VAD + live partial 流 + 尾音缓冲。 */
export declare class OnnxSession {
    private readonly recognizer;
    private readonly options;
    private readonly vad;
    /** 滚动尾音缓冲:保存最近 tailPadSeconds 的音频,段弹出时追加进识别输入
     * (voxelf tail_buf 机制,补偿渐弱尾音被 VAD 截断) */
    private readonly tailBuf;
    private tailLen;
    /** 当前语音的 live 识别流(边说边出字;VAD 弹出定稿段时 inputFinished) */
    private liveStream;
    constructor(recognizer: OnlineRecognizerLike, onnx: OnnxModuleLike, options: AsrModelOptions);
    /** 喂入一段 Int16 PCM。
     * partial = 当前语音的实时部分识别文本(边说边出字,累计);
     * finals = 本段弹出的定稿句(VAD 判定一句话结束)。
     * final=true 时补静音冲刷尾段;空块(final 收尾)绝不喂给 VAD
     * (native 层对 0 长度 samples 会报 nullptr)。 */
    feed(int16: Int16Array, final: boolean): {
        partial: string;
        finals: string[];
    };
    /** 维护滚动尾音缓冲(容量 = tailPadSeconds)。 */
    private pushTail;
    /** 当前尾音缓冲拼接(voxelf: 追加进每个弹出段的识别输入)。 */
    private tailAudio;
    /** 弹出全部已定稿的 VAD 段:段样本(精确 onset)+ 尾音补偿解码 = 定稿文本;
     * live stream 仅服务 partial,段弹出后作废。 */
    private drain;
}
export {};
