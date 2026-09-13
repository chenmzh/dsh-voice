/**
 * 语音插件的设置命名空间(`voice`)—— host 半唯一一份 schema。
 *
 * 为什么要有这个文件,而不是继续只读 `cordis.patch.yml` 里那份行内 config:
 *   行内 config 是**组合层**,改它要编辑 yml 再重启;用户要的是"在设置面板里
 *   随时改"。DSH 的用户设置文档(`~/.dsh/settings.yaml`)正好提供三层解析:
 *   schema 默认值 → 组合层(base,即行内 config)→ 用户层。于是:
 *
 *     - 现有 cordis.patch.yml 一行都不用改,它自动成为 base;
 *     - 面板里改的写进用户层,重启后还在,而且随时能"恢复默认"(清掉用户层);
 *     - 没装 settings provider 时,installSection 会退回 base,插件照常工作。
 *
 * 字段名与行内 config **逐字相同**,这不是巧合:base 就是那份 entry 对象,
 * 名字对不上就会静默丢配置。
 */
import z from '@deepseek-ai/schemastery';
import { DEFAULTS, ENGINE_VALUES } from './config.js';
import { TTS_ENGINE_ORDER, DEFAULT_TTS_ROOT, DEFAULT_MODELS_ROOT } from './tts-engines.js';
import { DEFAULT_REF_DIR } from './ref-wavs.js';
import { DEFAULT_PREP_PYTHON, DEFAULT_TEXTNORM } from './text-prep.js';
import { ASR_LANGUAGE_CODES } from './asr-languages.js';
import { INSTRUCT_LANGUAGE_CODES } from './tts-instruct.js';

/** 设置面板里那个 tab 的命名空间,同时也是客户端 settingsScope 绑定的名字。 */
export const VOICE_NAMESPACE = 'voice';

const constUnion = values => z.union(values.map(v => z.const(v)));

/**
 * 语音的全部可配置项。
 *
 * 这个 schema 同时是两个东西:host 的 `Config`(校验行内 config)和设置命名
 * 空间的 schema(面板渲染与校验用户层)。同一个对象保证两者永不漂移。
 *
 * 每项都写 `.description()`:设置面板把它当行说明显示,配置目录也读它。
 */
