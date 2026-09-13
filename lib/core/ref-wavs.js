/**
 * 参考音频目录:克隆引擎( CosyVoice 2/3、IndexTTS )的"音色"其实就是一段
 * 参考音频,所以「自己配一个克隆音色」= 把一段 wav 放进一个目录里。
 *
 * 约定(有意的极简):
 *   <refDir>/我的声音.wav      ← 3~10 秒、干净、单人、无背景音乐
 *   <refDir>/我的声音.txt      ← 可选,这段 wav 说了什么(逐字)。写上它会走
 *                                zero-shot 路径,相似度和稳定性都明显更好;
 *                                不写就走 cross-lingual(上游忽略参考文本)。
 *
 * **音色标识就是 wav 的绝对路径**。这一点是刻意的:worker 会把当前音色名存下来,
 * 进程重启后还要能重新解析。若用 basename 当标识,重启后 cwd 变了就找不到文件
 * (实测就是这样坏的),而绝对路径永远解析得回来,也不需要把参考音频内容塞进
 * 每一条合成请求里。
 *
 * 这里只做"目录 → 列表"的发现,不读音频内容:读取/重采样交给引擎(上游
 * load_wav 会自动单声道化并重采样到 16k,所以 44.1k 立体声 wav 也能直接用)。
 */
import { homedir } from 'node:os';
import { join, resolve, extname, basename } from 'node:path';
import { readdirSync, statSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';

/** 默认目录:$DSH_HOME/voice-refs(scratch 环境据此天然隔离)。 */
export const DEFAULT_REF_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'voice-refs');

/** 认这两种容器:soundfile(libsndfile)两种都能读,wav 最稳。 */
export const REF_EXTS = ['.wav', '.flac'];

/**
 * 空串/纯空白一律算"没配",回落默认目录。
 * 和 ttsTextnormPath 同样的坑:`''` 不是 nullish,解构默认值不会生效。
 */
export function resolveRefDir(dir) {
    return typeof dir === 'string' && dir.trim() ? dir.trim() : DEFAULT_REF_DIR;
}

/**
 * 列出一个目录里的参考音频。
 *
 * @param dir - 目录(空则由 resolveRefDir 兜底)
 * @param deps - 测试接缝:readdir / isFile / readText
 * @returns `[{ id: 绝对路径, label: 不带扩展名的文件名 }]`,按 label 排序
 */
export function listRefWavs(dir, deps = {}) {
    const readdir = deps.readdir ?? readdirSync;
    const isFile = deps.isFile ?? defaultIsFile;
    const root = resolve(resolveRefDir(dir));
    let names;
    try {
        names = readdir(root);
    }
    catch {
        // 目录不存在是常态(用户还没配),不是错误。
        return [];
    }
    const out = [];
    for (const name of names) {
        if (typeof name !== 'string' || name.startsWith('.'))
            continue;
        const ext = extname(name).toLowerCase();
        if (!REF_EXTS.includes(ext))
            continue;
        const path = join(root, name);
        if (!isFile(path))
            continue;
        out.push({ id: path, label: basename(name, extname(name)) });
    }
    out.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
    return out;
}

function defaultIsFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}

/**
 * 音色名 → 安全的文件名主干。
 *
 * 面板允许用户给导入的音色起名,所以这个名字会直接参与拼路径 —— 必须挡住
 * `../` 与绝对路径,否则一个恶意/手滑的名字就能写到目录外面去。
 * 做法是"白名单字符 + 剔除首尾点":保留中文(用户一定会用中文起名),
 * 只干掉路径分隔符、控制字符和 Windows 保留字符。
 *
 * @returns 清洗后的主干;无法得到合法名字时返回 ''
 */
export function sanitizeRefName(name) {
    if (typeof name !== 'string')
        return '';
    // basename 先剥掉目录部分(`../x` 与 `/etc/passwd` 都只剩最后一段),
    // 再顺手去掉一个已识别的音频扩展名:调用方传 "我的声音.wav" 与
    // "我的声音" 应当等价,否则会存出 "我的声音.wav.wav"。
    //
    // Windows 的反斜杠必须先当成分隔符:`basename` 在 POSIX 上不认它,于是
    // `..\..\windows\config` 会被当成一个普通名字,清洗后变成
    // "windowssystem32config" —— 逃不出去,但也不是用户想要的名字。
    const flattened = name.replace(/\\/g, '/');
    const ext = extname(flattened).toLowerCase();
    const bare = REF_EXTS.includes(ext)
        ? basename(flattened, extname(flattened))
        : basename(flattened);
    const cleaned = bare
        .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '')
        .replace(/^[.\s]+/, '')
        .replace(/[.\s]+$/, '')
        .trim();
    if (!cleaned)
        return '';
    // 文件名长度上限:留出 ".txt" 与目录前缀的余量。
    return cleaned.slice(0, 100);
}

