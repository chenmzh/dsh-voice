/** 快捷键解析(纯函数,独立模块便于单测)。 */
export interface ParsedHotkey {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    /** KeyboardEvent.code */
    code: string;
}
/** 解析 "ctrl+space" 形式;无法解析返回 null(快捷键禁用)。 */
export declare function parseHotkey(spec: string): ParsedHotkey | null;
/** 快捷键的人类可读标签(按钮提示用)。 */
export declare function hotkeyLabel(spec: string): string;
