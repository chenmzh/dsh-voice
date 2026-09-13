import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';

const PANEL_WIDTH = 380;
const PANEL_MAX_HEIGHT = 460;
/** 面板翻到按钮下方所需的最小上方空间;低于这个值就改用下方定位。 */
const MIN_SPACE_ABOVE = 220;

const panelStyle = {
    position: 'fixed',
    zIndex: 3000,
    width: PANEL_WIDTH,
    maxHeight: PANEL_MAX_HEIGHT,
    // 必须显式 border-box:面板 portal 到 body,拿不到应用里那条全局 box-sizing
    // 规则,默认 content-box 会让 max-height 不含 10px padding + 边框 ——
    // 按 max-height 夹出来的位置实际会多出 22px 从顶部溢出(实测 y=-12)。
    boxSizing: 'border-box',
    overflowY: 'auto',
    padding: '10px',
    borderRadius: '10px',
    border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.3))',
    background: 'var(--dsw-alias-bg-elevated, #1e1f24)',
    color: 'inherit',
    boxShadow: '0 12px 32px rgba(0,0,0,0.32)',
    fontSize: '12px',
    lineHeight: '1.5',
};

const sectionTitleStyle = {
    margin: '10px 0 6px',
    fontSize: '11px',
    opacity: 0.66,
    letterSpacing: '0.02em',
};

/** 参考音频目录那一行说明:路径可能很长,必须允许折行。 */
const hintStyle = {
    marginTop: '6px',
    fontSize: '11px',
    lineHeight: 1.5,
    opacity: 0.62,
    wordBreak: 'break-word',
};

const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '7px 8px',
    borderRadius: '8px',
    border: '1px solid transparent',
    background: 'transparent',
    color: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    font: 'inherit',
};

function badge(text, tone) {
    const colors = {
        ok: 'var(--dsw-alias-success, #3fa96a)',
        busy: 'var(--dsw-alias-warning, #d39a2e)',
        off: 'var(--dsw-alias-text-secondary, #8a8f99)',
    };
    return _jsx('span', { style: { color: colors[tone] ?? colors.off, fontSize: '11px', whiteSpace: 'nowrap' }, children: text });
}

/** 面板里 select 的统一外观。 */
const selectStyle = {
    flex: 1, minWidth: 0, padding: '5px 6px', borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.3))',
    background: 'var(--dsw-alias-bg-elevated, #1e1f24)', color: 'inherit', font: 'inherit',
};

function optionValue(item) {
    if (typeof item === 'string')
        return item;
    return String(item?.id ?? item?.name ?? '');
}

function optionLabel(item) {
    if (typeof item === 'string')
        return item;
    return String(item?.label ?? item?.name ?? optionValue(item));
}

/** 从 Kokoro 那种 "zh=<zh>,en=<en>" 成对音色串里取某个键(取不到返回空串)。 */
function pairPart(voice, key) {
    for (const part of String(voice ?? '').split(',')) {
        const at = part.indexOf('=');
        if (at !== -1 && part.slice(0, at).trim() === key)
            return part.slice(at + 1).trim();
    }
    return '';
}

