import { VOICE_CHANNEL, VOICE_ENDPOINTS, VoiceRpcError } from '../core/wire.js';
function decode(res) {
    if (!res.ok)
        throw new VoiceRpcError(res.error.code, res.error.message);
    return res.value;
}
export function createVoiceService(call) {
    return {
        ping: async () => decode(await call(VOICE_CHANNEL, VOICE_ENDPOINTS.ping, {})),
        fetchConfig: async () => decode(await call(VOICE_CHANNEL, VOICE_ENDPOINTS.config, {})),
        asr: async (payload) => decode(await call(VOICE_CHANNEL, VOICE_ENDPOINTS.asr, payload)),
    };
}
