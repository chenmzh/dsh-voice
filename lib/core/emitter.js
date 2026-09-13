export class Emitter {
    listeners = new Set();
    /** 注册回调;返回退订函数(重复调用幂等)。 */
    on(cb) {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    }
    /** 同步广播。 */
    emit(...args) {
        for (const cb of this.listeners)
            cb(...args);
    }
}
