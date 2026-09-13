/**
 * 音频采集与编解码(纯函数 + 浏览器采集;零依赖,可单测)。
 */
/** 识别要求的采样率(host VAD/ASR 的输入约定)。 */
export declare const ASR_SAMPLE_RATE = 16000;
/** 麦克风采集句柄(stop 幂等)。 */
export interface MicCapture {
    stop(): void;
}
/** 采集麦克风 PCM(Int16 16kHz 单声道)。
 * MicCapture seam 由两个 adapter 支撑:生产(ScriptProcessor)+ 测试替身
 * (测试注入 capture)——两 adapter 即成真 seam。 */
export declare function capturePcm(onChunk: (int16: Int16Array) => void): Promise<MicCapture>;
/** Float32 → Int16(限幅)。 */
export declare function floatToInt16(input: Float32Array): Int16Array;
/** 线性插值重采样(仅当浏览器实际采样率 ≠ 16k 时使用)。 */
export declare function linearResample(input: Float32Array, fromRate: number, toRate: number): Float32Array;
/** Int16 PCM → base64(分片避开 String.fromCharCode 栈限制)。 */
export declare function encodeBase64(int16: Int16Array): string;
