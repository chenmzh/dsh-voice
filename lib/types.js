/**
 * dsh-voice 线协议:host 半注册 /voice RPC 通道(connection.rpc,loopback authority),
 * client 半经 connection.rpc.call('/voice', endpoint, payload) 调用。
 * 纯语音输入:ping(引擎探测)+ asr(PCM → 识别文本)。
 */
export {};
