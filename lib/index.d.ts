/**
 * dsh-voice host 半(web profile 的 Node 侧)。
 * 纯语音输入:/voice RPC 通道(connection.rpc,loopback authority)接收浏览器
 * 采麦 PCM → 流式 ASR(sherpa-onnx-node zipformer2 + silero VAD)→ 增量文本回传。
 * 与 agent preset 解耦:任何 preset(code/standard/minimal/whale/…)下都只是
 * "另一种输入法",回复展示由会话本身负责。
 * 模型权重全局一份;识别状态按 sessionId 隔离(识别会话池 + LRU 上限见
 * core/host-asr.ts),并发会话不串音。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { OnnxModel } from './core/native-asr.js';
import type { VoiceEngine } from './types.js';
export declare const name = "dsh-voice-host";
export declare const inject: string[];
/** host 半配置:引擎开关 + 模型选项。默认值单一来源在 core/config.ts;
 * 字段形状与 AsrModelOptions 同形(new OnnxModel(config) 直接透传)。
 * engine/hotkey 与 client 半共用同一行 config:web shell 不会把行内 config
 * 传给 client apply,由 host 经 /voice.config loopback RPC 同步。
 * host 半的 auto = 有模型就提供 native(引擎决策在 host 半,见 core/engine.ts,
 * 客户端只消费 ping/config 下发的生效引擎)。 */
export interface Config {
    nativeBackend: 'zipformer' | 'qwen' | 'whisper';
    pythonExecutable: string;
    pythonModelDir: string;
    qwenModelDir: string;
    whisperModelDir: string;
    asrDevice: 'cuda' | 'cpu';
    /** 'browser' = 强制关闭原生识别;'native'/'auto' = 有模型就提供原生识别 */
    engine: VoiceEngine;
    /** 模型根目录的绝对路径 */
    modelDir: string;
    /** VAD 静音阈值(0-1);越低越不容易吞句首/句尾,但更容易把噪声当语音(voxelf 生产值 0.3) */
    vadThreshold: number;
    /** 尾音补偿时长(秒);VAD 段后追加的音频时长,补偿渐弱尾音(voxelf 生产值 0.6) */
    tailPadSeconds: number;
    /** ASR 模型子目录: asr-zh(纯中文,默认)| asr-zh-en-2025(中英双语) */
    asrDir: string;
    /** 全局快捷键(host 只负责镜像给 client;真实消费方在浏览器半) */
    hotkey: string;
}
export declare const Config: z<Config>;
/** 测试/替换 seam(默认即生产实现):模型加载器注入,host 端点可无模型直测。 */
export interface HostDeps {
    /** 加载 ASR 模型(默认:OnnxModel 懒加载;测试注入替身) */
    loadModel?: () => Promise<OnnxModel | null>;
}
export declare function apply(ctx: Context, config: Config, deps?: HostDeps): void;
