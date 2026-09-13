/** 引擎取值集合(host schema 与 isVoiceEngine 守卫同源)。 */
export const ENGINE_VALUES = ['auto', 'browser', 'native'];
/** 全插件默认值(单一来源;两半 + native-asr 共用)。 */
export const DEFAULTS = {
    engine: 'native',
    hotkey: 'ctrl+space',
    modelDir: '',
    vadThreshold: 0.3,
    tailPadSeconds: 0.6,
    asrDir: 'asr-zh',
};
/** 运行时值守卫(RPC 下发的 engine 未经验证;host schema 覆盖不到的兜底)。 */
export function isVoiceEngine(value) {
    return ENGINE_VALUES.includes(value);
}
