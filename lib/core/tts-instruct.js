/**
 * CosyVoice 3 的"用哪种语言朗读"指令(inference_instruct2)。
 *
 * 为什么要有这个东西 —— 它解决的是 draft.13 里那个"没有 de/fr 数字拼写器"
 * 的死结。CosyVoice3 自带的 text frontend 是英文的(Normalizer 只认
 * auto/en/zh),遇到阿拉伯数字会**按英文改写**再把整句拖成英文腔,所以
 * "用德语朗读"一直只能靠"把数字写成德语单词"。实测(lang-probe-out/
 * qwen-cv3final.json)表明还有第二条路:
 *
 *   inference_instruct2 + 一条语言指令 + text_frontend=False
 *
 * 原始数字直接进 LLM,由模型自己按指令语言读出来:
 *
 *   'Der Preis ist 3,5 Prozent im Jahr 2026.'
 *     -> 'Der Preis ist drei Komma fünf Prozent im Jahr zwei-
 *         tausendsechsundzwanzig.'            (F1, 数字全对)
 *   'Le prix est de 3,5 pour cent en 2026.'
 *     -> 'Le prix est de trois virgule cinq pour cent en
 *         deux mille vingt-six.'              (F5, 数字全对)
 *
 * 于是**不需要** de/fr 数字拼写器了。draft.13 的结论("诚实的建议是把数字
 * 写成单词")在本版被这条通道取代。
 *
 * 只有 inference_instruct2 这一条通道实测有效,另外三条都不行:
 *   - 把指令塞进 add_zero_shot_spk 的 prompt 文本里:无效(缓存音色路径下
 *     frontend_zero_shot 直接返回 spk2info,instruct_text 被忽略);
 *   - `<|de|>` / `<|fr|>` 这类语言标签:本模型词表里**根本不存在**
 *     (manifest 里 tag_ok 两项都是 false);
 *   - 指令 + text_frontend=True:反而更差 —— 同样的德语指令配 tf=True,
 *     Whisper 听到的是**荷兰语**(F4:'De prijs is drie vijf procent...')。
 *     所以带指令时 tf 必须关掉,这不是可选项。
 *
 * 指令文本会**原样**成为 frontend 的 prompt_text(frontend_instruct2 ->
 * frontend_zero_shot 的 zero_shot_spk_id=='' 分支,见
 * cosyvoice/cli/frontend.py:168),没有任何前缀被自动补上。因此
 * 'You are a helpful assistant.' 和收尾的 <|endofprompt|> 都得我们自己拼 ——
 * 后者还是 CosyVoice3 LM 的硬断言(llm.py 要求 151646 出现在
 * concat(prompt_text, text) 里,缺了直接抛)。
 *
 * 代价要说清楚:instruct2 走的是 zero_shot_spk_id='' 分支,也就是**每次合成
 * 都重算 campplus 声纹 + speech tokenizer**,拿不到"参考音频只编码一次"的
 * 缓存快路径。这正是 auto(不带指令)必须保持原样的原因。
 */

/** "不指定":不传指令,走原来的缓存音色快路径(= draft.13 的行为)。 */
export const INSTRUCT_AUTO = 'auto';

/** upstream CV3 zero-shot 自带的前缀;指令必须连它一起给。 */
const ASSIST = 'You are a helpful assistant.';
/** CosyVoice3 LM 断言要求的收尾标记。 */
const END_OF_PROMPT = '<|endofprompt|>';

/**
 * 指令里可以点名的朗读语言。
 *
 * `measured` 只对**真的量过**的那几种为 true(证据是 qwen-cv3final.json 的
 * F1/F2/F5 与作为对照的 F3/F6)。没标的就是"指令照发、但没测过",面板里会
 * 明说,不假装它们和德语一样可靠。
 */
