/**
 * STT 语言表:一个 UI 取值 → 两个后端各自认的写法。
 *
 * 为什么需要一张表而不是直接把用户选的值透传:
 *   - Qwen3-ASR(现在实际在用的后端)只认 30 个**规范英文名**:`German`
 *     (见 qwen_asr/inference/utils.py 的 SUPPORTED_LANGUAGES 与
 *     validate_language,大小写不敏感但名字必须对,传 'de' 会直接 ValueError)。
 *   - faster-whisper 认 ISO-639-1 小写码 `de`,不认 'German'。
 * 所以 UI 统一用 ISO 码,由 worker 按后端翻译(见 python/worker.py)。
 *
 * 表里的 30 项就是 Qwen3-ASR 的 support_languages 全集。它是**厂商元数据**,
 * 曾经在 CosyVoice 2 上吃过"模型卡说支持 9 种语言,实测只会中英"的亏,所以
 * 这里只把名字当成"要传什么参数"的依据,不当成"一定说得准"的承诺。
 *
 * `whisper` 字段缺省表示 Whisper 的 99 语言表里没有这个码(例如粤语 yue):
 * 那时退回 auto,而不是传一个必然报错的值。
 */

/** "自动检测":不传 language,让模型自己判断。 */
export const ASR_AUTO = 'auto';

/**
 * 语言项。
 *   code    - UI 与配置里存的值(ISO-639-1 小写)
 *   qwen    - Qwen3-ASR 的规范英文名(必须与 SUPPORTED_LANGUAGES 逐字一致)
 *   whisper - faster-whisper 的语言码;null 表示该后端不支持,退回 auto
 *   label   - 下拉里显示的中文名
 */
export const ASR_LANGUAGES = [
    { code: 'zh', qwen: 'Chinese', whisper: 'zh', label: '中文' },
    { code: 'en', qwen: 'English', whisper: 'en', label: '英语' },
    { code: 'yue', qwen: 'Cantonese', whisper: null, label: '粤语' },
    { code: 'ja', qwen: 'Japanese', whisper: 'ja', label: '日语' },
    { code: 'ko', qwen: 'Korean', whisper: 'ko', label: '韩语' },
    { code: 'de', qwen: 'German', whisper: 'de', label: '德语' },
    { code: 'fr', qwen: 'French', whisper: 'fr', label: '法语' },
    { code: 'es', qwen: 'Spanish', whisper: 'es', label: '西班牙语' },
    { code: 'it', qwen: 'Italian', whisper: 'it', label: '意大利语' },
    { code: 'pt', qwen: 'Portuguese', whisper: 'pt', label: '葡萄牙语' },
    { code: 'ru', qwen: 'Russian', whisper: 'ru', label: '俄语' },
    { code: 'ar', qwen: 'Arabic', whisper: 'ar', label: '阿拉伯语' },
    { code: 'hi', qwen: 'Hindi', whisper: 'hi', label: '印地语' },
    { code: 'th', qwen: 'Thai', whisper: 'th', label: '泰语' },
    { code: 'vi', qwen: 'Vietnamese', whisper: 'vi', label: '越南语' },
    { code: 'id', qwen: 'Indonesian', whisper: 'id', label: '印尼语' },
    { code: 'ms', qwen: 'Malay', whisper: 'ms', label: '马来语' },
    { code: 'nl', qwen: 'Dutch', whisper: 'nl', label: '荷兰语' },
    { code: 'tr', qwen: 'Turkish', whisper: 'tr', label: '土耳其语' },
    { code: 'pl', qwen: 'Polish', whisper: 'pl', label: '波兰语' },
    { code: 'cs', qwen: 'Czech', whisper: 'cs', label: '捷克语' },
    { code: 'sv', qwen: 'Swedish', whisper: 'sv', label: '瑞典语' },
    { code: 'da', qwen: 'Danish', whisper: 'da', label: '丹麦语' },
    { code: 'fi', qwen: 'Finnish', whisper: 'fi', label: '芬兰语' },
    { code: 'el', qwen: 'Greek', whisper: 'el', label: '希腊语' },
    { code: 'ro', qwen: 'Romanian', whisper: 'ro', label: '罗马尼亚语' },
    { code: 'hu', qwen: 'Hungarian', whisper: 'hu', label: '匈牙利语' },
    { code: 'fa', qwen: 'Persian', whisper: 'fa', label: '波斯语' },
    { code: 'tl', qwen: 'Filipino', whisper: 'tl', label: '菲律宾语' },
    { code: 'mk', qwen: 'Macedonian', whisper: 'mk', label: '马其顿语' },
];

/** 可作为 asrLanguage 的全部取值(含 auto);host schema 与 UI 同源。 */
export const ASR_LANGUAGE_CODES = [ASR_AUTO, ...ASR_LANGUAGES.map(item => item.code)];

const BY_CODE = new Map(ASR_LANGUAGES.map(item => [item.code, item]));

/** 取值是否合法(未经验证的配置经 RPC/文件进来时的守卫)。 */
export function isAsrLanguage(value) {
    return typeof value === 'string' && ASR_LANGUAGE_CODES.includes(value);
}

/** 未知/空值一律当 auto —— 绝不因为一个拼错的码让语音输入整条不能用。 */
export function normalizeAsrLanguage(value) {
    return isAsrLanguage(value) ? value : ASR_AUTO;
}

/**
 * 翻成某个后端在这个进程里要用的值。
 * @param value - 配置里的 ISO 码或 'auto'
 * @param backend - 'qwen' | 'whisper' | 其它
 * @returns 该后端的语言参数;null 表示"不要传,自动检测"
 */
export function backendLanguage(value, backend) {
    const code = normalizeAsrLanguage(value);
    if (code === ASR_AUTO) return null;
    const item = BY_CODE.get(code);
    if (!item) return null;
    if (backend === 'qwen') return item.qwen;
    // whisper 只认 ISO;表里没给码的(粤语)退回自动,而不是传一个必然报错的值。
    return item.whisper;
}

/** 下拉选项(UI 用;把表搬过去,避免客户端再维护一份)。 */
export function asrLanguageOptions() {
    return [
        { value: ASR_AUTO, label: '自动检测(推荐)' },
        ...ASR_LANGUAGES.map(item => ({ value: item.code, label: item.label + '(' + item.code + ')' })),
    ];
}
