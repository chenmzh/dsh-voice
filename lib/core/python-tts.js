/**
 * 一个常驻 TTS 子进程 = 一个已加载的引擎 = 一份显存占用。
 *
 * 设计要点(与 core/python-asr.js 同源,但多了"卸载"):
 *  - 模型只在 start() 时加载一次,之后所有 speak() 都复用同一进程,
 *    这正是朗读场景要的:换句不换模型,不再付 5~40s 的加载代价。
 *  - unload() 不是"释放引用",而是真的让进程退出 —— CUDA context 随进程
 *    一起消失,显存才真的回到驱动手里。JS 侧无法只靠丢引用回收显存。
 *  - 所有请求串行(单条 queue),避免同一进程内并发推理打爆显存。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * 组装 worker 的命令行参数。
 *
 * 只允许出现 tts_worker.py 的 argparse 真正声明过的开关:多传一个不认识的参数,
 * argparse 会直接以 code=2 退出,而错误信息只出现在 stderr 里,表现为"模型加载
 * 失败"。TTS_ROOT 因此走环境变量(worker 就是这么读的),不在这里出现。
 * tests/worker-cli.test.mjs 会把这份清单与 worker 的 add_argument 逐项对齐。
 */
export function buildWorkerArgs(spec, workerPath) {
    const args = [
        workerPath,
        '--engine', spec.id,
        '--models-root', spec.modelsRoot,
        '--voice', spec.defaultVoice ?? '',
    ];
    if (spec.modelDir)
        args.push('--model-dir', spec.modelDir);
    return args;
}

