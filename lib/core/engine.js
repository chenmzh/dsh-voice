/** 配置引擎 + 原生能力 → 生效引擎(纯函数,两侧唯一决策点)。 */
export function resolveEngine(configured, capable) {
    if (configured === 'browser')
        return 'browser';
    if (configured === 'native')
        return 'native';
    return capable ? 'native' : 'browser';
}
/**
 * 懒加载 + 单飞 + 失败锁存:加载只触发一次,后续 ready() 复用已落定结果。
 * 加载函数约定返回资源或 null;抛错视为 null(锁存 failed)。
 */
export function createCapability(load) {
    let state = 'idle';
    let promise = null;
    const loadOnce = () => {
        if (promise === null) {
            state = 'loading';
            promise = Promise.resolve().then(load).then((res) => {
                state = res === null ? 'failed' : 'ready';
                return res;
            }, () => {
                state = 'failed';
                return null;
            });
        }
        return promise;
    };
    return {
        ready: () => promise ?? loadOnce(),
        kick: () => {
            void loadOnce();
        },
        state: () => state,
    };
}
