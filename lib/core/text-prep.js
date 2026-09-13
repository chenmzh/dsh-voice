/**
 * 朗读文本预处理:剥 Markdown、按引擎展开数字、切句。
 *
 * 关键约束:**这一段绝不能等模型加载**。引擎加载要 5~40s(CosyVoice3 与
 * IndexTTS 实测各 ~24s),如果切句要通过常驻 worker 做,客户端就得先干等一次
 * 加载才有第一句可播。所以这里起一个短命 python3 直接跑 textnorm.py
 * (纯标准库,~60ms),与模型状态完全无关。
 *
 * textnorm.py 是已经过验证的模块(52 个测试),这里只做进程调用与解析,
 * 不在 JS 侧重写它的规则 —— 两套规则一定会漂移。
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 默认的 textnorm 位置(可用 config 覆盖)。 */
export const DEFAULT_TEXTNORM = fileURLToPath(new URL('../../python/textnorm.py', import.meta.url));

/** 默认的 textnorm 解释器。空串同样算"没配",见 resolvePrep。 */
export const DEFAULT_PREP_PYTHON = 'python3';

/**
 * 一段文本里有没有"读得出来的东西"。
 *
 * 纯标点(典型:被切断的右引号 `”`)会让模型产出 0 个音频块,CosyVoice 直接抛
 * `produced no audio chunks`。这种碎片根本不该被当成一句话。
 */
const SPEAKABLE = /[\p{L}\p{N}]/u;

/** Remove decorative emoji/control pieces without touching accented letters or prose. */
export function cleanSpeechDecorations(text) {
    return String(text ?? '').replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu, ' ')
        .replace(/[ \t]+/g, ' ').trim();
}

export function hasSpeakable(text) {
    return SPEAKABLE.test(String(text ?? ''));
}

/**
 * 空串 / 纯空白一律当作"没配",回落到默认值。
 *
 * 为什么必须显式处理:解构默认值只在 `undefined` 时生效,而 `''` 不是 nullish。
 * 宿主把 `config.ttsTextnormPath`(schema 默认 `''`)原样传下来,于是
 * `textnormPath` 变成 `''`,`args` 里就出现一个空文件名 —— python 必然失败,
 * 每次都静默降级成下面的简单切句。实测后果:Markdown 没剥、数字没展开,而且
 * `屋子。”` 会被切成孤零零的一个 `”`。
 */
function resolvePrep(textnormPath, python) {
    return {
        textnormPath: typeof textnormPath === 'string' && textnormPath.trim() ? textnormPath : DEFAULT_TEXTNORM,
        python: typeof python === 'string' && python.trim() ? python : DEFAULT_PREP_PYTHON,
    };
}

/** 兜底切句:只在 textnorm 调不起来时用。规则刻意简化,聊胜于无。 */
export function fallbackSegments(text, maxChars = 90) {
    const ends = '。！？!?；;…';
    const out = [];
    let buf = '';
    for (const ch of String(text ?? '')) {
        if (ch === '\n') {
            if (buf.trim())
                out.push(buf.trim());
            buf = '';
            continue;
        }
        buf += ch;
        if (ends.includes(ch)) {
            if (buf.trim())
                out.push(buf.trim());
            buf = '';
        }
    }
    if (buf.trim())
        out.push(buf.trim());
    // 过长的段落硬切,只求别把整篇塞进一次推理。
    const split = [];
    for (const piece of out) {
        if (piece.length <= maxChars) {
            split.push(piece);
            continue;
        }
        const chars = Array.from(piece);
        const latinWord = ch => ch && /[\p{Script=Latin}\p{M}\p{N}’'‐‑-]/u.test(ch);
        for (let i = 0; i < chars.length;) {
            let end = Math.min(i + maxChars, chars.length);
            if (latinWord(chars[end - 1]) && latinWord(chars[end])) {
                let boundary = end;
                while (boundary > i && latinWord(chars[boundary - 1])) boundary--;
                if (boundary > i) end = boundary;
                else while (end < chars.length && latinWord(chars[end])) end++;
            }
            split.push(chars.slice(i, end).join(''));
            i = end;
        }
    }
    // 收尾标点必须跟着句子走。切句点在 `。` 之后立刻断开,紧随其后的 `”` 会自己
    // 成为一段;它没有可读内容,合成必然报 "produced no audio chunks"。这里把
    // "没有可读内容"的碎片攒起来并进下一句(没有下一句就并回上一句),于是
    // `屋子。` + `”` 又变回 `屋子。”` 一整句。
    const merged = [];
    let pending = '';
    for (const piece of split) {
        const candidate = pending + piece;
        if (!hasSpeakable(candidate)) {
            pending = candidate;
            continue;
        }
        merged.push(candidate);
        pending = '';
    }
    if (pending) {
        if (merged.length > 0)
            merged[merged.length - 1] += pending;
        else
            merged.push(pending);
    }
    return merged;
}

/**
 * 调 textnorm.py --segments,返回 { engine, spell, normalized, segments }。
 * 失败时降级成"原文 + 简单切句",而不是让朗读整个失败。
 */
export function prepareSegments(text, {
    engine = 'generic',
    python = DEFAULT_PREP_PYTHON,
    textnormPath = DEFAULT_TEXTNORM,
    markdown = true,
    maxChars,
    minChars,
    timeoutMs = 20000,
    exec = execFile,
} = {}) {
    const content = cleanSpeechDecorations(text);
    if (!content.trim())
        return Promise.resolve({ engine, spell: false, normalized: '', segments: [], degraded: false });
    const resolved = resolvePrep(textnormPath, python);
    const args = [resolved.textnormPath, '--engine', engine, '--segments'];
    if (!markdown) args.push('--no-markdown');
    if (maxChars)
        args.push('--max-chars', String(maxChars));
    if (minChars)
        args.push('--min-chars', String(minChars));
    return new Promise(resolve => {
        let child;
        const done = payload => resolve(payload);
        try {
            child = exec(resolved.python, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
                if (error) {
                    done({ engine, spell: false, normalized: content, segments: fallbackSegments(content), degraded: true });
                    return;
                }
                try {
                    const parsed = JSON.parse(String(stdout));
                    const normalized = String(parsed.normalized ?? '');
                    let segments = Array.isArray(parsed.segments) ? parsed.segments.filter(item => typeof item === 'string') : [];
                    // The external segmenter can merge a short accented French line without
                    // its separating space ("de\nété" -> "deété"). Require identical words
                    // in identical order; if slicing changed them, keep the prepared text
                    // and use our word-safe fallback. Do not normalize it a second time.
                    const words = text => text.match(/[\p{L}\p{M}\p{N}]+(?:[’'‐‑-][\p{L}\p{M}\p{N}]+)*/gu) ?? [];
                    const changedWords = JSON.stringify(words(normalized)) !== JSON.stringify(words(segments.join(' ')));
                    if (changedWords) segments = fallbackSegments(normalized, maxChars ?? 90);
                    done({
                        engine: parsed.engine ?? engine,
                        spell: Boolean(parsed.spell),
                        normalized,
                        segments,
                        degraded: false,
                    });
                }
                catch {
                    done({ engine, spell: false, normalized: content, segments: fallbackSegments(content), degraded: true });
                }
            });
        }
        catch {
            done({ engine, spell: false, normalized: content, segments: fallbackSegments(content), degraded: true });
            return;
        }
        // 文本走 stdin:避免超长回复撞上命令行长度上限。
        try {
            child.stdin?.on('error', () => { });
            child.stdin?.end(content);
        }
        catch {
            /* 进程起不来时回调会兜住 */
        }
    });
}
