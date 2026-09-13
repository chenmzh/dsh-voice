/**
 * 加载**构建产物** lib/client.js,验证客户端半真的能注册进两个槽位。
 *
 * 为什么值得单独测:esbuild 不校验具名导入是否存在。写错一个图标名、把
 * react-dom 忘了外部化、或者 slots API 用错,打包都会成功,只有在浏览器里
 * 才炸。这里用桩模块把 bundle 跑起来,把这类错误挡在部署之前。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'lib', 'client.js');

/** 最小桩:只在渲染时才用到的部分不需要真的行为。 */
const reactStub = {
    useEffect: () => { },
    useRef: () => ({ current: null }),
    useState: value => [value, () => { }],
    // 记录型 createElement:把渲染树真的搭出来,下面才能"跑一遍"组件。
    // React 会把第三个及之后的参数折成 props.children,这里必须照做,
    // 否则 Field/CloneVoiceBlock 这类取 props.children 的组件会读到 undefined。
    createElement: (type, props, ...children) => ({
        type,
        props: {
            ...(props ?? {}),
            // React 的真实行为:只有**有位置子节点**时才覆盖 props.children。
            // 一个位置子节点都没有时,显式传进来的 children 属性要原样留着
            // (Button 的文案就是这么传的)。
            ...(children.length === 0
                ? null
                : { children: children.length === 1 ? children[0] : children }),
        },
    }),
};
const stubs = {
    'react': reactStub,
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' },
    'react-dom': { createPortal: () => null },
    '@deepseek-ai/dsh-client-ui-primitives': {
        Button: function Button() { },
        IconChevronDownOutline14: function Icon() { },
        IconStopFill16: function Icon() { },
    },
};

function withStubs(fn) {
    const original = Module._load;
    Module._load = function (request, parent, isMain) {
        if (Object.hasOwn(stubs, request))
            return stubs[request];
        return original.call(this, request, parent, isMain);
    };
    try {
        return fn();
    }
    finally {
        Module._load = original;
    }
}

/** 造一个够用的 client ctx,并把注册到的槽位收集起来。 */
function makeCtx() {
    const errors = [];
    const disposers = [];
    const registrations = [];
    const injections = [];
    const listeners = new Set();
    const ctx = {
        logger: { warn: (...args) => errors.push(args.join(' ')), info: () => { }, error: (...args) => errors.push(args.join(' ')) },
        effect: fn => { disposers.push(fn()); },
        // settingsScope 是**可选**依赖(没有设置面板的部署里麦克风照样要能用),
        // 所以这里建模"没有这个 provider":inject 于是一次回调都不触发。
        inject: () => ({}),
        connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
        sessions: {
            list: {
                getSnapshot: () => ({ current: 'session-1' }),
                subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb); },
            },
            binding: () => ({
                eventSource: {
                    getSnapshot: () => ({ entries: [], change: null }),
                    subscribe: () => () => { },
                },
            }),
        },
        slots: {
            inject: (name, cb) => { injections.push(name); return cb(); },
            register: (options, Component) => { registrations.push({ options, Component }); return () => { }; },
        },
    };
    return { ctx, errors, disposers, registrations, injections };
}

/**
 * 执行 bundle 并取回它注册的模块导出。
 * bundle 自己是 `window.__ModuleLoader__.load({id, factory})`,真正的导出是
 * factory(require) 的返回值 —— 所以桩 load 必须把 factory 跑起来。
 */
let bundleModule;
let bundleLoaded = [];

/**
 * 执行 bundle 一次并取回它注册的模块导出(进程内缓存:require 会缓存文件,
 * 而且重复执行同一个 bundle 没有意义)。
 *
 * 注意:bundle 文件自身的 module.exports 是空的 —— 真正的插件导出是
 * factory(require) 的返回值,所以要在这里手动接住,不能靠 require() 的返回值。
 */
function loadBundle() {
    if (bundleModule)
        return { exports: bundleModule, loaded: bundleLoaded };
    const stubRequire = Module.createRequire(import.meta.url);
    globalThis.window = {
        __ModuleLoader__: {
            load: entry => {
                bundleLoaded.push(entry);
                // factory 拿到的 require 也走 Module._load 桩,才能取到 react 等外部依赖。
                bundleModule = entry.factory(stubRequire);
                return bundleModule;
            },
        },
    };
    withStubs(() => stubRequire(bundlePath));
    return { exports: bundleModule, loaded: bundleLoaded };
}

