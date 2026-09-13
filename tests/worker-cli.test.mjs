/**
 * 把宿主传给 worker 的命令行参数,与 tts_worker.py 真正声明过的开关对齐。
 *
 * 这条测试是踩坑换来的:python-tts.js 曾经传 `--tts-root`,而 worker 的
 * argparse 没有这个开关 —— argparse 以 code=2 退出,错误只出现在 stderr,
 * 用户看到的是"模型加载失败",看不出是参数名写错。TTS_ROOT 现在走环境变量。
 *
 * 纯静态比对(不启动 python):worker 的 re-exec 会先动 LD_LIBRARY_PATH,
 * 用系统 python3 起不来,而这里要保证的只是"参数名两边一致"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkerArgs } from '../lib/core/python-tts.js';
import { resolveEngineSpec, TTS_ENGINE_ORDER } from '../lib/core/tts-engines.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, '..', 'python', 'tts_worker.py');
const CLI = path.join(here, '..', 'lib', 'core', 'python-tts.js');

/** worker 的 argparse 声明了哪些 --flag。 */
function workerFlags() {
    const source = readFileSync(WORKER, 'utf8');
    const flags = new Set();
    for (const match of source.matchAll(/add_argument\(\s*'([^']+)'/g)) {
        if (match[1].startsWith('--'))
            flags.add(match[1]);
    }
    return flags;
}

/** worker 的 --engine choices。 */
function workerEngines() {
    const source = readFileSync(WORKER, 'utf8');
    const match = source.match(/add_argument\(\s*'--engine'[^)]*?choices=\[([^\]]+)\]/s);
    assert.ok(match, 'worker 的 --engine 应该声明 choices');
    return match[1].split(',').map(part => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/** 宿主实际会传的参数名。 */
function hostFlags() {
    const spec = resolveEngineSpec('indextts', { ttsRoot: '/T', modelsRoot: '/M' });
    const args = buildWorkerArgs(spec, '/W/tts_worker.py');
    return args.filter(arg => typeof arg === 'string' && arg.startsWith('--'));
}

test('every flag the host passes is declared by the worker argparse', () => {
    const declared = workerFlags();
    const passed = hostFlags();
    assert.ok(passed.length > 0, '宿主应该至少传一些参数');
    for (const flag of passed) {
        assert.ok(declared.has(flag), `宿主传了 worker 不认识的参数 ${flag};worker 支持: ${[...declared].sort().join(' ')}`);
    }
});

test('the host no longer passes --tts-root on the command line', () => {
    // 这是真实发生过的故障:argparse 以 code=2 退出,只留下 stderr。
    assert.ok(!hostFlags().includes('--tts-root'), 'TTS_ROOT 必须走环境变量,不能当参数传');
    const source = readFileSync(CLI, 'utf8');
    assert.match(source, /TTS_ROOT:\s*this\.spec\.ttsRoot/, 'TTS_ROOT 应该通过子进程环境传入');
});

test('the worker accepts every engine id the host can launch', () => {
    const accepted = new Set(workerEngines());
    for (const engine of TTS_ENGINE_ORDER) {
        assert.ok(accepted.has(engine), `worker 的 --engine 不接受 ${engine}(界面上会列出来,点了就加载失败)`);
    }
    // 反向:worker 不该有宿主不会用的引擎,否则说明两边表漂了。
    for (const engine of accepted) {
        assert.ok(TTS_ENGINE_ORDER.includes(engine), `worker 支持 ${engine},但宿主注册表里没有`);
    }
});

test('the host passes --model-dir only for engines that declare one', () => {
    const withDir = buildWorkerArgs(resolveEngineSpec('indextts', { ttsRoot: '/T', modelsRoot: '/M' }), '/W');
    const withoutDir = buildWorkerArgs(resolveEngineSpec('kokoro', { ttsRoot: '/T', modelsRoot: '/M' }), '/W');
    assert.ok(withDir.includes('--model-dir'));
    assert.ok(withoutDir.includes('--model-dir') === false, '没有 modelDir 的引擎不该收到 --model-dir');
});

test('the worker exposes the prepare command the read-aloud path wants', () => {
    const source = readFileSync(WORKER, 'utf8');
    assert.match(source, /cmd\s*==\s*'prepare'/, 'worker 应该提供 prepare 命令(切句,不碰 GPU)');
    assert.match(source, /segment_text/, 'prepare 应该复用 textnorm.segment_text,而不是自己再实现一套切句');
});