export const INSTRUCT_LANGUAGES = [
    { code: 'de', name: 'German', label: '德语', measured: true },
    { code: 'fr', name: 'French', label: '法语', measured: true },
    { code: 'en', name: 'English', label: '英语', measured: true },
    { code: 'zh', name: 'Chinese', label: '中文', measured: false },
    { code: 'ja', name: 'Japanese', label: '日语', measured: false },
    { code: 'ko', name: 'Korean', label: '韩语', measured: false },
    { code: 'es', name: 'Spanish', label: '西班牙语', measured: false },
    { code: 'it', name: 'Italian', label: '意大利语', measured: false },
    { code: 'ru', name: 'Russian', label: '俄语', measured: false },
];

/** 可作为 ttsInstructLanguage 的全部取值(含 auto);schema 与 UI 同源。 */
export const INSTRUCT_LANGUAGE_CODES = [INSTRUCT_AUTO, ...INSTRUCT_LANGUAGES.map(item => item.code)];

const BY_CODE = new Map(INSTRUCT_LANGUAGES.map(item => [item.code, item]));

/** 取值是否合法(未经验证的配置经 RPC/文件进来时的守卫)。 */
export function isInstructLanguage(value) {
    return typeof value === 'string' && INSTRUCT_LANGUAGE_CODES.includes(value);
}

/** 未知/空值一律当 auto —— 绝不因为一个拼错的码让朗读整条不能用。 */
export function normalizeInstructLanguage(value) {
    return isInstructLanguage(value) ? value : INSTRUCT_AUTO;
}

/**
 * 把一段指令补成 CV3 需要的完整形态:带上 assistant 前缀、以 <|endofprompt|>
 * 收尾。已经写好的前缀和收尾标记不会被重复添加或重复出现,所以用户自己从
 * 别处抄来的完整指令也能直接用。
 *
 * @returns 完整的指令文本;空输入返回 null(表示"不要指令")。
 */
export function normalizeInstruct(raw) {
    let body = String(raw ?? '').replace(/<\|endofprompt\|>/g, ' ').trim();
    if (!body)
        return null;
    if (!/you are a helpful assistant/i.test(body))
        body = `${ASSIST} ${body}`;
    return `${body}${END_OF_PROMPT}`;
}

/**
 * 由设置算出这次合成要用的指令。
 *
 * 优先级:自定义指令文本 > 语言下拉 > null(auto,不带指令)。
 * 自定义文本优先是有意的:它是"我想说的具体话",而语言只是它的一个快捷模板。
 *
 * @param language - ttsInstructLanguage 的值('auto' 或某个语言码)
 * @param custom - ttsInstructText 的值(留空则用语言的模板)
 * @returns 完整指令,或 null 表示"不要指令,走原路径"。
 */
export function buildInstruct(language, custom) {
    const text = typeof custom === 'string' ? custom.trim() : '';
    if (text)
        return normalizeInstruct(text);
    const item = BY_CODE.get(normalizeInstructLanguage(language));
    if (!item)
        return null;
    return normalizeInstruct(`Please read the following sentence in ${item.name}.`);
}

/**
 * 带指令时 text_frontend 必须是 False(实测:开着会把德语读成荷兰语)。
 * 单独导出成一个函数,是为了让"这条规则在哪生效"只有一个答案。
 */
export function instructTextFrontend(instruct) {
    return !instruct;
}

/**
 * 下拉选项(UI 用;和 asr-languages.js 同样的做法 —— 表在 host,随 /voice/config
 * 下发给面板,客户端不自己维护第二份)。
 *
 * 没量过的语言在标签里明说,而不是混在一起让用户以为它们同样可靠。
 */
export function instructLanguageOptions() {
    return [
        { value: INSTRUCT_AUTO, label: '不指定(保持原样,最快)' },
        ...INSTRUCT_LANGUAGES.map(item => ({
            value: item.code,
            label: `${item.label}(${item.name})` + (item.measured ? '' : ' — 未实测'),
        })),
    ];
}