/** 覆盖成对音色串里的一个键,保留其他键(例:换中文音色不动英文音色)。 */
function pairWith(voice, key, value) {
    const pairs = new Map();
    for (const part of String(voice ?? '').split(',')) {
        const at = part.indexOf('=');
        if (at !== -1)
            pairs.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    pairs.set(key, value);
    return [...pairs].map(([k, v]) => `${k}=${v}`).join(',');
}

/** 引擎状态徽标:用户要能一眼看出"显存里现在是谁"。 */
function engineState(engine, preferred, active, status) {
    if (!engine.installed)
        return badge('未安装', 'off');
    if (active === engine.id && status === 'loading')
        return badge('加载中…', 'busy');
    if (active === engine.id)
        return badge('已加载', 'ok');
    if (preferred === engine.id && status === 'loading')
        return badge('加载中…', 'busy');
    return null;
}

export function TtsPicker(props) {
    const { onSelect, onUnload, onAutoRead, onSetVoice, onLoadVoices } = props;
    const engines = props.useTts(value => value.engines);
    const preferred = props.useTts(value => value.preferred);
    const active = props.useTts(value => value.active);
    const status = props.useTts(value => value.status);
    const error = props.useTts(value => value.error);
    const note = props.useTts(value => value.note);
    const autoRead = props.useTts(value => value.autoRead);
    const voice = props.useTts(value => value.voice);
    const voiceGroups = props.useTts(value => value.voiceGroups);
    const voiceKind = props.useTts(value => value.voiceKind);
    const refDir = props.useTts(value => value.refDir);
    const vram = props.useTts(value => value.vramUsedMb);
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState(null);
    const buttonRef = useRef(null);

    // 面板挂到 body 上:输入框那一列有 overflow 裁剪,留在原地会被切掉。
    // 定位必须保证面板整个落在视口内 —— 只按按钮位置算 bottom 会让高面板从
    // 顶部溢出(实测 757px 高视口 + 434px 面板时 y 到了 -12,标题被切掉),
    // 所以这里先量可用空间,再决定翻到上方还是下方,并据此夹住 maxHeight。
    const place = () => {
        const rect = buttonRef.current?.getBoundingClientRect();
        if (!rect)
            return;
        const roomAbove = rect.top - 8;
        const roomBelow = window.innerHeight - rect.bottom - 8;
        const right = Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - PANEL_WIDTH - 8));
        if (roomAbove >= MIN_SPACE_ABOVE || roomAbove >= roomBelow) {
            setAnchor({ side: 'above', offset: Math.max(8, window.innerHeight - rect.top + 8), right, maxHeight: Math.max(160, Math.min(PANEL_MAX_HEIGHT, roomAbove - 8)) });
            return;
        }
        setAnchor({ side: 'below', offset: Math.max(8, rect.bottom + 8), right, maxHeight: Math.max(160, Math.min(PANEL_MAX_HEIGHT, roomBelow - 8)) });
    };
    useEffect(() => {
        if (!open)
            return;
        place();
        const onDown = event => {
            if (buttonRef.current?.contains(event.target))
                return;
            const panel = document.getElementById('dsh-voice-tts-panel');
            if (panel?.contains(event.target))
                return;
            setOpen(false);
        };
        const onKey = event => {
            if (event.key === 'Escape')
                setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', place);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', place);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const selected = engines.find(engine => engine.id === preferred);
    const label = selected ? `${selected.medal} ${selected.label}` : (preferred ?? '朗读');
    const busy = status === 'loading';
    const title = active
        ? `${label}（显存中:${engines.find(e => e.id === active)?.label ?? active}）`
        : `${label}（未加载,首次朗读时才加载）`;

    // 音色选择:单组(多数引擎)= 一个下拉;多组(Kokoro 的 zh/en)= 每个语言一个
    // 下拉,改哪个只覆盖哪个键,拼回 "zh=..,en=.." 成对串交给 setVoice。
    const voiceSelects = voiceGroups.length === 0
        ? [_jsx('select', {
                key: 'voice-empty', style: selectStyle, value: voice, disabled: true,
                children: _jsx('option', { value: voice, children: voice || '（尚未载入音色列表)' }),
            })]
        : voiceGroups.flatMap(group => {
            const isSingle = group.key === null;
            const current = isSingle ? voice : pairPart(voice, group.key);
            const missing = current !== '' && !group.items.some(item => optionValue(item) === current);
            const nodes = [];
            if (!isSingle)
                nodes.push(_jsx('div', { key: `lg-${group.key}`, style: { fontSize: '11px', opacity: 0.6 }, children: group.label }));
            nodes.push(_jsxs('select', {
                key: `sel-${group.key ?? 'single'}`,
                style: selectStyle,
                value: current,
                onChange: event => onSetVoice(isSingle ? event.target.value : pairWith(voice, group.key, event.target.value)),
                children: [
                    // 当前值不在列表里(默认音色名、或列表不含它)时也要能显示出来。
                    current === '' || missing ? _jsx('option', { value: current, children: current || '（未选择)' }) : null,
                    ...group.items.map(item => _jsx('option', { value: optionValue(item), children: optionLabel(item) }, optionValue(item))),
                ],
            }));
            return nodes;
        });

    const panel = open && anchor
        ? createPortal(_jsxs('div', {
            id: 'dsh-voice-tts-panel',
            style: {
                ...panelStyle,
                maxHeight: anchor.maxHeight,
                ...(anchor.side === 'above' ? { bottom: anchor.offset } : { top: anchor.offset }),
                right: anchor.right,
            },
            'data-dsh-voice-side': anchor.side,
            role: 'dialog',
            'aria-label': '朗读设置',
            children: [
                _jsx('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }, children: [
                    _jsx('strong', { style: { fontSize: '12px' }, children: '朗读设置' }),
                    _jsx('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }, children: [
                        _jsx('input', { type: 'checkbox', checked: autoRead, onChange: event => onAutoRead(event.target.checked) }),
                        '自动朗读新回复',
                    ] }),
                ] }),
                _jsx('div', { style: sectionTitleStyle, children: '回复用哪个模型读（换模型会先卸载旧的)' }),
                ...engines.map(engine => {
                    const isPreferred = engine.id === preferred;
                    const state = engineState(engine, preferred, active, status);
                    return _jsxs('button', {
                        type: 'button',
                        key: engine.id,
                        onClick: () => onSelect(engine.id),
                        title: engine.blurb,
                        style: {
                            ...rowStyle,
                            borderColor: isPreferred ? 'var(--dsw-alias-brand, #4a7dff)' : 'transparent',
                            background: isPreferred ? 'rgba(74,125,255,0.10)' : 'transparent',
                            opacity: engine.installed ? 1 : 0.55,
                        },
                        children: [
                            _jsx('span', { style: { width: '18px', textAlign: 'center' }, children: engine.medal }),
                            _jsxs('span', { style: { flex: 1, minWidth: 0 }, children: [
                                _jsxs('span', { style: { display: 'flex', alignItems: 'center', gap: '6px' }, children: [
                                    _jsx('span', { style: { fontWeight: isPreferred ? 600 : 400 }, children: engine.label }),
                                    state,
                                ] }),
                                _jsx('span', { style: { display: 'block', opacity: 0.6, fontSize: '11px' }, children: `${engine.voiceKind === 'preset' ? '预置音色' : '可克隆'} · RTF ${engine.rtf} · 约 ${engine.vramGb}GB${engine.commercial ? '' : ' · 仅非商用'}` }),
                            ] }),
                        ],
                    });
                }),
                _jsx('div', { style: sectionTitleStyle, children: voiceKind === 'preset' ? '人声（预置音色)' : '人声（参考音频克隆)' }),
                _jsxs('div', { style: { display: 'flex', gap: '6px', alignItems: 'stretch' }, children: [
                    _jsx('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }, children: voiceSelects }),
                    _jsx(Button, { variant: 'toolbar', size: 'sm', onClick: () => onLoadVoices(), children: '载入音色' }),
                ] }),
                // 克隆引擎的"音色"就是一段参考音频,所以这里必须告诉用户文件放哪儿 ——
                // 否则那个下拉看起来就只有出厂那两段,像是"不能换"。
                voiceKind === 'preset' ? null : _jsxs('div', { style: hintStyle, children: [
                    '克隆音色 = 参考音频:把 3~10 秒干净人声 wav 放进 ',
                    _jsx('code', { style: { opacity: 0.9, wordBreak: 'break-all' }, children: refDir || '（未配置参考音频目录)' }),
                    ',同名 .txt 写上这段音频说了什么(更准)。放好后点「载入音色」,它会出现在上面的下拉里。',
                ] }),
                _jsx('div', { style: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.22))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }, children: [
                    _jsxs('span', { style: { opacity: 0.66, fontSize: '11px' }, children: [
                        vram === null || vram === undefined ? '显存:未知' : `整卡已用显存:${vram} MB`,
                        active ? ` · 驻留:${engines.find(e => e.id === active)?.label ?? active}` : ' · 当前未加载任何模型',
                    ] }),
                    _jsx(Button, { variant: 'toolbar', size: 'sm', disabled: !active, onClick: () => onUnload(), children: '卸载模型' }),
                ] }),
                error ? _jsx('div', { style: { marginTop: '6px', color: 'var(--dsw-alias-danger, #d33)', fontSize: '11px' }, children: error }) : null,
                note ? _jsx('div', { style: { marginTop: '4px', opacity: 0.7, fontSize: '11px' }, children: note }) : null,
            ],
        }), document.body)
        : null;

    return _jsxs('span', { style: { display: 'inline-flex', alignItems: 'center' }, children: [
        _jsx('span', { ref: buttonRef, style: { display: 'inline-flex' }, children: _jsxs(Button, {
            variant: 'toolbar',
            size: 'sm',
            'aria-label': '朗读设置',
            'aria-expanded': open ? 'true' : 'false',
            title,
            onClick: () => setOpen(value => !value),
            icon: busy ? _jsx('span', { role: 'status', children: '…' }) : _jsx(IconChevronDownOutline14, {}),
            children: label,
        }) }),
        panel,
    ] });
}
