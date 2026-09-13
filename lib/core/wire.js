export const VOICE_CHANNEL = '/voice';
export const VOICE_ENDPOINTS = {
    ping: 'ping',
    config: 'config',
    asr: 'asr',
};
/** 朗读走独立通道:ASR 的握手语义(ping 要加载模型)不适合复用。 */
export const TTS_CHANNEL = '/tts';
export const TTS_ENDPOINTS = {
    config: 'config',
    status: 'status',
    select: 'select',
    unload: 'unload',
    segments: 'segments',
    voices: 'voices',
    setVoice: 'setVoice',
    speak: 'speak',
    // 克隆音色的增删:面板里直接导入一段参考音频,不必再去文件管理器里拖文件。
    // 与 voices(列举)分开,是因为写盘要走另一条校验路径(见 index.js)。
    saveRef: 'saveRef',
    deleteRef: 'deleteRef',
    /**
     * 只列参考音频目录,**绝不加载任何模型**。
     * 不能用 voices 代替:那个端点会 ensureReady(),也就是打开设置面板就会
     * 把 24s 的 CosyVoice3 拉进显存 —— 只是想改个语言设置的用户不该付这个代价。
     */
    refs: 'refs',
};
/** 带错误码的 RPC 错误:host 的错误分类经 code 穿越 wire,客户端可区分。 */
export class VoiceRpcError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'VoiceRpcError';
    }
}
/** 宿主侧错误信封构造(消灭手写 { ok:false, error:{...} })。 */
export function rpcError(code, message) {
    return { ok: false, error: { code, message, details: {} } };
}
