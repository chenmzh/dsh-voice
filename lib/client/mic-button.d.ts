/**
 * MicButton —— 输入区左侧的语音输入按钮(平台设计系统风格)。
 * 外观:dsh-client-ui-primitives 的 Button 原子 + 平台/自绘图标;
 * 空闲 = 麦克风描边图标,聆听中 = 红色停止图标。
 * 点按 = 一轮识别(兼作浏览器自动播放策略下麦克风权限的用户手势);
 * 停麦后识别文本经 conversation 服务提交(与打字同路,任何 preset 通用)。
 */
import { type ReactElement } from 'react';
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** 自绘麦克风描边图标(平台图标库无 mic;风格对齐 icons/index.tsx:16×16 描边 1.5)。 */
export declare function IconMicrophoneOutline16(): ReactElement;
/** slot inject 面:纯数据 + 回调 + 标准 hooks compartment。 */
export interface VoiceMicInject {
    /** 开关本轮识别(纯回调;运行时状态经 hooks 只读进入组件) */
    onToggle: () => void;
    hooks: {
        listening: HostObservable<boolean>;
        starting: HostObservable<boolean>;
        partial: HostObservable<string>;
        /** 快捷键的人类可读标签(host 同步配置后会自动刷新) */
        hotkey: HostObservable<string>;
    };
}
export type MicButtonProps = PropsRuntime<'conversation.input.left'> & InjectFace<VoiceMicInject>;
export declare function MicButton(props: MicButtonProps): ReactElement;