test('the built bundle registers under the package-name id the DSH graph expects', () => {
    const { exports, loaded } = loadBundle();
    try {
        assert.equal(loaded.length, 1, 'bundle 必须调用一次 __ModuleLoader__.load');
        // id 必须等于 package.json 的 name,否则 shell 认不出这一行。
        assert.equal(loaded[0].id, '@nn12138/dsh-voice');
        assert.equal(typeof loaded[0].factory, 'function');
        assert.equal(exports.name, 'dsh-voice');
    }
    finally {
        delete globalThis.window;
    }
});

test('apply() registers the read-aloud controls into both conversation slots', async () => {
    globalThis.document = {
        head: { appendChild() {} }, body: { append() {} }, defaultView: { addEventListener() {}, removeEventListener() {} },
        createElement: () => ({ dataset: {}, style: {}, addEventListener() {}, setAttribute() {}, remove() {} }),
        addEventListener: () => { },
        removeEventListener: () => { },
        getElementById: () => null,
        body: { append() {} },
    };
    globalThis.localStorage = {
        store: new Map(),
        getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
        setItem(key, value) { this.store.set(key, String(value)); },
    };
    const { exports: mod } = loadBundle();

    assert.equal(mod.name, 'dsh-voice');
    assert.ok(Array.isArray(mod.inject));
    assert.ok(mod.inject.includes('slots'), 'client 半必须注入 slots');
    assert.ok(mod.inject.includes('sessions'), '朗读要读会话事件,必须注入 sessions');
    assert.ok(mod.inject.includes('connection'), '朗读要调 RPC,必须注入 connection');

    const { ctx, errors, registrations, injections } = makeCtx();
    withStubs(() => mod.apply(ctx, {}));

    const bySlot = Object.fromEntries(registrations.map(r => [r.options.name, r]));
    assert.ok(bySlot['conversation.chat.assistant-actions'], '缺少每条消息的朗读按钮');
    assert.ok(bySlot['conversation.input.right'], '缺少输入框旁的模型/人声选择器');
    // 槽位必须先 inject 再 register(未声明的槽位直接 register 会抛)。
    assert.ok(injections.includes('conversation.chat.assistant-actions'));
    assert.ok(injections.includes('conversation.input.right'));
    // 同一槽位内的 id 不能重复,否则 list 槽会互相替换。
    const ids = registrations.map(r => r.options.id);
    assert.equal(new Set(ids).size, ids.length, `重复的槽位 id: ${ids.join(', ')}`);

    // 麦克风按钮必须还在(不能因为加功能把旧功能挤掉)。
    assert.ok(bySlot['conversation.input.left'], '麦克风按钮被挤掉了');
    assert.ok(!errors.some(line => /Error|undefined/.test(line)), `启动时报错: ${errors.join(' | ')}`);

    // 两个注入面都要给出组件真正会读的字段。
    const speakInject = bySlot['conversation.chat.assistant-actions'].options.inject('session-1');
    assert.equal(typeof speakInject.onSpeak, 'function');
    assert.ok(speakInject.hooks.tts, '朗读按钮需要 tts hooks');
    speakInject.onSpeak('msg-1');

    const pickerInject = bySlot['conversation.input.right'].options.inject('session-1');
    for (const fn of ['onSelect', 'onUnload', 'onAutoRead', 'onSetVoice', 'onLoadVoices'])
        assert.equal(typeof pickerInject[fn], 'function', `选择器缺少 ${fn}`);
    assert.ok(pickerInject.hooks.tts);

    for (const dispose of registrations.map(() => null))
        void dispose;
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.localStorage;
});

/**
 * 把 createElement 搭出来的树展开一遍(含函数组件本身)。
 *
 * 为什么要这样测:「语音」设置页有五百多行,而它从来没在任何浏览器里跑过 ——
 * 读一个不存在的 state 字段、把 props 名写错、hooks 用错,全都要等用户打开
 * 设置面板才会暴露。展开一遍能让这些错误在部署之前就抛出来。
 */
