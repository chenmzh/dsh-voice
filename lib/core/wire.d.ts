/**
 * /voice 线协议的运行时约定(两侧共享):通道/端点常量、错误类型、信封构造。
 * 类型定义在 types.ts;这里只放值 —— 加端点只改这一个文件。
 */
import type { RpcResult } from '@deepseek-ai/dsh-client-connection';
export declare const VOICE_CHANNEL = "/voice";
export declare const VOICE_ENDPOINTS: {
    readonly ping: "ping";
    readonly config: "config";
    readonly asr: "asr";
};
export type VoiceEndpoint = (typeof VOICE_ENDPOINTS)[keyof typeof VOICE_ENDPOINTS];
/** 带错误码的 RPC 错误:host 的错误分类经 code 穿越 wire,客户端可区分。 */
export declare class VoiceRpcError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** 宿主侧错误信封构造(消灭手写 { ok:false, error:{...} })。 */
export declare function rpcError(code: string, message: string): RpcResult<never>;
