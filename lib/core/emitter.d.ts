/**
 * Emitter —— 极简类型化回调注册表(internal seam)。
 * 多份识别器(onText/onError)与 VoiceRuntime(subscribe)共用的订阅形状:
 * 消除 Set + add/delete 重复实现;不构成插件对外的 interface,仅供 core/client 内部组合。
 */
export type Listener<T extends unknown[]> = (...args: T) => void;
export declare class Emitter<T extends unknown[]> {
    private readonly listeners;
    /** 注册回调;返回退订函数(重复调用幂等)。 */
    on(cb: Listener<T>): () => void;
    /** 同步广播。 */
    emit(...args: T): void;
}