function expandTree(node, depth = 0, out = []) {
    if (node === null || node === undefined)
        return out;
    if (Array.isArray(node)) {
        for (const child of node)
            expandTree(child, depth, out);
        return out;
    }
    if (typeof node !== 'object' || !('type' in node))
        return out;
    out.push(node);
    // DOM 标签只往下走子节点;函数组件自己再执行一次(深度上限防自引用死循环)。
    if (typeof node.type === 'function' && depth < 12)
        expandTree(node.type(node.props), depth + 1, out);
    expandTree(node.props.children, depth + 1, out);
    return out;
}

/** 面板状态的完整形状(照 settings-store.js 的 initialState)。 */
function panelState(overrides = {}) {
    return {
        status: 'ready',
        value: null,
        overridden: [],
        writable: true,
        mode: 'host',
        saving: false,
        error: '',
        note: '',
        languages: [],
        instructLanguages: [],
        engines: [],
        engineChoices: [],
        refDir: '',
        refs: [],
        refsBusy: false,
        ...overrides,
    };
}

/** 假的 store:只实现组件真正调用的那几个方法,并记录调用。 */
function fakeStore() {
    const calls = [];
    return {
        calls,
        set: (field, value) => { calls.push(['set', field, value]); return Promise.resolve(true); },
        resetField: field => { calls.push(['resetField', field]); return Promise.resolve(true); },
        resetAll: () => { calls.push(['resetAll']); return Promise.resolve(true); },
        refreshRefs: () => { calls.push(['refreshRefs']); return Promise.resolve(); },
        saveRef: payload => { calls.push(['saveRef', payload]); return Promise.resolve(true); },
        deleteRef: name => { calls.push(['deleteRef', name]); return Promise.resolve(true); },
    };
}

/** 渲染一次「语音」设置页,返回展开后的节点数组。 */
function renderSection(state, store = fakeStore()) {
    const { exports } = loadBundle();
    const { ctx, registrations } = makeCtx();
    globalThis.document = {
        head: { appendChild() {} }, body: { append() {} }, defaultView: { addEventListener() {}, removeEventListener() {} },
        createElement: () => ({ dataset: {}, style: {}, addEventListener() {}, setAttribute() {}, remove() {} }),
        addEventListener: () => { }, removeEventListener: () => { }, getElementById: () => null,
    };
    globalThis.localStorage = { store: new Map(), getItem: () => null, setItem: () => { } };
    try {
        withStubs(() => exports.apply(ctx, {}));
        const section = registrations.find(item => item.options.name === 'settings.section');
        assert.ok(section, '不注册 settings.section 的话设置面板里根本不会有「语音」这一页');
        const props = { ...section.options.inject(undefined), useSettings: selector => selector(state) };
        return { nodes: expandTree(section.Component(props)), store, options: section.options };
    }
    finally {
        delete globalThis.window;
        delete globalThis.document;
        delete globalThis.localStorage;
    }
}

/** 一个 <select> 的选项值列表(children 可能是单个节点或数组)。 */
function optionValues(selectNode) {
    return [].concat(selectNode.props.children ?? [])
        .filter(node => node && node.type === 'option')
        .map(node => String(node.props.value));
}