/** 常驻 TTS 子进程。 */
export class PythonTts {
    /** @param spec - resolveEngineSpec() 的结果。deps 是测试用的进程/定时器接缝。 */
    constructor(spec, log = () => {}, deps = {}) {
        this.spec = spec;
        this.log = log;
        this.spawn = deps.spawn ?? spawn;
        this.setTimeout = deps.setTimeout ?? setTimeout;
        this.clearTimeout = deps.clearTimeout ?? clearTimeout;
        // 允许测试换成桩 worker:这样不必起真引擎也能验证整条 JSON 行协议。
        this.workerPath = deps.workerPath ?? fileURLToPath(new URL('../../python/tts_worker.py', import.meta.url));
        this.loadTimeoutMs = deps.loadTimeoutMs ?? 300000;
        this.speakTimeoutMs = deps.speakTimeoutMs ?? 300000;
        this.killTimeoutMs = deps.killTimeoutMs ?? 3000;
        this.worker = null;
        this.startPromise = null;
        this.disposed = false;
        this.pending = new Map();
        this.nextId = 0;
        this.queue = Promise.resolve();
        this.info = undefined;
    }
    get engine() {
        return this.spec.id;
    }
    alive() {
        const child = this.worker?.child;
        return Boolean(child) && !this.worker.exited && child.exitCode === null && child.signalCode == null;
    }
    /** 是否已经加载完成(可接受 speak)。 */
    get ready() {
        return Boolean(this.worker?.ready) && this.alive();
    }
    /** 优雅停:先关 stdin 让子进程自己退,再超时升级到 SIGKILL。 */
    stop(worker, { graceful = false } = {}) {
        if (!worker || worker.stopping || !this.isAlive(worker))
            return;
        worker.stopping = true;
        worker.killTimer = this.setTimeout(() => {
            worker.killTimer = null;
            if (this.isAlive(worker)) {
                try {
                    worker.child.kill('SIGKILL');
                }
                catch (error) {
                    this.log(String(error));
                }
            }
        }, graceful ? this.killTimeoutMs : 0);
        worker.killTimer?.unref?.();
        try {
            worker.child.stdin.end();
        }
        catch (error) {
            this.log(String(error));
        }
        try {
            worker.child.kill('SIGTERM');
        }
        catch (error) {
            this.log(String(error));
        }
    }
    isAlive(worker) {
        return Boolean(worker?.child) && !worker.exited && worker.child.exitCode === null && worker.child.signalCode == null;
    }
    fail(worker, reason, stop = true) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        if (!worker.failed) {
            worker.failed = true;
            this.clearTimeout(worker.loadTimer);
            worker.reader?.close();
            if (!worker.ready)
                worker.reject(error);
            if (this.worker === worker) {
                this.worker = null;
                this.startPromise = null;
                this.info = undefined;
            }
            for (const [id, call] of this.pending) {
                if (call.worker !== worker)
                    continue;
                this.pending.delete(id);
                call.reject(error);
            }
            this.log(`TTS[${this.spec.id}] ${error.message}`);
        }
        if (stop)
            this.stop(worker);
        if (!worker.child)
            ; // 保留:worker 仍被 workers 持有以便退出后清理
    }
    /** 拉起子进程并等待 ready 握手。重复调用共享同一个在途 Promise。 */
    start() {
        if (this.disposed)
            return Promise.reject(new Error('TTS 进程已关闭'));
        if (this.worker) {
            if (!this.worker.failed && this.isAlive(this.worker) && !this.worker.child.killed)
                return this.startPromise;
            this.fail(this.worker, new Error('TTS 进程不可用'));
        }
        const worker = { child: null, ready: false, failed: false, exited: false, stopping: false };
        const promise = new Promise((resolve, reject) => {
            worker.resolve = resolve;
            worker.reject = reject;
        });
        this.worker = worker;
        this.startPromise = promise;
        try {
            const args = buildWorkerArgs(this.spec, this.workerPath);
            const child = this.spawn(this.spec.python, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                // TTS_ROOT 必须走环境:命令行没有这个开关,传 --tts-root 会让
                // argparse 直接退出。spec.env 放后面,允许单个引擎覆盖。
                env: {
                    ...process.env,
                    TTS_ROOT: this.spec.ttsRoot,
                    ...this.spec.env,
                    PYTHONUNBUFFERED: '1',
                },
            });
            worker.child = child;
            worker.loadTimer = this.setTimeout(() => this.fail(worker, new Error('TTS 模型加载超时')), this.loadTimeoutMs);
            for (const ev of ['error'])
                child.on(ev, error => this.fail(worker, error));
            for (const stream of ['stdin', 'stdout', 'stderr'])
                child[stream]?.on('error', error => this.fail(worker, error));
            const exited = (code, signal) => {
                if (worker.exited)
                    return;
                worker.exited = true;
                this.clearTimeout(worker.killTimer);
                const error = new Error(`TTS 进程退出 (code=${code}, signal=${signal ?? 'none'})`);
                if (worker.failed)
                    this.log(error.message);
                this.fail(worker, error, false);
            };
            child.on('exit', exited);
            child.on('close', exited);
            child.stderr.on('data', data => this.log(`TTS[${this.spec.id}] ${data.toString().trim().slice(-2000)}`));
            worker.reader = createInterface({ input: child.stdout });
            worker.reader.on('line', line => {
                if (worker.failed || this.worker !== worker || this.disposed)
                    return;
                let msg;
                try {
                    msg = JSON.parse(line);
                }
                catch {
                    this.log(line.slice(0, 500));
                    return;
                }
                if (msg === null || typeof msg !== 'object') {
                    this.log(line.slice(0, 500));
                    return;
                }
                if ('ready' in msg) {
                    if (!msg.ready) {
                        this.fail(worker, new Error(msg.error || 'TTS 模型加载失败'));
                        return;
                    }
                    if (!worker.ready && this.isAlive(worker) && !child.killed) {
                        worker.ready = true;
                        this.clearTimeout(worker.loadTimer);
                        this.info = msg;
                        worker.resolve(this);
                    }
                    return;
                }
                const call = this.pending.get(msg.id);
                if (!call || call.worker !== worker)
                    return;
                this.pending.delete(msg.id);
                if (msg.error)
                    call.reject(new Error(msg.error));
                else
                    call.resolve(msg);
            });
        }
        catch (error) {
            this.fail(worker, error);
        }
        return promise;
    }
    /** 发一条请求并等回包。串行执行,保证同一进程内不会并发推理。 */
    request(payload, timeoutMs = this.speakTimeoutMs) {
        const run = this.queue.then(async () => {
            await this.start();
            const worker = this.worker;
            if (this.disposed || !worker?.ready || worker.failed || !this.isAlive(worker) || worker.child.killed)
                throw new Error('TTS 进程不可用');
            return new Promise((resolve, reject) => {
                const id = ++this.nextId;
                const timer = this.setTimeout(() => this.fail(worker, new Error('TTS 请求超时')), timeoutMs);
                this.pending.set(id, {
                    worker,
                    resolve: msg => {
                        this.clearTimeout(timer);
                        resolve(msg);
                    },
                    reject: err => {
                        this.clearTimeout(timer);
                        reject(err);
                    },
                });
                try {
                    worker.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, err => {
                        if (err)
                            this.fail(worker, err);
                    });
                }
                catch (error) {
                    this.fail(worker, error);
                }
            });
        });
        this.queue = run.catch(() => { });
        return run;
    }
    /**
     * 合成一段文本。
     * @returns wav 是 Buffer(WAV 字节),已从 base64 解回。
     */
    async speak(payload) {
        const msg = await this.request(payload);
        if (msg.skipped)
            return { wav: null, skipped: msg.skipped, audioSeconds: 0, sampleRate: msg.sampleRate ?? 0, voice: msg.voice ?? '' };
        return {
            wav: msg.wav ? Buffer.from(msg.wav, 'base64') : null,
            sampleRate: msg.sampleRate,
            audioSeconds: msg.audioSeconds,
            synthSeconds: msg.synthSeconds,
            voice: msg.voice ?? '',
        };
    }
    async voices() {
        const msg = await this.request({ cmd: 'voices' }, 30000);
        return { voices: msg.voices ?? [], voice: msg.voice ?? '' };
    }
    async setVoice(voice) {
        const msg = await this.request({ cmd: 'setVoice', voice }, 60000);
        // worker 的 setVoice 只回 voice、不回 voices(tts_worker.py 的 emit)。
        // 这里**绝不能**再用 `?? []` 兜底:[] 不是 nullish,管理器的
        // `info.voices ?? this.voices` 会因此被真的清空,下一次 status 轮询就把
        // 用户刚配好的音色打回占位 —— 实测就是这个把 人声配置 打没的。
        // 缺列表就回 undefined,让调用方自己决定"没带列表"该怎么办。
        return { voices: msg.voices, voice: msg.voice ?? '' };
    }
    async stats() {
        return this.request({ cmd: 'stats' }, 30000);
    }
    /**
     * 卸载:让子进程释放模型并退出,等它真的退出后再返回。
     * 显存回收发生在进程退出那一刻,所以必须等到 exit —— 否则用户立刻切到
     * 另一个引擎时会两个模型的显存叠加,直接 OOM。
     */
    async unload() {
        const worker = this.worker;
        if (!worker) {
            this.startPromise = null;
            this.info = undefined;
            return;
        }
        const exited = new Promise(resolve => {
            if (worker.exited || !this.isAlive(worker)) {
                resolve();
                return;
            }
            const done = () => resolve();
            worker.child.once('exit', done);
            worker.child.once('close', done);
            // 兜底:无论如何都要解开,避免 unload 永久挂住。
            const t = this.setTimeout(done, this.killTimeoutMs + 5000);
            t?.unref?.();
        });
        try {
            // 协作式:给子进程一个自己释放 CUDA 的机会。
            await Promise.race([
                this.request({ cmd: 'unload' }, this.killTimeoutMs).catch(() => undefined),
                exited,
            ]);
        }
        catch { /* 进程已退,忽略 */ }
        this.stop(worker, { graceful: true });
        await exited;
        if (this.worker === worker) {
            this.worker = null;
            this.startPromise = null;
            this.info = undefined;
        }
        worker.reader?.close();
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const [, call] of this.pending)
            call.reject(new Error('TTS 进程已关闭'));
        this.pending.clear();
        if (this.worker)
            this.stop(this.worker, { graceful: false });
    }
}
