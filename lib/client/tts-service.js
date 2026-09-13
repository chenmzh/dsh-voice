/** 朗读 RPC 信封:与 voice-service.js 同一套 {ok,value} / {ok:false,error} 解包。 */
import { TTS_CHANNEL, TTS_ENDPOINTS, VoiceRpcError } from '../core/wire.js';
function decode(res) {
    if (!res.ok)
        throw new VoiceRpcError(res.error.code, res.error.message);
    return res.value;
}
export function createTtsService(call) {
    return {
        /** 引擎目录 + 当前选择(不含任何加载副作用)。 */
        fetchConfig: async () => decode(await call(TTS_CHANNEL, TTS_ENDPOINTS.config, {})),
        /** 非阻塞快照:加载中会返回 state='loading'。 */
        status: async () => decode(await call(TTS_CHANNEL, TTS_ENDPOINTS.status, {})),
        /** 切引擎:宿主会先卸载旧引擎再加载新的。 */
        select: async (engine) => decode(await call(TTS_CHANNEL, TTS_ENDPOINTS.select, { engine })),
        unload: async () => decode(await call(TTS_CHANNEL, TTS_ENDPOINTS.unload, {})),
        /** 纯文本切句;engine 决定数字展开规则,不触发任何模型加载。 */
        segments: async (text, engine, options = {}) => decode(await call(TTS_CHANNEL, TTS_ENDPOINTS.segments, { text, ...(engine ? { engine } : {}), ...options })),
        voices: async (engine) => decode(await call(TTS_CHANNEL, TTS_ENDPOINTS.voices, engine ? { engine } : {})),
        setVoice: async (voice) => decode(await call(TTS_CHANNEL, TTS_ENDPOINTS.setVoice, { voice })),
        speak: async (text, options = {}) => decode(await call(TTS_CHANNEL, TTS_ENDPOINTS.speak, { text, ...options })),
        /** 导入一段克隆音色(音频内容走 base64)。返回新目录,省一次列举往返。 */
        saveRef: async (name, base64, text, ext) =>
            decode(await call(TTS_CHANNEL, TTS_ENDPOINTS.saveRef, { name, audio: base64, text, ext })),
        /** 删掉一个克隆音色(连同同名 .txt)。 */
        deleteRef: async (name) => decode(await call(TTS_CHANNEL, TTS_ENDPOINTS.deleteRef, { name })),
    };
}
/** base64 WAV → Blob(给 <audio> 用);避免在客户端解析 WAV 头。 */
export function wavBlob(base64, mime = 'audio/wav') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}
