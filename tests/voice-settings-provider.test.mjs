/**
 * 对着**真的**设置 provider(`@deepseek-ai/dsh-settings-file`)跑一遍「语音」设置。
 *
 * 为什么值得单独一个文件:voice-settings.test.mjs 用的是内存假 provider,它
 * 只能证明"我以为的契约"。而这一条链路上真正会咬人的是 provider 自己的行为:
 *   - 行内 config 到底是不是 base 层(清掉一项之后退回的是它,不是 schema 默认值);
 *   - watch 到底会不会在写入后被调用(不会的话面板改了设置要重启才生效);
 *   - 非法写入会不会污染已经解析出来的值;
 *   - `describe()` 交出去的那份序列化 schema,客户端的 `new Schema(json)` 能不能
 *     水合 —— 水合不了的命名空间**发布不出任何值**,面板会永远停在 loading。
 *
 * 这些都是"读文档读不出来、只有跑一遍才知道"的东西,而且不需要 GPU,几百毫秒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file';
import Schema from '@deepseek-ai/schemastery';
import { VoiceSettingsSchema, VOICE_NAMESPACE } from '../lib/core/settings-schema.js';

/** 一个把日志攒起来、并且永远不会抛的 logger(provider 会 warning 打得很响)。 */
function captureLogger(lines) {
    const push = level => (...args) => { lines.push([level, args.map(String).join(' ')]); };
    const logger = push('log');
    logger.info = push('info');
    logger.warn = push('warn');
    logger.error = push('error');
    logger.debug = push('debug');
    return logger;
}

/**
 * 等 provider 把文档读进来。
 *
 * 真实部署里这一步由 cordis 的服务生命周期完成:基类 `SettingsProvider` 的
 * `[Service.init]` 会「在服务变成可注入之前」把文档读一次并发布(源码注释原话:
 * load the provider's document once and publish it before the service becomes
 * injectable)。所以我们的 `ctx.inject(['settings'], …)` 回调跑起来时,用户的
 * voice 段**已经在里面了** —— 这正是 host 在注册后立刻 applySettings() 一遍
 * 也安全的原因。这里手工把同一个生成器驱动完,等价于真实启动路径。
 */
async function driveInit(provider) {
    const disposers = [];
    for await (const dispose of provider[Service.init]())
        disposers.push(dispose);
    return disposers;
}

/**
 * 建一个真的文件型 provider,挂上 voice 命名空间,并跑完它的服务初始化。
 * @param body - 初始 settings.yaml 内容。
 */
async function realProvider(body) {
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-provider-'));
    const file = path.join(dir, 'settings.yaml');
    writeFileSync(file, body);
    const lines = [];
    const ctx = new Context();
    ctx.logger = captureLogger(lines);
    // watch: false —— 不装文件监听,测试进程才能干净退出(监听会留 handle)。
    const provider = new FileSettingsProvider(ctx, { path: file, watch: false });
    const disposers = await driveInit(provider);
    const scope = provider.register(VOICE_NAMESPACE, VoiceSettingsSchema, {
        base: { hotkey: 'alt+m', ttsEngine: 'kokoro' },
        applies: 'live',
    });
    const close = async () => {
        for (const dispose of disposers.reverse())
            await dispose?.();
    };
    return { provider, scope, file, lines, close, text: () => lines.map(line => line.join(' ')).join('\n') };
}

test('三层解析:用户层 > 行内 config(base) > schema 默认值', async () => {
    const { provider, scope, close } = await realProvider('voice:\n  asrLanguage: de\n  hotkey: ctrl+m\n');
    const value = scope.get();
    // 用户层。它必须在**注册那一刻**就已经在了(见 driveInit 的说明):
    // 否则 host 注册后紧接着的那次 applySettings 会用 base+默认值把用户
    // 存下来的设置盖掉,而那正是"重启后设置没了"的成因。
    assert.equal(value.asrLanguage, 'de');
    assert.equal(value.hotkey, 'ctrl+m');
    // base 层就是 cordis.patch.yml 那一份 —— 用户在面板里清掉 hotkey 之后
    // 退回的必须是它,而不是 schema 默认值。
    assert.equal(value.ttsEngine, 'kokoro');
    // schema 默认值。
    assert.equal(value.ttsAutoRead, true);
    // 25 个键全部解析出来:少一个都可能是 schema 写错了名字。
    assert.equal(Object.keys(value).length, 25);
    // 朗读语言指令这两项是本版新增的,单独钉一下默认值:auto + 空串必须
    // 解析成"不带指令"(= draft.13 的行为),绝不能凭空给所有朗读加一条指令。
    assert.equal(value.ttsInstructLanguage, 'auto');
    assert.equal(value.ttsInstructText, '');
    await close();
    provider.dispose?.();
});

