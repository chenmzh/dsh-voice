import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TEXTNORM } from '../lib/core/text-prep.js';

test('text preparation is bundled and runtime roots respect the installation environment', () => {
  assert.equal(DEFAULT_TEXTNORM, fileURLToPath(new URL('../python/textnorm.py', import.meta.url)));
  const module = new URL('../lib/core/runtime-paths.js', import.meta.url).href;
  const env = { ...process.env, DSH_HOME: '/example/dsh', DSH_VOICE_HOME: '', DSH_VOICE_TTS_ROOT: '', DSH_VOICE_MODELS_ROOT: '' };
  const source = `import {DEFAULT_TTS_ROOT, DEFAULT_MODELS_ROOT} from ${JSON.stringify(module)}; console.log(JSON.stringify([DEFAULT_TTS_ROOT,DEFAULT_MODELS_ROOT]));`;
  const run = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8' }));
  assert.deepEqual(run(), ['/example/dsh/voice/tts', '/example/dsh/voice/models/tts']);
  env.DSH_VOICE_HOME = '/example/voice';
  assert.deepEqual(run(), ['/example/voice/tts', '/example/voice/models/tts']);
});

test('privacy checker rejects recordings, credentials and unexpected files before publication', t => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-privacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'tools'));
  copyFileSync(new URL('../tools/check-privacy.mjs', import.meta.url), join(dir, 'tools/check-privacy.mjs'));
  const check = () => spawnSync(process.execPath, [join(dir, 'tools/check-privacy.mjs')], { encoding: 'utf8' });
  assert.equal(check().status, 0);
  for (const [name, contents] of [['personal.wav', Buffer.alloc(8)], ['.env', 'EXAMPLE=private'], ['README.md', 'ghp_' + 'x'.repeat(40)]]) {
    writeFileSync(join(dir, name), contents);
    assert.equal(check().status, 1, name);
    rmSync(join(dir, name));
  }
  assert.equal(check().status, 0);
});
