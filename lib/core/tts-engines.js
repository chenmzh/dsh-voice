/**
 * TTS 引擎注册表:每个本地引擎的 venv、默认音色、资源开销与授权。
 *
 * 这里只描述"怎么把引擎跑起来"和"它是什么",不含任何推理逻辑 —— 推理在
 * python/tts_worker.py 里,由宿主半按需拉起一个常驻子进程(见 python-tts.js)。
 *
 * 表里的 rtf / vramGb 是 2026-09-11 在 RTX 5070 Ti 上的实测值(见
 * tts-bakeoff/RESULTS.md),用于在 UI 上给出"换这个模型要多占多少显存"的提示。
 */
// 通道/端点常量住在 wire.js(所有跨进程常量集中一处),这里再导出一次
// 只是为了让引擎相关的模块不必同时 import 两处。
export { TTS_CHANNEL, TTS_ENDPOINTS } from './wire.js';

/** 默认安装根目录(可用 config.ttsRoot 覆盖)。 */
import { DEFAULT_TTS_ROOT, DEFAULT_MODELS_ROOT } from './runtime-paths.js';
export { DEFAULT_TTS_ROOT, DEFAULT_MODELS_ROOT };

/**
 * 引擎定义。key 即 UI 与 RPC 里使用的 engine id。
 *
 * `venvPython` 是相对 TTS_ROOT 的路径:这些引擎的 torch/transformers 互不兼容,
 * 各自独立 venv 是硬性要求。
 */
export const TTS_ENGINES = {
    kokoro: {
        id: 'kokoro',
        label: 'Kokoro-82M',
        medal: '🥇',
        venvPython: 'kokoro/venv/bin/python',
        voiceKind: 'preset',
        defaultVoice: 'zh=zf_001,en=af_heart',
        // 非自回归:一次算完整段,天然没有自回归漂移,首块延迟也最低。
        rtf: 0.088,
        vramGb: 1.15,
        loadSeconds: 5.4,
        license: 'Apache-2.0',
        commercial: true,
        clone: false,
        nativeDigits: true,
        blurb: '最快最省显存,原生数字正确;音色是预置音色,不能克隆',
    },
    cosyvoice: {
        id: 'cosyvoice',
        label: 'CosyVoice 2',
        medal: '🥈',
        venvPython: 'cosyvoice/venv/bin/python',
        voiceKind: 'clone',
        defaultVoice: 'zero_shot_prompt',
        rtf: 0.622,
        vramGb: 2.89,
        loadSeconds: 7.3,
        license: 'Apache-2.0',
        commercial: true,
        clone: true,
        nativeDigits: true,
        // wetext 的 FST 必须本地化,否则它会去 modelscope 下载并在失败时静默降级。
        env: { COSYVOICE_WETEXT_DIR: '@MODELS@/cosyvoice/wetext' },
        modelDir: '@MODELS@/cosyvoice/CosyVoice2-0.5B',
        blurb: '零样本克隆、快于实时;实测会把"银行"读错(cer_zh 0.073)',
    },
    cosyvoice3: {
        id: 'cosyvoice3',
        label: 'CosyVoice 3',
        medal: '🥈',
        venvPython: 'cosyvoice/venv/bin/python',
        voiceKind: 'clone',
        defaultVoice: 'zero_shot_prompt',
        rtf: 1.205,
        vramGb: 3.74,
        loadSeconds: 24.2,
        license: 'Apache-2.0',
        commercial: true,
        clone: true,
        nativeDigits: true,
        env: { COSYVOICE_WETEXT_DIR: '@MODELS@/cosyvoice/wetext' },
        modelDir: '@MODELS@/cosyvoice/Fun-CosyVoice3-0.5B',
        // CosyVoice3 的 zero-shot 提示词需要这个前缀,否则克隆质量下降。
        promptPrefix: 'You are a helpful assistant.<|endofprompt|>',
        blurb: '零样本克隆,实测逐字正确(cer 0.000);但慢于实时(RTF 1.21)',
    },
    indextts: {
        id: 'indextts',
        label: 'IndexTTS-2.5',
        medal: '🥉',
        venvPython: 'indextts/venv/bin/python',
        voiceKind: 'clone',
        defaultVoice: 'voice_04',
        rtf: 0.868,
        vramGb: 7.02,
        loadSeconds: 24.4,
        license: 'bilibili 模型许可(免版税商用)',
        commercial: true,
        clone: true,
        nativeDigits: true,
        // 仓库必须可导入,pinyin 多音字标注也靠它。
        env: { PYTHONPATH: '@TTS@/indextts/repo' },
        // 显式给出:worker 自己有默认值,但 UI 的"是否装好"判断需要真实路径。
        modelDir: '@MODELS@/indextts/checkpoints',
        blurb: '逐字正确 + 拼音多音字可标注;最吃显存(7GB),加载最慢',
    },
};

/** UI 里的展示顺序(按推荐度,不按字母)。 */
export const TTS_ENGINE_ORDER = ['kokoro', 'cosyvoice', 'cosyvoice3', 'indextts'];

export function isTtsEngine(value) {
    return typeof value === 'string' && Object.hasOwn(TTS_ENGINES, value);
}

/**
 * 把设置里的"显示哪些引擎"规整成一个可用的非空列表。
 *
 * 面板允许用户取消勾选不用的引擎(下拉会短很多),但**不允许一个都不留**:
 * 那会让朗读面板空掉,用户只能再去改配置文件才能救回来。所以空集合一律
 * 回落成全集,并按 TTS_ENGINE_ORDER 排序去重(显示顺序永远由我们决定,
 * 不受用户勾选顺序影响)。
 */
export function normalizeVisibleEngines(value) {
    if (!Array.isArray(value))
        return [...TTS_ENGINE_ORDER];
    const wanted = new Set(value.filter(isTtsEngine));
    const ordered = TTS_ENGINE_ORDER.filter(id => wanted.has(id));
    return ordered.length > 0 ? ordered : [...TTS_ENGINE_ORDER];
}

/** 把 '@TTS@' / '@MODELS@' 占位符展开成真实路径。 */
export function expandTemplates(value, { ttsRoot, modelsRoot }) {
    if (typeof value !== 'string')
        return value;
    return value.replaceAll('@TTS@', ttsRoot).replaceAll('@MODELS@', modelsRoot);
}

/**
 * 解析一个引擎的完整启动描述:venv python 绝对路径、模型目录、额外环境变量。
 * @param id - 引擎 id
 * @param options - ttsRoot / modelsRoot 覆盖
 * @returns 引擎描述,或 null(未知 id)
 */
export function resolveEngineSpec(id, { ttsRoot = DEFAULT_TTS_ROOT, modelsRoot = DEFAULT_MODELS_ROOT } = {}) {
    const def = TTS_ENGINES[id];
    if (!def)
        return null;
    const env = {};
    for (const [key, value] of Object.entries(def.env ?? {}))
        env[key] = expandTemplates(value, { ttsRoot, modelsRoot });
    return {
        ...def,
        python: `${ttsRoot}/${def.venvPython}`,
        modelDir: expandTemplates(def.modelDir ?? '', { ttsRoot, modelsRoot }),
        env,
        ttsRoot,
        modelsRoot,
    };
}