test('清掉用户层之后退回的是行内 config,不是 schema 默认值', async () => {
    const { provider, scope, close } = await realProvider('voice:\n  asrLanguage: de\n');
    assert.equal(scope.get().hotkey, 'alt+m');
    await scope.replace({});
    const value = scope.get();
    assert.equal(value.hotkey, 'alt+m', '没有退回行内 config(base 层)');
    assert.equal(value.asrLanguage, 'auto', '没有退回 schema 默认值');
    assert.equal(value.ttsEngine, 'kokoro');
    await close();
    provider.dispose?.();
});

test('写入落盘、watch 被通知、非法值被拒且不污染已解析的值', async () => {
    const { provider, scope, file, close } = await realProvider('voice: {}\n');
    const seen = [];
    const stop = scope.watch((next, prev) => seen.push([next.asrLanguage, prev?.asrLanguage]));

    await scope.update({ asrLanguage: 'fr' });
    // watch 的回调是异步、串行触发的,给它一拍。
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(seen.at(-1), ['fr', 'auto'], 'watch 没有在写入后被通知,面板改了设置要重启才生效');
    assert.equal(scope.get().asrLanguage, 'fr');
    // 真的写进文档了(这是"重启后还在"的来源)。
    assert.match(readFileSync(file, 'utf8'), /asrLanguage: fr/);

    // 非法枚举:错误里要带字段路径,而且已解析的值必须原样不动。
    await assert.rejects(() => scope.update({ asrLanguage: 'klingon' }), /asrLanguage/);
    assert.equal(scope.get().asrLanguage, 'fr', '一次被拒的写入污染了已经好用的值');

    // replace({}) 是"全部恢复默认":用户层清空,退回 base。
    await scope.replace({});
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(scope.get().asrLanguage, 'auto');
    assert.equal(scope.get().hotkey, 'alt+m', '清空用户层之后没有退回行内 config');
    stop();
    await close();
    provider.dispose?.();
});

test('存量 document 里的非法值会让 register 抛错 —— 所以 host 必须兜住它', async () => {
    // 这条是整个改动里最反直觉、也最容易踩的一条:文档是在服务初始化时
    // **先发布再注册**的,所以注册那一刻"上一份好值"并不存在,一段非法的
    // voice 段会让 register() 直接抛。host 里那个 try/catch 不是装饰,
    // 它决定了"用户手改 settings.yaml 打错一个字"是否会让整个语音插件起不来。
    //
    // 驱动顺序必须和真实启动一致(先 init 发布文档、再注册),否则这条测不到:
    // 文档没发布时注册当然成功,那正是我第一版写错的地方。
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-provider-'));
    const file = path.join(dir, 'settings.yaml');
    writeFileSync(file, 'voice:\n  asrLanguage: klingon\n  hotkey: ctrl+m\n');
    const ctx = new Context();
    ctx.logger = captureLogger([]);
    const provider = new FileSettingsProvider(ctx, { path: file, watch: false });
    await driveInit(provider);
    assert.throws(
        () => provider.register(VOICE_NAMESPACE, VoiceSettingsSchema, { base: {}, applies: 'live' }),
        // 报错里必须点名是哪个字段、什么取值 —— 用户要靠它去修文件。
        /asrLanguage[\s\S]*klingon/,
        '非法存量值没有让注册抛错:那么 host 的 try/catch 就永远走不到,面板会显示一份沉默的默认值');
    provider.dispose?.();
});

test('describe() 交出去的序列化 schema,客户端 new Schema(json) 能水合并照样校验', async () => {
    const { provider, close } = await realProvider('voice:\n  asrLanguage: de\n');
    const descriptors = provider.describe({ redactSecrets: true });
    const descriptor = descriptors.find(item => item.ns === VOICE_NAMESPACE);
    assert.ok(descriptor, 'describe 里没有 voice 命名空间 —— 设置面板就不会有这一页');
    assert.equal(descriptor.applies, 'live');
    // base / user 是面板用来算"哪些字段被改过"的两层。
    assert.deepEqual(descriptor.base, { hotkey: 'alt+m', ttsEngine: 'kokoro' });
    assert.deepEqual(descriptor.user, { asrLanguage: 'de' });

    // 客户端那一半就是这么水合的(SettingsSchemaService.rehydrate)。
    // 这一步坏掉的后果很隐蔽:命名空间发布不出值,面板永远 loading。
    const rehydrated = new Schema(descriptor.schema);
    const resolved = rehydrated({ asrLanguage: 'de' });
    assert.equal(resolved.asrLanguage, 'de');
    assert.equal(resolved.ttsEngine, 'kokoro');
    assert.deepEqual(resolved.ttsVoice, {});
    // 水合之后校验能力也必须还在,否则客户端会把非法值发给 host。
    assert.throws(() => rehydrated({ asrLanguage: 'klingon' }));
    assert.throws(() => rehydrated({ ttsVisibleEngines: ['nope'] }));
    await close();
    provider.dispose?.();
});
