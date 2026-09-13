/** Keep the host's existing copy/feedback/speech toolbar discoverable in history. */
export const MESSAGE_ACTIONS_CSS = `
/* A completed turn tail ends with the host MessageIconActions row.
   The host otherwise hides this row when that turn is no longer the latest. */
[data-turn-tail][data-actions-reveal] > :last-child {
    opacity: 1 !important;
}
/* User and steering copy rows use the same CSS module, without a turn-tail marker.
   Match its stable class suffix rather than a build-specific hash prefix. */
:is([data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]) :is([class$="_actions"], [class*="_actions "]) {
    opacity: 1 !important;
}
`;

export function installMessageActions(doc = document) {
    const style = doc.createElement('style');
    style.dataset.plugin = '@nn12138/dsh-voice';
    style.dataset.pluginCss = '@nn12138/dsh-voice/message-actions';
    style.textContent = MESSAGE_ACTIONS_CSS;
    doc.head.appendChild(style);
    return () => style.remove();
}
