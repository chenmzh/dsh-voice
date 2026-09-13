/**
 * dsh-voice client 半(浏览器)。
 * 挂一个麦克风按钮到 conversation.input.left;按钮负责一轮语音识别,
 * 识别文本经 conversation 服务提交(与打字同路)。另注册全局快捷键
 * (默认 Ctrl+Space)开关麦克风;输入框聚焦时不触发,避免与输入法冲突。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
export declare const name = "dsh-voice";
export declare const inject: string[];
export declare function apply(ctx: ClientContext, config?: {
    engine?: unknown;
    hotkey?: unknown;
}): void;
