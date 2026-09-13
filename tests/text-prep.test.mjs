/**
 * text-prep 是"朗读前把回复变成可读句子"的那一步。
 *
 * 这里刻意跑真的 textnorm.py(不 mock),因为它就是宿主与已验证规则之间唯一的
 * 接缝:一旦 CLI 的参数名或 JSON 字段漂移,这里必须红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TEXTNORM, fallbackSegments, prepareSegments } from '../lib/core/text-prep.js';
import { TtsManager } from '../lib/core/tts-manager.js';

const REPLY = [
    '我改了配置。',
    '',
    '```python',
    'print(1)',
    '```',
    '',
    '版本 3.5 已经发布了，请查看 README.md 并重启服务。',
].join('\n');

test('the normalizer CLI is present where text-prep expects it', async () => {
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(DEFAULT_TEXTNORM), `missing ${DEFAULT_TEXTNORM}`);
});

test('prepareSegments strips markdown and splits the reply into sentences', async () => {
    const result = await prepareSegments(REPLY, { engine: 'kokoro' });
    assert.equal(result.degraded, false);
    assert.equal(result.spell, false);
    assert.ok(!result.normalized.includes('print'), 'code fence must not be spoken');
    assert.ok(!result.normalized.includes('```'));
    assert.deepEqual(result.segments, [
        '我改了配置。',
        '版本 3.5 已经发布了，请查看 README.md 并重启服务。',
    ]);
});

test('prepareSegments spells digits for the engines that need it', async () => {
    const result = await prepareSegments('2026年价格是 1280元。', { engine: 'cosyvoice' });
    assert.equal(result.spell, true);
    assert.deepEqual(result.segments, ['二零二六年价格是 一千二百八十元。']);
});

test('prepareSegments accepts every engine id the picker exposes', async () => {
    // Includes cosyvoice3: a missing SPELL_DEFAULT entry would kill argparse here.
    for (const engine of ['kokoro', 'cosyvoice', 'cosyvoice3', 'indextts']) {
        const result = await prepareSegments('你好。', { engine });
        assert.equal(result.degraded, false, `${engine} raised in the segmenter`);
        assert.deepEqual(result.segments, ['你好。'], `${engine} produced no segment`);
    }
});

test('empty text never spawns a process and yields no segments', async () => {
    let spawned = false;
    const result = await prepareSegments('   \n ', {
        engine: 'kokoro',
        exec: () => { spawned = true; throw new Error('must not run'); },
    });
    assert.deepEqual(result.segments, []);
    assert.equal(spawned, false);
});

test('a missing normalizer degrades to a usable split instead of failing the read-aloud', async () => {
    const result = await prepareSegments('第一句。第二句。', {
        engine: 'kokoro',
        textnormPath: '/nonexistent/textnorm.py',
    });
    assert.equal(result.degraded, true);
    assert.deepEqual(result.segments, ['第一句。', '第二句。']);
    // Raw text survives, because the worker still normalizes before synthesis.
    assert.equal(result.normalized, '第一句。第二句。');
});

test('fallbackSegments splits on sentence ends and caps very long pieces', () => {
    assert.deepEqual(fallbackSegments('甲。乙！\n丙？'), ['甲。', '乙！', '丙？']);
    const long = fallbackSegments('一'.repeat(200), 90);
    assert.equal(long.length, 3);
    assert.equal(long.join(''), '一'.repeat(200));
});

test('manager.segments uses the injected seam and never loads an engine', async () => {
    const events = [];
    const seen = [];
    const mgr = new TtsManager(
        { ttsRoot: '/t', modelsRoot: '/m', engine: 'kokoro' },
        () => {},
        {
            createProc: () => { events.push('spawn'); throw new Error('must not spawn'); },
            exists: () => true,
            queryVram: async () => 5000,
            segment: async (text, options) => {
                seen.push({ text, options });
                return { engine: options.engine, spell: false, normalized: text, segments: ['甲。', '乙。'], degraded: false };
            },
        },
    );
    const result = await mgr.segments('甲。乙。');
    assert.deepEqual(result.segments, ['甲。', '乙。']);
    assert.deepEqual(result.desired, 'kokoro');
    // 关键:切句不碰 GPU,所以模型仍然是未加载状态。
    assert.deepEqual(events, []);
    assert.equal(mgr.current, null);
    assert.equal(seen[0].options.engine, 'kokoro');
});

test('a Latin reply keeps its digits even for the engines that pre-expand them', async () => {
    // textnorm.py used to spell digits as Chinese unconditionally, so an English
    // reply read through CosyVoice came out with Han characters in it: measured
    // on the old code, English "3.5%" became 百分之三点五 and German "3,5" became
    // 三十五 (thirty-five, the wrong value). This is the plugin-side lock on that
    // fix -- the rule itself lives in .runtime/tts/tools/textnorm.py, which is NOT
    // in this package, so without this test a revert there would pass the suite.
    const english = 'Growth was 3.5% in 2026. The price is 3.5 dollars.';
    for (const engine of ['cosyvoice', 'cosyvoice3']) {
        const result = await prepareSegments(english, { engine });
        assert.equal(result.normalized, english, `${engine} must not rewrite Latin digits`);
        assert.ok(!/[\u4e00-\u9fff]/.test(result.normalized), `${engine} injected Han characters`);
    }
});

test('a Chinese reply is still spelled while its English sentence is left alone', async () => {
    const reply = '价格是 3.5%。The price is 3.5 dollars in 2026.';
    const result = await prepareSegments(reply, { engine: 'cosyvoice' });
    assert.ok(result.normalized.includes('百分之三点五'), 'Chinese sentence must be spelled');
    assert.ok(result.normalized.includes('The price is 3.5 dollars in 2026.'),
        'the English sentence must survive untouched');
});

test('manager.segments follows the currently selected engine spelling', async () => {
    const mgr = new TtsManager(
        { ttsRoot: '/t', modelsRoot: '/m', engine: 'kokoro' },
        () => {},
        {
            createProc: () => { throw new Error('unused'); },
            exists: () => true,
            queryVram: async () => 5000,
            segment: async (text, options) => ({ engine: options.engine, spell: options.engine === 'indextts', normalized: text, segments: [text], degraded: false }),
        },
    );
    await mgr.select('indextts');
    const result = await mgr.segments('2026年');
    assert.equal(result.desired, 'indextts');
    assert.equal(result.spell, true);
    // select() 只是登记了意图;切句不该把 indextts 真的加载进来。
    assert.equal(mgr.current, null);
});