test('「语音」设置页能真的渲染:语言/引擎/克隆音色都跟着设置值走', () => {
    const store = fakeStore();
    const { nodes } = renderSection(panelState({
        value: {
            asrLanguage: 'de',
            ttsEngine: 'kokoro',
            ttsVisibleEngines: ['kokoro', 'cosyvoice'],
            ttsVoice: { cosyvoice: '/refs/我的声音.wav' },
            ttsAutoRead: true,
            ttsInstructLanguage: 'de',
            ttsInstructText: '',
        },
        overridden: ['asrLanguage'],
        languages: [
            { value: 'auto', label: '自动检测（推荐）' },
            { value: 'de', label: '德语（German）' },
        ],
        // 朗读语言指令下拉同样来自 host(core/tts-instruct.js),面板不自己维护。
        instructLanguages: [
            { value: 'auto', label: '不指定（保持原样,最快）' },
            { value: 'de', label: '德语(German)' },
            { value: 'ja', label: '日语(Japanese) — 未实测' },
        ],
        // 全量目录里故意含一个**被藏起来**的引擎:勾选框必须还能看到它。
        engineChoices: [
            { id: 'kokoro', label: 'Kokoro', voiceKind: 'preset' },
            { id: 'cosyvoice', label: 'CosyVoice2', voiceKind: 'clone' },
            { id: 'indextts', label: 'IndexTTS', voiceKind: 'clone' },
        ],
        engines: [{ id: 'kokoro', label: 'Kokoro' }, { id: 'cosyvoice', label: 'CosyVoice2' }],
        refDir: '/refs',
        refs: [{ id: '/refs/我的声音.wav', label: '我的声音', text: '这是一段测试。' }],
    }), store);

    const selects = nodes.filter(node => node.type === 'select');
    // 语言下拉的值 = 设置文档里的值(这是 STT 多语言配置这一条的落点)。
    const language = selects.find(node => optionValues(node).includes('auto') && optionValues(node).includes('de'));
    assert.ok(language, '找不到语言下拉');
    assert.equal(language.props.value, 'de');
    // 每个选项都来自 host 下发的语言表(面板不自己维护 ISO 码)。
    assert.deepEqual(optionValues(language), ['auto', 'de']);

    // 「默认引擎」下拉的值必须在选项里,否则原生 select 会安静地显示第一项。
    const engineSelect = selects.find(node => optionValues(node).includes('cosyvoice'));
    assert.ok(engineSelect, '找不到默认引擎下拉,或它的选项里缺少当前值');
    assert.equal(engineSelect.props.value, 'kokoro');
    // 被藏起来、又不是当前值的引擎不应该出现在"默认引擎"里(它能被藏起来,
    // 说明用户不想在面板里看到它);但当前值永远要在,否则显示的就是假值。
    assert.ok(!optionValues(engineSelect).includes('indextts'), '被藏起来的引擎不该出现在默认引擎下拉里');

    // 「显示哪些引擎」的勾选框:每个引擎一个,包括被藏起来的 indextts。
    const visibilityLabels = nodes.filter(node => typeof node.props.children === 'string'
        && /^(Kokoro|CosyVoice2|IndexTTS)/.test(node.props.children));
    const boxLabels = visibilityLabels.map(node => node.props.children);
    assert.ok(boxLabels.includes('IndexTTS'), '被藏起来的引擎没有出现在勾选框里 —— 那就再也勾不回来了');
    // 每个勾选框都要有一个配对的 checkbox input。
    assert.equal(nodes.filter(node => node.type === 'input' && node.props.type === 'checkbox').length >= 4, true);

    // 克隆引擎的音色下拉:选项来自参考音频目录,值是绝对路径(与 ttsVoice 存法一致)。
    const cloneSelect = selects.find(node => optionValues(node).includes('/refs/我的声音.wav'));
    assert.ok(cloneSelect, '克隆引擎的音色下拉里没有参考音频目录里的那个音色');
    assert.equal(cloneSelect.props.value, '/refs/我的声音.wav');

    // 被改过的字段要带「已改」标记,页脚要说清有几项被改过。
    const texts = nodes.filter(node => typeof node.props.children === 'string')
        .map(node => node.props.children).join('\n');
    assert.match(texts, /已改/);
    assert.match(texts, /有 1 项被改过/);
    assert.match(texts, /全部恢复默认/);

    // ---- 朗读语言指令这两行(本版新增的「row」)---------------------------- //
    // 它的值也必须落在自己的选项集里,否则原生 select 会安静地显示第一项
    // 「不指定」,而用户看到的和他实际设置的不是一回事。
    const instructSelect = selects.find(node => optionValues(node).includes('ja'));
    assert.ok(instructSelect, '找不到朗读语言下拉');
    assert.equal(instructSelect.props.value, 'de');
    assert.deepEqual(optionValues(instructSelect), ['auto', 'de', 'ja']);
    // 没实测过的语言要在标签里说明,不能混在一起假装一样可靠。
    const jaOption = [].concat(instructSelect.props.children)
        .find(node => node && node.type === 'option' && node.props.value === 'ja');
    assert.match(String(jaOption.props.children), /未实测/);
    // 自定义指令是一个可填的文本框,而不是只读文字。
    const customInput = nodes.find(node => node.type === 'input'
        && node.props.type !== 'checkbox' && node.props.type !== 'file'
        && node.props.placeholder !== undefined
        && /语气|朗读/.test(String(node.props.placeholder)));
    assert.ok(customInput, '找不到「自定义朗读指令」的输入框');
});

