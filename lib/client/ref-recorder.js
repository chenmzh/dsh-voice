import { ASR_SAMPLE_RATE, capturePcm } from './audio.js';

export const REFERENCE_SCRIPT = '你好，这是我的声音。希望今天的每一次交流，都能清晰自然，充满温暖。';
export const SAMPLE_SCRIPT = '你好，很高兴认识你。这是使用你保存的音色生成的示例，今后我可以用这个声音为你朗读。';
export const MAX_RECORD_SECONDS = 20;

/** Encode real mono PCM16 WAV, independent of browser recording codecs. */
export function pcmWav(chunks, sampleRate = ASR_SAMPLE_RATE) {
    const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const buffer = new ArrayBuffer(44 + count * 2);
    const view = new DataView(buffer);
    const ascii = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, count * 2, true);
    let offset = 44;
    for (const chunk of chunks) for (const sample of chunk) { view.setInt16(offset, sample, true); offset += 2; }
    return buffer;
}

export function availableRefName(refs, base = '我的音色') {
    const labels = new Set(refs.map(ref => ref.label));
    if (!labels.has(base)) return base;
    let n = 2;
    while (labels.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
}

export class ReferenceRecorder {
    constructor(onChange, capture = capturePcm) {
        this.onChange = onChange;
        this.capture = capture;
        this.generation = 0;
        this.state = { status: 'idle', seconds: 0, wav: null, error: '' };
    }
    update(patch) { this.state = { ...this.state, ...patch }; this.onChange(this.state); }
    async start() {
        this.cancel();
        const generation = this.generation;
        this.chunks = []; this.samples = 0;
        this.update({ status: 'starting', seconds: 0, wav: null, error: '' });
        try {
            const capture = await this.capture(chunk => {
                if (generation !== this.generation) return;
                const keep = chunk.slice(0, MAX_RECORD_SECONDS * ASR_SAMPLE_RATE - this.samples);
                this.chunks.push(keep); this.samples += keep.length;
                this.update({ seconds: this.samples / ASR_SAMPLE_RATE });
                if (this.samples >= MAX_RECORD_SECONDS * ASR_SAMPLE_RATE) this.stop();
            });
            if (generation !== this.generation) { capture.stop(); return; }
            this.active = capture;
            this.update({ status: 'recording' });
            this.timer = setTimeout(() => this.stop(), (MAX_RECORD_SECONDS + 1) * 1000);
        } catch (error) {
            if (generation !== this.generation) return;
            this.cancel();
            const denied = error?.name === 'NotAllowedError';
            this.update({ status: 'idle', error: denied ? '麦克风权限被拒绝，请在浏览器中允许麦克风后重试。' : `无法录制：${error?.message ?? error}` });
        }
    }
    release() { clearTimeout(this.timer); this.active?.stop(); this.active = null; }
    cancel() { this.generation++; this.release(); this.chunks = []; this.update({ status: 'idle', seconds: 0, wav: null, error: '' }); }
    stop() {
        if (!['recording', 'starting'].includes(this.state.status)) return;
        this.generation++; this.release();
        if (this.samples < 3 * ASR_SAMPLE_RATE) {
            this.update({ status: 'idle', wav: null, error: '录音不足 3 秒，请重新录制并完整读完参考文本。' });
        } else {
            let peak = 0;
            for (const chunk of this.chunks) for (const sample of chunk) peak = Math.max(peak, Math.abs(sample));
            this.update(peak < 64
                ? { status: 'idle', wav: null, error: '没有录到清晰的声音，请检查麦克风后重试。' }
                : { status: 'ready', wav: pcmWav(this.chunks), error: '' });
        }
        this.chunks = [];
    }
    dispose() { this.onChange = () => {}; this.cancel(); }
}
