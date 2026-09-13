/**
 * CosyVoice 3 朗读语言指令(inference_instruct2)这条链路的测试。
 *
 * 为什么值得单独一个文件:这条链路的每一段都能"看起来对但不生效",而且失败
 * 方式是**静默**的 —— 指令没拼上前缀模型照读(只是不听指令)、把已注册的声纹
 * id 一起传进去指令会被 frontend 直接忽略、text_frontend 忘了关会把德语读成
 * 荷兰语。三种都不会抛异常,只会让用户觉得"我改了设置但没反应"。
 *
 * 实测证据在 lang-probe-out/qwen-cv3final.json(F1/F2/F5 有效,F4 是 tf=True
 * 的反面教材,F7/F8 证明指令不覆盖中文)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    INSTRUCT_AUTO, buildInstruct, instructLanguageOptions, instructTextFrontend,
    isInstructLanguage, normalizeInstruct, normalizeInstructLanguage,
} from '../lib/core/tts-instruct.js';
import { TtsManager } from '../lib/core/tts-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = readFileSync(path.join(HERE, '..', 'python', 'tts_worker.py'), 'utf8');

// --------------------------------------------------------------- 指令拼装

test('auto + 空自定义文本 = 不带指令(默认行为必须和以前逐字一样)', () => {
    assert.equal(buildInstruct(INSTRUCT_AUTO, ''), null);
    assert.equal(buildInstruct(INSTRUCT_AUTO, undefined), null);
    // 拼错的码同样退回 auto,绝不因为一个错字给所有朗读加指令。
    assert.equal(buildInstruct('kr', ''), null);
    assert.equal(buildInstruct(null, ''), null);
});

test('选了语言就生成实测过的那条英文指令(逐字对齐 F1)', () => {
    // F1 实测值为:
    // 'You are a helpful assistant. Please read the following sentence in German.<|endofprompt|>'
    assert.equal(
        buildInstruct('de', ''),
        'You are a helpful assistant. Please read the following sentence in German.<|endofprompt|>',
    );
    assert.equal(
        buildInstruct('fr', ''),
        'You are a helpful assistant. Please read the following sentence in French.<|endofprompt|>',
    );
});

test('每条指令都必须以 <|endofprompt|> 收尾,否则 CosyVoice3 的 LM 会硬崩', () => {
    // llm.py 断言 151646(<|endofprompt|>)出现在 concat(prompt_text, text) 里。
    for (const code of ['de', 'fr', 'en', 'zh', 'ja']) {
        const text = buildInstruct(code, '');
        assert.ok(text.endsWith('<|endofprompt|>'), `${code} 的指令没有收尾标记: ${text}`);
        assert.match(text, /^You are a helpful assistant\. /, `${code} 的指令缺助手前缀`);
    }
});

test('用户自己写的完整指令不会被重复加前缀或重复收尾', () => {
    const messy = '<|endofprompt|>You are a helpful assistant. 用四川话说这句话<|endofprompt|>';
    const built = normalizeInstruct(messy);
    assert.equal(built, 'You are a helpful assistant. 用四川话说这句话<|endofprompt|>');
    assert.equal((built.match(/<\|endofprompt\|>/g) ?? []).length, 1);
    assert.equal((built.match(/You are a helpful assistant\./g) ?? []).length, 1);
});

test('只有空白的自定义指令不算指令(不是"空指令",是"没有指令")', () => {
    assert.equal(normalizeInstruct('   '), null);
    assert.equal(normalizeInstruct(null), null);
    // 但语言仍然生效:自定义留空时回落到语言的模板。
    assert.equal(buildInstruct('de', '   '), buildInstruct('de', ''));
});

test('自定义指令优先于语言下拉(它是"我具体想说的话")', () => {
    const built = buildInstruct('de', '请用很轻快的语气朗读');
    assert.match(built, /请用很轻快的语气朗读/);
    assert.doesNotMatch(built, /in German/);
});

test('带指令就必须关掉 text_frontend —— 这是实测结论,不是选项', () => {
    assert.equal(instructTextFrontend('You are a helpful assistant. X<|endofprompt|>'), false);
    assert.equal(instructTextFrontend(null), true);
});

test('语言守卫:未知/空值一律当 auto,合法值原样保留', () => {
    assert.equal(normalizeInstructLanguage('de'), 'de');
    assert.equal(normalizeInstructLanguage('nope'), INSTRUCT_AUTO);
    assert.equal(normalizeInstructLanguage(undefined), INSTRUCT_AUTO);
    assert.equal(normalizeInstructLanguage(42), INSTRUCT_AUTO);
    assert.equal(isInstructLanguage('de'), true);
    assert.equal(isInstructLanguage('De'), false);
});

test('下发给面板的选项第一项是"不指定",而且没实测过的语言会被标出来', () => {
    const options = instructLanguageOptions();
    assert.equal(options[0].value, INSTRUCT_AUTO);
    const de = options.find(o => o.value === 'de');
    const ja = options.find(o => o.value === 'ja');
    assert.ok(de && ja);
    assert.doesNotMatch(de.label, /未实测/);
    assert.match(ja.label, /未实测/, '没量过的语言不能在面板里假装和德语一样可靠');
    // 每个选项都得是 {value,label},否则 <option> 会渲染成 undefined。
    for (const option of options) {
        assert.equal(typeof option.value, 'string');
        assert.equal(typeof option.label, 'string');
    }
});

// ----------------------------------------------------------------- 管理器

function makeManagerDeps(sent) {
    const createProc = spec => {
        const proc = {
            id: spec.id,
            ready: false,
            async start() {
                proc.ready = true;
                proc.info = { ready: true, engine: spec.id, loadSeconds: 1 };
                return proc;
            },
            async unload() { proc.ready = false; },
            async voices() { return { voices: ['v1'], voice: spec.defaultVoice }; },
            async setVoice(voice) { return { voices: ['v1'], voice }; },
            async speak(payload) { sent.push(payload); return { wav: null, skipped: 'empty' }; },
            async stats() { return {}; },
            dispose() {},
        };
        return proc;
    };
    return { createProc, exists: () => true, queryVram: async () => 5000 };
}

test('auto 时合成请求里**不能**出现 instruct(请求形状与以前逐字相同)', async () => {
    const sent = [];
    const mgr = new TtsManager({ ttsRoot: '/t', modelsRoot: '/m', engine: 'cosyvoice3' },
        () => {}, makeManagerDeps(sent));
    mgr.applySettings({ ttsEngine: 'cosyvoice3', ttsRoot: '/t', ttsModelsRoot: '/m',
        ttsInstructLanguage: 'auto', ttsInstructText: '' });
    await mgr.speak({ text: '你好' });
    assert.equal(sent.length, 1);
    assert.equal('instruct' in sent[0], false, 'auto 时不该给 worker 发一个多余字段');
});

test('选了语言之后,合成请求带上拼好的指令', async () => {
    const sent = [];
    const mgr = new TtsManager({ ttsRoot: '/t', modelsRoot: '/m', engine: 'cosyvoice3' },
        () => {}, makeManagerDeps(sent));
    mgr.applySettings({ ttsEngine: 'cosyvoice3', ttsRoot: '/t', ttsModelsRoot: '/m',
        ttsInstructLanguage: 'de' });
    await mgr.speak({ text: 'Der Preis ist 3,5 Prozent.' });
    assert.equal(
        sent[0].instruct,
        'You are a helpful assistant. Please read the following sentence in German.<|endofprompt|>',
    );
});

test('改语言是热字段:不许因为改了它就把模型换掉重载', async () => {
    const sent = [];
    const createProc = makeManagerDeps(sent).createProc;
    const events = [];
    const mgr = new TtsManager({ ttsRoot: '/t', modelsRoot: '/m', engine: 'cosyvoice3' },
        message => events.push(message), {
            createProc: spec => {
                const proc = createProc(spec);
                const start = proc.start.bind(proc);
                proc.start = async () => { events.push(`start:${spec.id}`); return start(); };
                return proc;
            },
            exists: () => true,
            queryVram: async () => 5000,
        });
    mgr.applySettings({ ttsEngine: 'cosyvoice3', ttsRoot: '/t', ttsModelsRoot: '/m', ttsInstructLanguage: 'auto' });
    await mgr.ensureReady();
    events.length = 0;
    // 只是把语言从 auto 改成德语:绝不该重新拉起 24s 的 CosyVoice3。
    mgr.applySettings({ ttsEngine: 'cosyvoice3', ttsRoot: '/t', ttsModelsRoot: '/m', ttsInstructLanguage: 'de' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(events.filter(e => e.startsWith('start:')).length, 0, '改指令语言重载了模型');
    assert.match(mgr.instruct, /in German/);
});

// -------------------------------------------------------------- worker 侧

test('每个引擎的 synthesize 都接受 instruct,否则调度那一行会 TypeError', () => {
    // 调度只写一行 engine.synthesize(..., instruct=instruct);任何一个引擎
    // 少这个参数,那次朗读就会以 TypeError 结束,而不是"忽略指令"。
    const signatures = [...WORKER_SRC.matchAll(/^    def synthesize\(self, ([^)]*)\)/gm)]
        .map(match => match[1]);
    assert.equal(signatures.length, 4, `预期 4 个引擎各自定义 synthesize,实际 ${signatures.length} 个`);
    for (const signature of signatures) {
        assert.match(signature, /instruct=None/, `synthesize 缺 instruct 参数: ${signature}`);
    }
});

test('worker 的指令通道用的是 inference_instruct2,并且关掉了 text_frontend', () => {
    assert.match(WORKER_SRC, /inference_instruct2\(/);
    // 指令 + tf=True 会被英文数字规则搅成荷兰语(F4 实测),所以必须显式 False。
    assert.match(WORKER_SRC, /text_frontend=False/);
});

test('指令通道绝不能传已注册的声纹 id —— 传了指令就被 frontend 静默忽略', () => {
    // frontend_zero_shot:zero_shot_spk_id 非空时直接返回 spk2info,instruct_text
    // 那一份 prompt_text 根本不会被 tokenize。
    const call = WORKER_SRC.match(/self\.model\.inference_instruct2\(([\s\S]*?)\):/);
    assert.ok(call, '没找到 inference_instruct2 的调用');
    assert.doesNotMatch(call[1], /zero_shot_spk_id\s*=/, '指令通道不该指定 zero_shot_spk_id');
});

test('非 CosyVoice 引擎拿到指令时要留日志,不能静默忽略', () => {
    // 用户把语言设成德语却还在用 kokoro 时,设置会被忽略;不留痕迹的话
    // 表现就是"我改了设置但听起来没变"。
    assert.match(WORKER_SRC, /忽略朗读指令/);
});
