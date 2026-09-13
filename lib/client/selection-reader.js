/** Read rendered text verbatim: selecting a table/code paragraph must not drop it. */
const MESSAGE = '[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="user"], [data-chat-flow-kind="steering"], [data-turn-tail]';
const EXCLUDED = 'button, input, textarea, select, [contenteditable="true"], [role="textbox"]';

export function selectedPassage(doc = document) {
    const selection = doc.defaultView.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    const element = node => node.nodeType === 1 ? node : node.parentElement;
    const start = element(range.startContainer), end = element(range.endContainer);
    const message = start?.closest(MESSAGE);
    if (!message || message !== end?.closest(MESSAGE) || !message.isConnected) return null;
    if (start.closest(EXCLUDED) || end.closest(EXCLUDED) || range.cloneContents().querySelector(EXCLUDED)) return null;
    const text = selection.toString().trim();
    if (!/[\p{L}\p{N}]/u.test(text)) return null;
    const rects = range.getClientRects();
    const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
    return { text, rect, message };
}

export function installSelectionReader(tts, doc = document) {
    const win = doc.defaultView;
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.dshVoiceSelection = '';
    button.hidden = true;
    button.style.cssText = 'position:fixed;z-index:10000;max-width:calc(100vw - 16px);padding:7px 12px;border:1px solid var(--dsw-alias-border-l2,#777);border-radius:8px;background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:0 3px 14px #0003;font:13px/1.4 sans-serif;cursor:pointer;';
    doc.body.append(button);
    let passage = null, reading = false, disposed = false, readGeneration = 0, readText = null;
    const syncLabel = () => {
        const state = tts.getSnapshot();
        if (reading && (readGeneration !== tts.speechGeneration || (!state.busy && !state.speaking))) reading = false;
        const active = reading && passage?.text === readText;
        button.textContent = active ? '停止朗读' : '朗读所选';
        button.setAttribute('aria-label', button.textContent);
        button.title = active ? '停止朗读选中的文字' : '使用当前音色朗读选中的文字';
    };
    const update = () => {
        if (disposed) return;
        const next = selectedPassage(doc);
        // Keyboard focus on the button must not discard the captured range.
        if (!next && doc.activeElement === button && passage?.message.isConnected) return;
        passage = next;
        button.hidden = !passage;
        if (!passage) return;
        const { rect } = passage;
        if (rect.bottom < 0 || rect.top > win.innerHeight) { button.hidden = true; return; }
        syncLabel();
        button.style.left = `${Math.max(8, Math.min(rect.left, win.innerWidth - button.offsetWidth - 8))}px`;
        const below = rect.bottom + 8;
        button.style.top = `${Math.max(8, below + button.offsetHeight < win.innerHeight ? below : rect.top - button.offsetHeight - 8)}px`;
    };
    const preserve = event => event.preventDefault();
    button.addEventListener('mousedown', preserve);
    button.addEventListener('click', () => {
        if (reading && passage?.text === readText) { tts.stop(); reading = false; syncLabel(); return; }
        if (!passage?.message.isConnected) return;
        const text = passage.text;
        reading = true;
        readText = text;
        readGeneration = tts.speechGeneration + 1;
        const generation = readGeneration;
        void tts.speakText(text, { plainText: true }).finally(() => { if (!disposed && generation === readGeneration) { reading = false; syncLabel(); } });
        syncLabel();
    });
    const escape = event => {
        if (event.key !== 'Escape') return;
        if (reading) tts.stop();
        button.hidden = true;
        passage = null;
    };
    const keyup = event => { if (event.key !== 'Escape') update(); };
    const unsubscribe = tts.subscribe(syncLabel);
    doc.addEventListener('selectionchange', update);
    doc.addEventListener('mouseup', update);
    doc.addEventListener('keyup', keyup);
    doc.addEventListener('keydown', escape);
    doc.addEventListener('scroll', update, true);
    win.addEventListener('resize', update);
    return () => {
        disposed = true;
        unsubscribe();
        doc.removeEventListener('selectionchange', update);
        doc.removeEventListener('mouseup', update);
        doc.removeEventListener('keyup', keyup);
        doc.removeEventListener('keydown', escape);
        doc.removeEventListener('scroll', update, true);
        win.removeEventListener('resize', update);
        button.remove();
    };
}
