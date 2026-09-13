/**
 * 顺序播放队列:把一句话一个 WAV 依次播出来。
 *
 * 为什么要队列:回复文本会被切句后逐句合成,第一句先到就先播,后面边播边合成,
 * 用户不必等整段回复合成完(CosyVoice3 RTF 1.2,整段会等很久)。
 * 同时保证同一时刻只有一个音频在响 —— 连点两次朗读不会叠音。
 */
export class AudioQueue {
    constructor(log = () => { }) {
        this.log = log;
        this.items = [];
        this.current = null;
        this.playing = false;
        this.unlocked = false;
        this.listeners = new Set();
        /** 每次 stop() 自增:让在途的旧音频回调失效,避免"停了又自己响"。 */
        this.generation = 0;
        this.error = null;
        this.cancelCurrent = null;
    }
    subscribe(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    emit() {
        for (const cb of this.listeners)
            cb();
    }
    isSpeaking() {
        return this.playing;
    }
    /**
     * 解锁自动播放:浏览器要求用户先与页面交互过,带声音的自动播放才被允许。
     * 在第一次点击/按键时播一段静音,把这把锁打开,之后的自动朗读才不会被拦。
     */
    unlock() {
        if (this.unlocked)
            return;
        this.unlocked = true;
        try {
            const el = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=');
            el.volume = 0;
            void el.play().catch(() => { });
        }
        catch (error) {
            this.log(String(error));
        }
    }
    /** 入队一个 WAV Blob,空闲则立即开始播。 */
    enqueue(blob) {
        if (!blob)
            return;
        if (this.error) throw new Error(this.error);
        this.items.push(blob);
        this.emit();
        if (!this.playing)
            void this.drain();
    }
    async drain() {
        if (this.playing)
            return;
        const generation = this.generation;
        this.playing = true;
        this.error = null;
        this.emit();
        try {
            while (this.items.length > 0 && generation === this.generation) {
                const blob = this.items.shift();
                const url = URL.createObjectURL(blob);
                const el = new Audio(url);
                this.current = el;
                this.emit();
                try {
                    await new Promise((resolve, reject) => {
                        this.cancelCurrent = resolve;
                        el.onended = () => resolve();
                        el.onerror = () => reject(new Error('音频播放失败'));
                        void el.play().catch(reject);
                    });
                }
                finally {
                    URL.revokeObjectURL(url);
                    el.onended = null;
                    el.onerror = null;
                    if (this.current === el) {
                        this.current = null;
                        this.cancelCurrent = null;
                    }
                }
            }
        }
        catch (error) {
            if (generation !== this.generation) return;
            this.items.length = 0;
            // 最常见的原因就是自动播放被拦:把它说清楚,UI 才有机会提示用户点一下。
            this.error = error?.name === 'NotAllowedError'
                ? '浏览器拦截了自动朗读,请先点一下页面再试'
                : String(error?.message ?? error);
            this.log(`AudioQueue: ${this.error}`);
        }
        finally {
            if (generation === this.generation) {
                this.playing = false;
                this.emit();
            }
        }
    }
    /** Resolve only after the final WAV has ended; stop also releases waiters. */
    waitUntilIdle() {
        return new Promise((resolve, reject) => {
            const check = () => {
                if (this.playing) return;
                unsubscribe();
                if (this.error) reject(new Error(this.error));
                else resolve();
            };
            const unsubscribe = this.subscribe(check);
            check();
        });
    }
    /** 立即停止并清空队列(用户在朗读途中关掉朗读时用)。 */
    stop() {
        this.generation++;
        this.items.length = 0;
        const el = this.current;
        this.current = null;
        this.cancelCurrent?.();
        this.cancelCurrent = null;
        this.error = null;
        if (el) {
            try {
                el.pause();
                el.src = '';
            }
            catch (error) {
                this.log(String(error));
            }
        }
        this.playing = false;
        this.emit();
    }
    dispose() {
        this.stop();
        this.listeners.clear();
    }
}