/**
 * 把一个参考音频写进目录(可选带上逐字文本)。
 *
 * 覆盖是**故意允许**的:用户重新录一遍再导入同名文件,期望是"更新音色",
 * 而不是"第二个同名音色"。所以这里明确覆盖而不是报错。
 *
 * @param dir - 参考音频目录(空则回落默认)
 * @param name - 用户给的名字(会被 sanitizeRefName 清洗)
 * @param audio - 音频字节(wav / flac 由调用方保证)
 * @param ext - 容器扩展名,默认 '.wav'
 * @param text - 可选:这段音频说了什么(写进同名 .txt)
 * @param deps - 测试接缝:mkdir / writeFile / unlink
 * @returns `{ id: 绝对路径, label: 主干, textPath }`
 */
export function saveRefWav(dir, name, audio, ext = '.wav', text = '', deps = {}) {
    const label = sanitizeRefName(name);
    if (!label)
        throw new Error('音色名不能为空（也不能只由 . / 空格组成）');
    const container = REF_EXTS.includes(String(ext).toLowerCase()) ? String(ext).toLowerCase() : '.wav';
    if (!Buffer.isBuffer(audio) && !(audio instanceof Uint8Array))
        throw new Error('参考音频内容无效');
    const root = resolve(resolveRefDir(dir));
    const mkdir = deps.mkdir ?? mkdirSync;
    const writeFile = deps.writeFile ?? writeFileSync;
    const unlink = deps.unlink ?? unlinkSync;
    mkdir(root, { recursive: true });
    const id = join(root, label + container);
    writeFile(id, audio);
    const textPath = join(root, label + '.txt');
    const body = typeof text === 'string' ? text.trim() : '';
    if (body)
        writeFile(textPath, body, 'utf8');
    else {
        // 名字对不上旧文本是**最坏**的情况:worker 会拿一段完全无关的文本去做
        // zero-shot,音色相似度直接崩。所以没有文本时要主动删掉遗留的同名 .txt。
        try {
            unlink(textPath);
        }
        catch { /* 本来就没有 */ }
    }
    return { id, label, textPath };
}

/**
 * 删掉一个参考音频(连同同名 .txt)。
 *
 * 只删这个目录里、扩展名在白名单里的文件:传入绝对路径也行(面板拿到的
 * id 就是绝对路径),但目录外的路径一律拒绝 —— 这个接口的语义是"管理参考
 * 音频",不是"通用删文件"。
 *
 * @returns `{ id, removed: boolean }`
 */
export function deleteRefWav(dir, name, deps = {}) {
    const root = resolve(resolveRefDir(dir));
    const unlink = deps.unlink ?? unlinkSync;
    const input = typeof name === 'string' ? name : '';
    if (!input)
        throw new Error('缺少要删除的音色名');
    const label = sanitizeRefName(input);
    if (!label)
        throw new Error('音色名无效');
    const removed = [];
    for (const ext of REF_EXTS) {
        const path = join(root, label + ext);
        try {
            unlink(path);
            removed.push(path);
        }
        catch { /* 不存在就是没删到 */ }
    }
    try {
        unlink(join(root, label + '.txt'));
    }
    catch { /* 同上 */ }
    return { id: join(root, label + '.wav'), removed: removed.length > 0 };
}

/**
 * 读参考音频的逐字文本(面板编辑时要回填)。没有就返回 ''。
 */
export function readRefText(dir, name, deps = {}) {
    const readText = deps.readText ?? defaultReadText;
    const label = sanitizeRefName(name);
    if (!label)
        return '';
    try {
        return readText(join(resolve(resolveRefDir(dir)), label + '.txt')).trim();
    }
    catch {
        return '';
    }
}

function defaultReadText(path) {
    return readFileSync(path, 'utf8');
}

/**
 * 把参考音频并进引擎回的音色目录。
 *
 * 只在**克隆类**引擎上调用:预置音色引擎(Kokoro)的音色是模型权重里的 id,
 * 给它塞文件路径毫无意义。两种形状都要能处理 —— 数组(CosyVoice / IndexTTS)
 * 直接追加;分组对象(Kokoro)会被原样返回,因为它的音色标识是 `zh=..,en=..`
 * 成对串,追加一个路径会破坏配对的解析。
 */
export function withRefVoices(voices, refs) {
    if (!Array.isArray(refs) || refs.length === 0)
        return voices;
    if (!Array.isArray(voices)) {
        if (voices !== null && typeof voices === 'object')
            return voices;
        return refs;
    }
    const known = new Set(voices.map(item => item !== null && typeof item === 'object' ? item.id : item));
    const extra = refs.filter(ref => !known.has(ref.id));
    return extra.length === 0 ? voices : [...voices, ...extra];
}
