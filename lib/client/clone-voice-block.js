import { createElement as h, useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { ReferenceRecorder, REFERENCE_SCRIPT, SAMPLE_SCRIPT, availableRefName } from './ref-recorder.js';
import { wavBlob } from './tts-service.js';

function base64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

/** Release audio resources on replacement and when leaving settings. */
function ClipPlayer({ blob, label, autoPlay = false }) {
    const audio = useRef(null);
    const [url, setUrl] = useState('');
    useEffect(() => {
        const next = URL.createObjectURL(blob);
        setUrl(next);
        const element = audio.current;
        return () => { element?.pause(); URL.revokeObjectURL(next); };
    }, [blob]);
    useEffect(() => {
        if (url && autoPlay) void audio.current?.play().catch(() => {});
    }, [url, autoPlay]);
    return h('div', null, h('div', null, label), h('audio', {
        ref: audio, src: url || undefined, controls: true, 'aria-label': label,
        style: { width: '100%', maxWidth: '460px', height: '36px', marginTop: '6px' },
    }));
}

export function CloneVoiceBlock({ state, disabled, store, styles: S, Select }) {
    const fileRef = useRef(null);
    const recorder = useRef(null);
    const request = useRef(0);
    const [recording, setRecording] = useState({ status: 'idle', seconds: 0, wav: null, error: '' });
    const [name, setName] = useState('');
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [raw, setRaw] = useState(null);
    const [preview, setPreview] = useState(null);
    const [previewing, setPreviewing] = useState('');
    const [sample, setSample] = useState(SAMPLE_SCRIPT);
    const engines = (state.engineChoices ?? []).filter(e => e.voiceKind === 'clone' && e.installed !== false);
    const [chosenEngine, setChosenEngine] = useState('');
    const engine = engines.some(e => e.id === chosenEngine) ? chosenEngine
        : engines.find(e => e.id === state.value?.ttsEngine)?.id ?? engines.find(e => e.id === 'cosyvoice3')?.id ?? engines[0]?.id ?? '';
    const capturing = ['starting', 'recording'].includes(recording.status);
    const locked = disabled || busy || state.refsBusy || !!previewing;
    useEffect(() => {
        recorder.current = new ReferenceRecorder(setRecording);
        return () => { request.current++; recorder.current?.dispose(); recorder.current = null; };
    }, []);
    useEffect(() => { setRaw(recording.wav ? new Blob([recording.wav], { type: 'audio/wav' }) : null); }, [recording.wav]);

    const start = () => {
        setError(''); setPreview(null);
        if (!name.trim()) setName(availableRefName(state.refs));
        if (!text.trim()) setText(REFERENCE_SCRIPT);
        void recorder.current?.start();
    };
    const save = async (buffer, ext, fallback, recorded) => {
        const label = (name.trim() || fallback).replace(/\.(wav|flac)$/i, '');
        if (!label || label.length > 100 || /[\u0000-\u001f\u007f/\\:*?"<>|]/.test(label) || /^[.\s]|[.\s]$/.test(label)) {
            setError('请填写有效的音色名（最多 100 个字符，不含路径或特殊符号）。'); return;
        }
        if (state.refs.some(ref => ref.label === label)) {
            setError('已经有同名音色，请换一个名字，避免覆盖之前的录音。'); return;
        }
        setError(''); setBusy(true);
        try {
            const ok = await store.saveRef({ name: label, audio: base64(buffer), text, ext }, recorded ? engine : undefined);
            if (ok) { recorder.current?.cancel(); setName(''); setText(''); }
        } catch (e) { setError(`保存失败：${e?.message ?? e}`); }
        finally { setBusy(false); }
    };
    const onFile = async event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file) return;
        if (!/\.(wav|flac)$/i.test(file.name) || file.size > 32 * 1024 * 1024) {
            setError('请选择 32MB 以内的 WAV 或 FLAC 音频。'); return;
        }
        try { await save(await file.arrayBuffer(), file.name.toLowerCase().endsWith('.flac') ? '.flac' : '.wav', file.name.replace(/\.[^.]+$/, ''), false); }
        catch (e) { setError(`读取失败：${e?.message ?? e}`); }
    };
    const stopPreview = () => { request.current++; setPreviewing(''); setPreview(null); };
    const previewRef = async ref => {
        const id = ++request.current;
        setError(''); setPreview(null); setPreviewing(ref.id);
        try {
            const result = await store.previewRef(ref.id, engine, sample, () => id === request.current);
            if (id !== request.current) return;
            setPreview({ blob: wavBlob(result.wav, result.mime), label: `${ref.label} · ${engines.find(e => e.id === engine)?.label ?? engine} · 合成示例` });
        } catch (e) { if (id === request.current) setError(`试听失败：${e?.message ?? e}`); }
        finally { if (id === request.current) setPreviewing(''); }
    };
    const button = (label, onClick, off = false) => h(Button, { variant: 'outline', size: 'sm', disabled: off, onClick, children: label });
    const input = { ...S.input, minWidth: 0 };
    return h('div', { style: S.field, 'data-voice-clone': '' },
        h('h3', { style: S.groupTitle }, '录制与克隆音色'),
        h('p', { style: S.groupHint }, '录一段清晰的单人声音，建议 3～10 秒，最多 20 秒。每段录音可以独立命名、保存和使用。'),
        h('label', { style: S.field }, '克隆引擎', h(Select, { value: engine, options: engines.map(e => ({ value: e.id, label: e.label })), disabled: locked || capturing, onChange: v => { stopPreview(); setChosenEngine(v); } })),
        !engine ? h('div', { style: S.hint }, '当前没有可用的克隆引擎，仍可录音并保存，安装引擎后再使用。') : null,
        h('label', { style: S.field }, '音色名', h('input', { style: input, value: name, maxLength: 100, disabled: locked || capturing, placeholder: '例如：我的声音、轻声朗读', onChange: e => setName(e.target.value) })),
        h('label', { style: S.field }, '参考文本（请按此朗读，也可以改成自己的内容）', h('textarea', {
            style: { ...S.input, minHeight: '72px', resize: 'vertical' }, value: text, disabled: locked || capturing,
            placeholder: REFERENCE_SCRIPT, onChange: e => setText(e.target.value),
        })),
        h('div', { style: S.row },
            capturing
                ? button(recording.status === 'starting' ? '取消等待麦克风' : '停止录制', () => recording.status === 'starting' ? recorder.current?.cancel() : recorder.current?.stop())
                : button(recording.wav ? '重新录制' : '开始录制', start, locked),
            recording.wav ? button(busy ? '保存中…' : engine ? '保存并使用音色' : '保存音色', () => { void save(recording.wav, '.wav', availableRefName(state.refs), true); }, locked) : null,
            recording.wav || capturing ? button('取消录音', () => recorder.current?.cancel(), busy) : null,
            !recording.wav && !capturing ? button('导入音频文件', () => fileRef.current?.click(), locked) : null,
            h('input', { ref: fileRef, type: 'file', accept: '.wav,.flac,audio/wav,audio/flac', disabled: locked || capturing, style: { display: 'none' }, onChange: e => { void onFile(e); } })),
        h('div', { role: 'status', style: S.hint }, capturing ? `正在${recording.status === 'starting' ? '等待麦克风权限' : '录制'} · ${recording.seconds.toFixed(1)} / 20 秒` : recording.wav ? `已录制 ${recording.seconds.toFixed(1)} 秒，可先听原录音，再保存音色。` : ''),
        raw ? h(ClipPlayer, { blob: raw, label: '原录音' }) : null,
        error || recording.error ? h('div', { role: 'alert', style: { ...S.banner, ...S.bannerError } }, error || recording.error) : null,
        h('label', { style: S.field }, '示例文本', h('textarea', { style: { ...S.input, minHeight: '65px', resize: 'vertical' }, maxLength: 200, value: sample, disabled: capturing || !!previewing, onChange: e => setSample(e.target.value) })),
        h('div', { style: S.hint }, '“使用并试听”会选用该音色，并朗读上面的示例文本。首次试听需加载模型，可能需要几十秒。'),
        previewing ? h('div', { role: 'status', style: S.row }, '正在加载模型或合成示例…', button('取消试听', stopPreview)) : null,
        preview ? h('div', null, h(ClipPlayer, { blob: preview.blob, label: preview.label, autoPlay: true }), button('关闭试听', stopPreview)) : null,
        h('div', { style: S.row }, h('strong', null, `已保存音色（${state.refs.length}）`), button('刷新列表', () => { void store.refreshRefs(); }, locked || capturing)),
        state.refs.length === 0 ? h('div', { style: S.muted }, '还没有音色，录制或导入后会显示在这里。') :
            state.refs.map(ref => h('div', { key: ref.id, style: { ...S.refRow, flexWrap: 'wrap' } },
                h('span', { style: { flex: '1 1 160px', overflowWrap: 'anywhere' } }, ref.label,
                    state.value?.ttsEngine === engine && state.value?.ttsVoice?.[engine] === ref.id ? '（使用中）' : ''),
                button('使用', () => { stopPreview(); void store.useRef(ref.id, engine); }, locked || capturing || !engine),
                button('使用并试听', () => { void previewRef(ref); }, locked || capturing || !engine || !sample.trim()),
                button('删除', () => { stopPreview(); void store.deleteRef(ref.label); }, locked || capturing))),
        h('details', { style: S.details }, h('summary', { style: S.summary }, '音色存储位置'), h('code', { style: S.mono }, state.refDir || '（未知）')));
}
