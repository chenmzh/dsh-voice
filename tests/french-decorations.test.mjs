import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSegments, fallbackSegments, cleanSpeechDecorations } from '../lib/core/text-prep.js';
import { TtsController } from '../lib/client/tts-store.js';
const words = text => text.match(/[\p{L}\p{M}\p{N}]+(?:[’'‐‑-][\p{L}\p{M}\p{N}]+)*/gu) ?? [];

const plain = 'Bonjour ! Aujourd’hui, l’élève prépare un café à Noël. Ça coûte 3,50 euros. Est-ce que vous êtes prêt ? Très bien, continuons jusqu’à la dernière phrase.';
const decorated = '**Bonjour** ! 😊\nAujourd’hui, **l’élève** prépare un *café* à Noël. 👩🏽‍💻\nÇa coûte **3,50 euros**. 🇫🇷\n✨⭐✨\nEst-ce que vous êtes prêt ? **Très bien**, continuons jusqu’à la **dernière phrase**. 🎉';

test('French bold/italic, emoji and symbol rows preserve every word through the final sentence', async () => {
    const prepared = await prepareSegments(decorated, { engine: 'cosyvoice3' });
    assert.equal(prepared.degraded, false);
    assert.deepEqual(words(prepared.normalized), words(plain));
    assert.deepEqual(words(prepared.segments.join(' ')), words(plain));
    assert.ok(!/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200D\uFE0F]/u.test(prepared.normalized));
    assert.ok(!prepared.normalized.includes('*'));
    assert.ok(prepared.segments.at(-1).includes('dernière phrase'));
});

test('selected French text retains accents, apostrophes and meaningful punctuation', async () => {
    const raw = '« L’été à Noël » : cœur, œuf, où, français, l’e\u0301le\u0300ve — 3,50 € + 2 = 5. 😊';
    const prepared = await prepareSegments(raw, { engine: 'cosyvoice3', markdown: false });
    assert.deepEqual(words(prepared.segments.join(' ')), words(raw));
    for (const symbol of ['«', '»', '€', '+', '=']) assert.ok(prepared.normalized.includes(symbol), symbol);
    assert.equal(cleanSpeechDecorations('🎉\n🇫🇷👩🏽‍💻✨'), '');
});

test('fallback segmentation does not split French words, accents, or apostrophes', () => {
    const raw = 'Bonjour à tous, l’élève prépare tranquillement son café pour aujourd’hui. '.repeat(8) + 'anticonstitutionnellement';
    const segments = fallbackSegments(raw, 24);
    assert.equal(segments.join(''), raw);
    assert.deepEqual(segments.flatMap(words), words(raw));
    assert.deepEqual(fallbackSegments('anticonstitutionnellement', 8), ['anticonstitutionnellement']);
});

test('French decorative-only segments cannot invoke synthesis or truncate following prose', async () => {
    const heard = [], segments = ['Bonjour à tous.', '✨ !!! 😊', 'Continuons jusqu’à la dernière phrase.'];
    const ctl = new TtsController({ sessions: {}, rpc: async (_, endpoint, payload) => {
        if (endpoint === 'speak') heard.push(payload.text);
        return { ok: true, value: endpoint === 'segments' ? { segments } : endpoint === 'speak' ? { wav: 'AAAA' } : {} };
    } });
    ctl.audio = { stop() {}, unlock() {}, enqueue() {}, dispose() {} };
    await ctl.speakText(segments.join('\n'));
    assert.deepEqual(heard, [segments[0], segments[2]]);
    assert.equal(ctl.state.note, '朗读完成'); ctl.dispose();
});


test('a short French paragraph starting with an accent cannot merge into the preceding word', async () => {
    const raw = 'Parlons de\nété';
    const prepared = await prepareSegments(raw, { engine: 'cosyvoice3' });
    assert.equal(prepared.degraded, false);
    assert.deepEqual(prepared.segments.flatMap(words), ['Parlons', 'de', 'été']);
});
