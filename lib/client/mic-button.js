import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { IconStopFill16 } from '@deepseek-ai/dsh-client-ui-primitives';
/** 自绘麦克风描边图标(平台图标库无 mic;风格对齐 icons/index.tsx:16×16 描边 1.5)。 */
export function IconMicrophoneOutline16() {
    return (_jsxs("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", children: [_jsx("rect", { x: "6", y: "2.75", width: "4", height: "6.75", rx: "2", stroke: "currentColor", strokeWidth: "1.5" }), _jsx("path", { d: "M3.75 7.25a4.25 4.25 0 0 0 8.5 0", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }), _jsx("path", { d: "M8 11.75v1.5M5.25 13.25h5.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" })] }));
}
export function MicButton(props) {
    const { onToggle } = props;
    const listening = props.useListening(value => value);
    const starting = props.useStarting(value => value);
    const partial = props.usePartial(value => value);
    const hotkey = props.useHotkey(value => value);
    const title = starting ? partial + '（点击取消录音）' : listening
        ? (partial !== '' ? partial + '（点击停止并写入草稿）' : '正在听…点击停止并写入草稿')
        : '语音输入(' + hotkey + ')';
    return (_jsx(Button, { variant: "toolbar", size: "sm", icon: listening
            ? _jsx(IconStopFill16, { style: { color: 'var(--dsw-alias-danger, #d33)' } })
            : _jsx(IconMicrophoneOutline16, {}),
        "aria-label": starting ? title : listening ? '停止语音输入' : '开始语音输入',
        "aria-busy": starting, title,
        children: starting ? _jsx('span', { role: 'status', children: '语音加载中…' }) : undefined,
        style: listening ? { color: 'var(--dsw-alias-danger, #d33)' } : undefined, onClick: onToggle }));
}