test('设置文档不可写时,面板整块置灰而不是给出点了没反应的控件', () => {
    const { nodes } = renderSection(panelState({
        writable: false,
        mode: 'memory',
        value: { asrLanguage: 'auto', ttsEngine: 'kokoro', ttsVisibleEngines: ['kokoro'] },
        languages: [{ value: 'auto', label: '自动检测（推荐）' }],
        engineChoices: [{ id: 'kokoro', label: 'Kokoro', voiceKind: 'preset' }],
    }));
    // 真正的控件是 select / input / button;label 只是包着 checkbox 的壳,
    // 它自己没有 disabled。
    const controls = nodes.filter(node => node.type === 'select' || node.type === 'input' || node.type === 'button');
    assert.ok(controls.length > 3, `控件太少,渲染可能提前中断: ${controls.length}`);
    for (const control of controls)
        assert.equal(control.props.disabled, true, `${String(control.type)} 没有置灰`);
    const texts = nodes.filter(node => typeof node.props.children === 'string')
        .map(node => node.props.children).join('\n');
    assert.match(texts, /没有可写的设置文档/);
});

test('the bundle externalises react and react-dom instead of inlining them', () => {
    const source = readFileSync(bundlePath, 'utf8');
    const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]);
    const unique = [...new Set(requires)].sort();
    assert.deepEqual(unique, [
        '@deepseek-ai/dsh-client-ui-primitives',
        'react',
        'react-dom',
        'react/jsx-runtime',
    ]);
    // 内联 react-dom 会让 bundle 从 ~50KB 涨到几百 KB;这里当回归护栏。
    assert.ok(source.length < 200000, `bundle 过大,可能内联了依赖: ${source.length} 字节`);
});

test('settings tab and chat auto-read checkbox stay synchronized through the real client bundle', async () => {
    const { exports } = loadBundle();
    const { ctx, registrations, disposers } = makeCtx();
    const listeners = new Set();
    const value = { ttsAutoRead: false };
    const writes = [];
    const scope = {
        getSnapshot: () => ({ value, user: value, writable: true, mode: 'host' }),
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        async set(field, next) { writes.push([field, next]); value[field] = next; for (const fn of listeners) fn(); },
    };
    ctx.inject = (_names, fn) => { const dispose = fn({ settingsScope: { bind: () => scope } }); disposers.push(dispose); return {}; };
    ctx.connection.rpc.call = async (_channel, endpoint) => ({ ok: true, value: endpoint === 'config'
        ? { autoRead: value.ttsAutoRead, settings: value, engines: [] } : { state: 'idle', active: null } });
    globalThis.window = { localStorage: { getItem: () => '0', setItem() {} } };
    globalThis.document = {
        head: { appendChild() {} }, body: { append() {} }, defaultView: { addEventListener() {}, removeEventListener() {} },
        createElement: () => ({ dataset: {}, style: {}, addEventListener() {}, setAttribute() {}, remove() {} }), addEventListener() {}, removeEventListener() {} };
    try {
        withStubs(() => exports.apply(ctx));
        await new Promise(resolve => setTimeout(resolve, 0));
        const picker = registrations.find(r => r.options.id === 'voice-tts').options.inject();
        const panel = registrations.find(r => r.options.id === 'voice').options.inject();
        assert.equal(picker.hooks.tts.state.autoRead, false);
        await panel.store.set('ttsAutoRead', true);
        assert.equal(picker.hooks.tts.state.autoRead, true, 'Enabling the settings checkbox must affect the live controller');
        picker.onAutoRead(false);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(value.ttsAutoRead, false);
        assert.equal(panel.store.state.value.ttsAutoRead, false);
        assert.deepEqual(writes, [['ttsAutoRead', true], ['ttsAutoRead', false]]);
    } finally {
        for (const dispose of disposers.reverse()) dispose?.();
        delete globalThis.window; delete globalThis.document;
    }
});
