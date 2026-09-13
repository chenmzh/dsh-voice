/**
 * HostAsr —— host 侧识别会话池 + asr 端点逻辑(deep module)。
 *
 * 接口:handle(model, req) → 线协议结果。内部独占:
 * base64 → Int16 解码、按 sessionId 的识别会话池(LRU 驱逐)、
 * feed 与错误映射 —— 全部可经假模型直接单测,不需要真模型。
 *
 * seam:AsrModelFace / AsrSessionFace 两个结构形状 —— OnnxModel 零改动
 * 即满足(真实 adapter),测试假模型是第二个 adapter,接缝成真。
 *
 * 驱逐策略:maxSessions 满时逐出最久未用的会话,经 log 回调留痕。
 * 被逐出的会话若还在说话,VAD 状态从零开始、一句话会被拆断 ——
 * 这是有意的容量取舍(防 VAD 状态无界累积),非 bug。
 */
import type { RpcResult } from '@deepseek-ai/dsh-client-connection';
import type { AsrChunkPayload, AsrChunkResponse } from '../types.js';
/** 一次识别会话的喂入面(feed 结果只经返回值交付)。 */
export interface AsrSessionFace {
    feed(int16: Int16Array, final: boolean): {
        partial: string;
        finals: string[];
    };
}
/** 模型面(开一个新识别会话;模型未加载返回 null)。 */
export interface AsrModelFace {
    openSession(): AsrSessionFace | null;
}
export interface HostAsrOptions {
    /** 同时存活的识别会话上限(LRU 淘汰) */
    maxSessions?: number;
    /** 会话被驱逐 / feed 失败时的留痕回调(默认静默) */
    log?: (message: string) => void;
}
export declare class HostAsr {
    private readonly sessions;
    private readonly maxSessions;
    private readonly log;
    /** 单调时钟:lastUsed 用计数而非墙钟,LRU 顺序确定可测 */
    private tick;
    constructor(options?: HostAsrOptions);
    /** 处理一块 asr payload:解码 → 会话池取会话 → feed → 线协议结果。 */
    handle(model: AsrModelFace, req: AsrChunkPayload): RpcResult<AsrChunkResponse>;
    /** 按 sessionId 取独立识别会话(LRU 淘汰最久未用的)。 */
    private sessionFor;
}
