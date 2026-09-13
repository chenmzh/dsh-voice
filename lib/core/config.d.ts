/**
 * 配置的单一事实来源:引擎取值集合、全插件默认值、运行时值守卫。
 * host schema 默认、native-asr 回退、client 竞态兜底都从这里取 ——
 * 默认值与引擎值集只写一次。
 */
import type { VoiceEngine } from '../types.js';
/** 引擎取值集合(host schema 与 isVoiceEngine 守卫同源)。 */
export declare const ENGINE_VALUES: readonly ["auto", "browser", "native"];
/** 全插件默认值(单一来源;两半 + native-asr 共用)。 */
export declare const DEFAULTS: {
    readonly engine: "auto";
    readonly hotkey: "ctrl+space";
    readonly modelDir: "";
    readonly vadThreshold: 0.3;
    readonly tailPadSeconds: 0.6;
    readonly asrDir: "asr-zh";
};
/** 运行时值守卫(RPC 下发的 engine 未经验证;host schema 覆盖不到的兜底)。 */
export declare function isVoiceEngine(value: unknown): value is VoiceEngine;
