import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
/**
 * 每条已定稿回复右下角的朗读按钮。
 *
 * 这个槽位只在"本轮最后一条已定稿的助手消息"上渲染,所以消息一定是完整的 ——
 * 不需要自己判断"回复是否结束",也不会读到半截文本。
 * 自绘喇叭图标:平台图标库里没有音量/朗读图标(与 mic-button 同一做法)。
 */
export function IconSpeakerOutline16() {
    return (_jsxs("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", children: [_jsx("path", { d: "M8.25 3.25 4.75 6H2.75v4h2l3.5 2.75V3.25Z", stroke: "currentColor", strokeWidth: "1.5", strokeLinejoin: "round" }), _jsx("path", { d: "M10.75 5.75a3.25 3.25 0 0 1 0 4.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }), _jsx("path", { d: "M12.75 3.75a6 6 0 0 1 0 8.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" })] }));
}
/** 停止/静音图标:朗读中显示,点了就停。 */
export function IconMuteOutline16() {
    return (_jsxs("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", children: [_jsx("path", { d: "M8.25 3.25 4.75 6H2.75v4h2l3.5 2.75V3.25Z", stroke: "currentColor", strokeWidth: "1.5", strokeLinejoin: "round" }), _jsx("path", { d: "M10.75 6.5l3 3M13.75 6.5l-3 3", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" })] }));
}
export function SpeakButton(props) {
    const { messageId, onSpeak } = props;
    const busy = props.useTts(value => value.busy);
    const speaking = props.useTts(value => value.speaking);
    const speakingId = props.useTts(value => value.speakingMessageId);
    const active = speakingId === messageId && (speaking || busy);
    const title = active
        ? '停止朗读'
        : speaking || busy
            ? '朗读这条回复(会打断当前朗读)'
            : '朗读这条回复';
    return (_jsx(Button, { variant: "toolbar", size: "sm", icon: active ? _jsx(IconMuteOutline16, {}) : _jsx(IconSpeakerOutline16, {}), "aria-label": title, title, "aria-pressed": active ? 'true' : 'false', style: active ? { color: 'var(--dsw-alias-brand, #4a7dff)' } : undefined, onClick: () => onSpeak(messageId) }));
}
