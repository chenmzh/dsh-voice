import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { rpcError } from './wire.js';

/** One persistent, private subprocess per configured backend. No HTTP server. */
export class PythonAsr {
    /** Optional process/timer seam keeps lifecycle tests independent of Python and GPUs. */
    constructor(config, log = () => {}, deps = {}) {
        this.config = config;
        this.log = log;
        this.spawn = deps.spawn ?? spawn;
        this.setTimeout = deps.setTimeout ?? setTimeout;
        this.clearTimeout = deps.clearTimeout ?? clearTimeout;
        this.loadTimeoutMs = deps.loadTimeoutMs ?? 180000;
        this.transcribeTimeoutMs = deps.transcribeTimeoutMs ?? 120000;
        this.killTimeoutMs = deps.killTimeoutMs ?? 2000;
        this.child = null;
        this.startPromise = null;
        this.worker = null;
        this.workers = new Set();
        this.disposed = false;
        this.pending = new Map();
        this.sessions = new Map();
        this.nextId = 0;
        this.queue = Promise.resolve();
    }
    alive(worker) {
        return worker?.child && !worker.exited && worker.child.exitCode === null && worker.child.signalCode == null;
    }
    stop(worker) {
        if (worker.stopping || !this.alive(worker)) return;
        worker.stopping = true;
        // Retain a generation-local escalation even after a replacement starts.
        worker.killTimer = this.setTimeout(() => {
            worker.killTimer = null;
            if (this.alive(worker)) {
                try { worker.child.kill('SIGKILL'); } catch (error) { this.log(String(error)); }
            }
        }, this.killTimeoutMs);
        worker.killTimer?.unref?.();
        try { worker.child.stdin.end(); } catch (error) { this.log(String(error)); }
        try { worker.child.kill('SIGTERM'); } catch (error) { this.log(String(error)); }
    }
    fail(worker, reason, stop = true) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        if (!worker.failed) {
            worker.failed = true;
            this.clearTimeout(worker.loadTimer);
            worker.reader?.close();
            if (!worker.ready) worker.reject(error);
            if (this.worker === worker) {
                this.worker = null;
                this.child = null;
                this.startPromise = null;
                this.info = undefined;
                // PCM recordings live in the host, not this worker generation.
                // Preserve them through idle crashes/retries; dispose alone clears all.
            }
            for (const [id, call] of this.pending) {
                if (call.worker !== worker) continue;
                this.pending.delete(id);
                call.reject(error);
            }
            this.log(error.message);
        }
        if (stop) this.stop(worker);
        if (!worker.child) this.workers.delete(worker);
    }
    start() {
        if (this.disposed) return Promise.reject(new Error('ASR worker disposed'));
        if (this.worker) {
            if (!this.worker.failed && this.alive(this.worker) && !this.worker.child.killed)
                return this.startPromise;
            this.fail(this.worker, new Error('ASR worker unavailable'));
        }
        const worker = { child: null, ready: false, failed: false, exited: false, stopping: false };
        const promise = new Promise((resolve, reject) => { worker.resolve = resolve; worker.reject = reject; });
        // Publish before spawning: a synchronous spawn failure must also clear the flight.
        this.worker = worker;
        this.workers.add(worker);
        this.startPromise = promise;
        try {
            const child = this.spawn(this.config.pythonExecutable, [
                fileURLToPath(new URL('../../python/worker.py', import.meta.url)),
                '--backend', this.config.nativeBackend,
                '--model', this.config[this.config.nativeBackend + 'ModelDir'] || this.config.pythonModelDir,
                '--device', this.config.asrDevice,
            ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
            worker.child = child;
            this.child = child;
            worker.loadTimer = this.setTimeout(() => this.fail(worker, new Error('ASR model load timed out')), this.loadTimeoutMs);
            child.on('error', error => this.fail(worker, error));
            child.stdin.on('error', error => this.fail(worker, error));
            child.stdout.on('error', error => this.fail(worker, error));
            child.stderr.on('error', error => this.fail(worker, error));
            const exited = (code, signal) => {
                if (worker.exited) return;
                worker.exited = true;
                this.clearTimeout(worker.killTimer);
                this.workers.delete(worker);
                const error = new Error(`ASR worker exited (code=${code}, signal=${signal ?? 'none'})`);
                // Preserve the primary load error while still recording exit diagnostics.
                if (worker.failed) this.log(error.message);
                this.fail(worker, error, false);
            };
            child.on('exit', exited);
            // Failed spawns can emit error + close without ever emitting exit.
            child.on('close', exited);
            child.stderr.on('data', data => this.log(data.toString().trim().slice(-2000)));
            worker.reader = createInterface({ input: child.stdout });
            worker.reader.on('line', line => {
                if (worker.failed || this.worker !== worker || this.disposed) return;
                let msg;
                try { msg = JSON.parse(line); } catch { this.log(line.slice(0, 500)); return; }
                if (msg === null || typeof msg !== 'object') { this.log(line.slice(0, 500)); return; }
                if ('ready' in msg) {
                    if (!msg.ready) { this.fail(worker, new Error(msg.error || 'ASR model failed to load')); return; }
                    if (!worker.ready && this.alive(worker) && !child.killed) {
                        worker.ready = true;
                        this.clearTimeout(worker.loadTimer);
                        this.info = msg;
                        worker.resolve(this);
                    }
                    return;
                }
                const call = this.pending.get(msg.id);
                if (!call || call.worker !== worker) return;
                this.pending.delete(msg.id);
                if (msg.error) call.reject(new Error(msg.error));
                else call.resolve(msg);
            });
        } catch (error) { this.fail(worker, error); }
        return promise;
    }
    /**
     * @param audio - 16k 单声道 16bit PCM
     * @param options - { language } 该后端认的语言参数(host 已按 backend 翻译);
     *   缺省 / null / '' 表示自动检测。逐请求传,因为用户可能在录音之间就改了设置。
     */
    transcribe(audio, options = {}) {
        const language = typeof options.language === 'string' && options.language ? options.language : null;
        const run = this.queue.then(async () => {
            await this.start();
            const worker = this.worker;
            if (this.disposed || !worker?.ready || worker.failed || !this.alive(worker) || worker.child.killed)
                throw new Error('ASR worker unavailable');
            return new Promise((resolve, reject) => {
                const id = ++this.nextId;
                const timer = this.setTimeout(() => {
                    this.fail(worker, new Error('ASR transcription timed out'));
                }, this.transcribeTimeoutMs);
                this.pending.set(id, {
                    worker,
                    resolve: msg => { this.clearTimeout(timer); resolve(msg); },
                    reject: err => { this.clearTimeout(timer); reject(err); },
                });
                const request = { id, audio: audio.toString('base64') };
                // 只在真的指定了语言时才带这个字段:worker 把"缺字段"和"空串"
                // 都当自动检测,少发一个字段让"没配语言"和"配了 auto"走同一条路径。
                if (language !== null) request.language = language;
                try {
                    worker.child.stdin.write(JSON.stringify(request)+'\n', err => {
                        if (err) this.fail(worker, err);
                    });
                } catch (error) { this.fail(worker, error); }
            });
        });
        this.queue = run.catch(() => {});
        return run;
    }
    async handle(req) {
        if (this.disposed) return rpcError('internal', 'ASR worker disposed');
        if (typeof req?.sessionId !== 'string' || typeof req.audio !== 'string' || typeof req.final !== 'boolean')
            return rpcError('invalid_audio', 'Invalid audio request');
        const now = Date.now();
        for (const [key, session] of this.sessions) if (now-session.updated > 180000) this.sessions.delete(key);
        if (!this.sessions.has(req.sessionId)) {
            if (this.sessions.size >= 4) return rpcError('busy', 'Too many voice sessions');
            this.sessions.set(req.sessionId, { chunks: [], bytes: 0, updated: now, failed: false });
        }
        const session = this.sessions.get(req.sessionId);
        const audio = Buffer.from(req.audio, 'base64');
        session.updated = now;
        // 语言跟着会话走:客户端分块送音频,最后一块才真正转写,所以取
        // 最近一次带过来的值(用户在录音期间改了语言,以最后一块为准)。
        if (typeof req.language === 'string') session.language = req.language;
        if (audio.length % 2 || session.bytes + audio.length > 16000*2*120) session.failed = true;
        if (!session.failed) { session.chunks.push(audio); session.bytes += audio.length; }
        if (!req.final) return { ok: true, value: { delta: '', final: false } };
        this.sessions.delete(req.sessionId);
        if (session.failed) return rpcError('invalid_audio', '录音过长或格式无效；请每次录音不超过 120 秒');
        if (session.bytes === 0) return { ok: true, value: { delta: '', final: true } };
        try {
            const result = await this.transcribe(Buffer.concat(session.chunks), { language: session.language });
            return { ok: true, value: { delta: result.text, final: true } };
        } catch (err) { return rpcError('internal', String(err)); }
    }
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.sessions.clear();
        // Only private workers: include retiring generations until their exit/close.
        for (const worker of this.workers) this.fail(worker, new Error('ASR worker disposed'));
    }
}
