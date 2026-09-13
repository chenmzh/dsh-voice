import { rpcError } from './wire.js';
/** 会话池容量默认值(防 VAD 状态无界累积;无配置面,不进 DEFAULTS)。 */
const DEFAULT_MAX_SESSIONS = 4;
export class HostAsr {
    sessions = new Map();
    maxSessions;
    log;
    /** 单调时钟:lastUsed 用计数而非墙钟,LRU 顺序确定可测 */
    tick = 0;
    constructor(options = {}) {
        this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
        this.log = options.log;
    }
    /** 处理一块 asr payload:解码 → 会话池取会话 → feed → 线协议结果。 */
    handle(model, req) {
        const session = this.sessionFor(model, req.sessionId);
        if (session === null) {
            return rpcError('native_unavailable', 'native ASR 不可用');
        }
        const chunk = Buffer.from(req.audio, 'base64');
        const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));
        try {
            const out = session.feed(int16, req.final);
            // 定稿优先;否则回传当前部分识别文本(边说边出字)
            const delta = out.finals.length > 0 ? out.finals.join('') : out.partial;
            return { ok: true, value: { delta, final: out.finals.length > 0 } };
        }
        catch (err) {
            // 单次 feed 失败不报废整个识别服务(按块错误)
            this.log?.(`feed 失败: ${String(err)}`);
            return rpcError('internal', String(err));
        }
    }
    /** 按 sessionId 取独立识别会话(LRU 淘汰最久未用的)。 */
    sessionFor(model, sessionId) {
        const hit = this.sessions.get(sessionId);
        if (hit !== undefined) {
            hit.lastUsed = ++this.tick;
            return hit.session;
        }
        const session = model.openSession();
        if (session === null)
            return null;
        while (this.sessions.size >= this.maxSessions) {
            let oldestKey = null;
            let oldestTime = Infinity;
            for (const [key, value] of this.sessions) {
                if (value.lastUsed < oldestTime) {
                    oldestTime = value.lastUsed;
                    oldestKey = key;
                }
            }
            if (oldestKey === null)
                break;
            this.sessions.delete(oldestKey);
            this.log?.(`会话 ${oldestKey} 被 LRU 驱逐(满 ${this.maxSessions})`);
        }
        this.sessions.set(sessionId, { session, lastUsed: ++this.tick });
        return session;
    }
}
