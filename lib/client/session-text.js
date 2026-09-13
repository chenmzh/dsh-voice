/**
 * 从会话事件里取"助手回复的原文"。
 *
 * 为什么走 ctx.sessions 而不是 ctx.uiConversation:uiConversation 是渲染层服务,
 * 只在这条会话被渲染时才存在;而 `sessions` 是本插件已经注入并验证可用的服务
 * (麦克风那条路径就在用它)。朗读只需要文本,不需要任何视图节点,所以少依赖
 * 一层更安全。
 *
 * 拿到的文本是 **Markdown 原文**,不是 HTML:剥 Markdown 由宿主的 textnorm 做
 * (那边有 52 个测试的规则),客户端不必也不该自己实现一遍。
 */

/** 把一条 assistant 消息的文本块拼起来。 */
export function textFromMessage(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n');
}

/** 事件窗口里的条目可能是事件本身,也可能包一层 { event }。 */
function eventOf(entry) {
    return entry?.event ?? entry;
}

export function createSessionReader(sessions) {
    return {
        /**
         * 取某条已定稿回复的文本。
         * 找不到就返回空串(调用方据此提示"这条回复没有可朗读的文本")。
         */
        assistantText(sessionId, messageId) {
            if (!sessionId || !messageId)
                return '';
            const binding = sessions?.binding?.(sessionId);
            if (!binding)
                return '';
            let entries;
            try {
                entries = binding.eventSource.getSnapshot()?.entries ?? [];
            }
            catch {
                return '';
            }
            // 从后往前找:最近的消息更可能被点,而且历史很长时能少扫一段。
            for (let i = entries.length - 1; i >= 0; i--) {
                const event = eventOf(entries[i]);
                if (event?.type !== 'assistant/message')
                    continue;
                if (event.data?.message?.id !== messageId)
                    continue;
                return textFromMessage(event.data.message);
            }
            return '';
        },
        /**
         * 订阅"新的已定稿助手回复"。
         * 事件窗口追加或流式回复定稿时同步发布，不需要轮询。
         * @returns 取消订阅函数。
         */
        onAssistantMessage(sessionId, handler) {
            const binding = sessions?.binding?.(sessionId);
            if (!binding)
                return () => { };
            const seen = new Set();
            const remember = entries => {
                for (const entry of entries ?? []) {
                    const event = eventOf(entry);
                    if (entry?.type !== 'transient' && event?.type === 'assistant/message' && event.data?.message?.id)
                        seen.add(event.data.message.id);
                }
            };
            // Opening a session or paging/reconnecting history must not read old replies.
            try { remember(binding.eventSource.getSnapshot()?.entries); } catch { /* not loaded yet */ }
            return binding.eventSource.subscribe(() => {
                let change;
                try {
                    change = binding.eventSource.getSnapshot()?.change;
                }
                catch {
                    return;
                }
                if (change?.kind === 'replace' || change?.kind === 'prepend') {
                    remember(change.entries);
                    return;
                }
                // DSH 0.1.5 commits streamed replies through settle-assistant,
                // whose single durable entry is not an append/change.entries batch.
                const entries = change?.kind === 'settle-assistant'
                    ? (change.entry ? [change.entry] : [])
                    : change?.kind === 'append' ? change.entries ?? [] : [];
                for (const entry of entries) {
                    if (entry?.type === 'transient') continue;
                    const event = eventOf(entry);
                    if (event?.type !== 'assistant/message')
                        continue;
                    const messageId = event.data?.message?.id;
                    const text = textFromMessage(event.data?.message);
                    if (!messageId || !text.trim())
                        continue;
                    // 同一条消息可能因为重放/重连再次出现,去重避免重复朗读。
                    if (seen.has(messageId))
                        continue;
                    seen.add(messageId);
                    handler({ messageId, text });
                }
            });
        },
    };
}