export const VoiceSettingsSchema = z.object({
    // ---- 语音输入(STT)--------------------------------------------------- //
    engine: constUnion(ENGINE_VALUES).default(DEFAULTS.engine).description(
        '语音输入模式:auto = 优先本地模型、不可用才退回浏览器识别;native = 只用本地模型;'
        + 'browser = 只用浏览器内置识别(不占显存,但中文质量一般)。'),
    nativeBackend: constUnion(['zipformer', 'qwen', 'whisper']).default('zipformer').description(
        '本地语音识别用哪个模型。qwen = Qwen3-ASR(30 种语言,自动检测,约 4.8GB 显存);'
        + 'whisper = faster-whisper;zipformer = sherpa-onnx 中文流式模型(最省显存,只认中文)。'),
    asrLanguage: constUnion(ASR_LANGUAGE_CODES).default('auto').description(
        '识别语言。auto 让模型自己判断(推荐);指定语言在口音重、或中英混说时更稳。'
        + '注意这**不会**翻译 —— 说什么语言就转写什么语言。'),
    asrDevice: constUnion(['cuda', 'cpu']).default('cuda').description(
        '语音识别的推理设备。cpu 不占显存但慢很多。'),
    pythonExecutable: z.string().default('python3').description(
        '跑 ASR 子进程用的 Python(qwen / whisper 后端需要它带 torch 与 qwen_asr / faster_whisper)。'),
    qwenModelDir: z.string().default('').description(
        'Qwen3-ASR 模型目录(原生 backend 设为 qwen 时用)。'),
    whisperModelDir: z.string().default('').description(
        'faster-whisper 模型目录(原生 backend 设为 whisper 时用)。'),
    pythonModelDir: z.string().default('').description(
        '已废弃的旧字段,仅为兼容旧配置保留;请改用 qwenModelDir / whisperModelDir。'),
    modelDir: z.string().default(DEFAULTS.modelDir).description(
        'zipformer / sherpa-onnx 的模型根目录(原生 backend 设为 zipformer 时用)。'),
    asrDir: z.string().default(DEFAULTS.asrDir).description(
        '上面那个目录里语音识别模型所在的子目录名。'),
    vadThreshold: z.number().min(0).default(DEFAULTS.vadThreshold).description(
        '静音判定阈值:越高越不容易把环境噪声当人声,太高会吃字头。'),
    tailPadSeconds: z.number().min(0).default(DEFAULTS.tailPadSeconds).description(
        '停止说话后再多录多久,避免最后一个字被切掉。'),
    hotkey: z.string().default(DEFAULTS.hotkey).description(
        '开关麦克风的全局快捷键,写法如 alt+m、ctrl+shift+space。'),

    // ---- 朗读(TTS)------------------------------------------------------- //
    ttsEngine: constUnion(TTS_ENGINE_ORDER).default('kokoro').description(
        '朗读默认用哪个引擎。kokoro 最快最省显存(音色是预置的,不能克隆);'
        + 'cosyvoice / cosyvoice3 / indextts 可以克隆音色。'),
    ttsVisibleEngines: z.array(constUnion(TTS_ENGINE_ORDER)).default([...TTS_ENGINE_ORDER]).description(
        '朗读面板里**显示**哪些引擎。只留常用的两三个可以让下拉短很多;'
        + '引擎仍然装在本机,取消勾选只是不在面板里出现。'),
    ttsDevice: constUnion(['cuda', 'cpu']).default('cuda').description(
        '朗读的推理设备。cpu 不占显存但慢很多。'),
    ttsAutoRead: z.boolean().default(true).description(
        '助手回复写完后自动朗读。面板里也能临时开关(那个开关只影响当前浏览器)。'),
    ttsRoot: z.string().default(DEFAULT_TTS_ROOT).description(
        'TTS 引擎的安装根目录(每个引擎有独立 venv,路径不通用)。'),
    ttsModelsRoot: z.string().default(DEFAULT_MODELS_ROOT).description(
        'TTS 模型权重根目录。'),
    ttsRefDir: z.string().default(DEFAULT_REF_DIR).description(
        '克隆音色的参考音频目录。放 3~10 秒干净单人 wav(或 flac)进去,同名 .txt 写上'
        + '这段音频说了什么,音色就会出现在下拉里。只对 CosyVoice / IndexTTS 这类克隆引擎有效。'),
    ttsVoice: z.dict(z.string()).default({}).description(
        '每个引擎上次选中的音色。逐引擎记,因为音色标识不通用'
        + '(Kokoro 是 "zh=zf_001,en=af_heart",克隆引擎是参考音频的绝对路径)。'),
    ttsInstructLanguage: constUnion(INSTRUCT_LANGUAGE_CODES).default('auto').description(
        '让 CosyVoice 3 用指定语言朗读(auto = 不干预,保持原来的行为)。'
        + '德语/法语/英语实测有效,而且**原始阿拉伯数字也能读对**'
        + '(3,5 与 2026 都按该语言的读法念出来),所以不必再把数字写成单词。'
        + '只对 cosyvoice3 生效;它不会覆盖中文文本 —— 中文回复照旧读中文。'
        + '代价:开启后每次合成要重算声纹,不再走参考音频的缓存快路径。'),
    ttsInstructText: z.string().default('').description(
        '自定义朗读指令(留空则用上面选的语言)。写在这里的话会原样交给模型,'
        + '可以用来要求口音、语气或情绪;助手前缀与 <|endofprompt|> 会自动补全。'),
    ttsTextnormPath: z.string().default(DEFAULT_TEXTNORM).description(
        '文本规范化脚本的绝对路径(剥 Markdown、按引擎展开数字、切句)。'),
    ttsPrepPython: z.string().default(DEFAULT_PREP_PYTHON).description(
        '跑上面那个脚本用的解释器(只用到标准库)。'),
});
