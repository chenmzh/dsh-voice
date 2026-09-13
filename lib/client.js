window.__ModuleLoader__.load({id:"@nn12138/dsh-voice",factory:(require)=>{var module={exports:{}};var exports=module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lib/client/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);

// lib/client/selection-reader.js
var MESSAGE = '[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="user"], [data-chat-flow-kind="steering"], [data-turn-tail]';
var EXCLUDED = 'button, input, textarea, select, [contenteditable="true"], [role="textbox"]';
function selectedPassage(doc = document) {
  const selection = doc.defaultView.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const element = (node) => node.nodeType === 1 ? node : node.parentElement;
  const start = element(range.startContainer), end = element(range.endContainer);
  const message = start?.closest(MESSAGE);
  if (!message || message !== end?.closest(MESSAGE) || !message.isConnected) return null;
  if (start.closest(EXCLUDED) || end.closest(EXCLUDED) || range.cloneContents().querySelector(EXCLUDED)) return null;
  const text = selection.toString().trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  const rects = range.getClientRects();
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
  return { text, rect, message };
}
function installSelectionReader(tts, doc = document) {
  const win = doc.defaultView;
  const button = doc.createElement("button");
  button.type = "button";
  button.dataset.dshVoiceSelection = "";
  button.hidden = true;
  button.style.cssText = "position:fixed;z-index:10000;max-width:calc(100vw - 16px);padding:7px 12px;border:1px solid var(--dsw-alias-border-l2,#777);border-radius:8px;background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:0 3px 14px #0003;font:13px/1.4 sans-serif;cursor:pointer;";
  doc.body.append(button);
  let passage = null, reading = false, disposed = false, readGeneration = 0, readText = null;
  const syncLabel = () => {
    const state = tts.getSnapshot();
    if (reading && (readGeneration !== tts.speechGeneration || !state.busy && !state.speaking)) reading = false;
    const active = reading && passage?.text === readText;
    button.textContent = active ? "停止朗读" : "朗读所选";
    button.setAttribute("aria-label", button.textContent);
    button.title = active ? "停止朗读选中的文字" : "使用当前音色朗读选中的文字";
  };
  const update = () => {
    if (disposed) return;
    const next = selectedPassage(doc);
    if (!next && doc.activeElement === button && passage?.message.isConnected) return;
    passage = next;
    button.hidden = !passage;
    if (!passage) return;
    const { rect } = passage;
    if (rect.bottom < 0 || rect.top > win.innerHeight) {
      button.hidden = true;
      return;
    }
    syncLabel();
    button.style.left = `${Math.max(8, Math.min(rect.left, win.innerWidth - button.offsetWidth - 8))}px`;
    const below = rect.bottom + 8;
    button.style.top = `${Math.max(8, below + button.offsetHeight < win.innerHeight ? below : rect.top - button.offsetHeight - 8)}px`;
  };
  const preserve = (event) => event.preventDefault();
  button.addEventListener("mousedown", preserve);
  button.addEventListener("click", () => {
    if (reading && passage?.text === readText) {
      tts.stop();
      reading = false;
      syncLabel();
      return;
    }
    if (!passage?.message.isConnected) return;
    const text = passage.text;
    reading = true;
    readText = text;
    readGeneration = tts.speechGeneration + 1;
    const generation = readGeneration;
    void tts.speakText(text, { plainText: true }).finally(() => {
      if (!disposed && generation === readGeneration) {
        reading = false;
        syncLabel();
      }
    });
    syncLabel();
  });
  const escape = (event) => {
    if (event.key !== "Escape") return;
    if (reading) tts.stop();
    button.hidden = true;
    passage = null;
  };
  const keyup = (event) => {
    if (event.key !== "Escape") update();
  };
  const unsubscribe = tts.subscribe(syncLabel);
  doc.addEventListener("selectionchange", update);
  doc.addEventListener("mouseup", update);
  doc.addEventListener("keyup", keyup);
  doc.addEventListener("keydown", escape);
  doc.addEventListener("scroll", update, true);
  win.addEventListener("resize", update);
  return () => {
    disposed = true;
    unsubscribe();
    doc.removeEventListener("selectionchange", update);
    doc.removeEventListener("mouseup", update);
    doc.removeEventListener("keyup", keyup);
    doc.removeEventListener("keydown", escape);
    doc.removeEventListener("scroll", update, true);
    win.removeEventListener("resize", update);
    button.remove();
  };
}

// lib/client/message-actions.js
var MESSAGE_ACTIONS_CSS = `
/* A completed turn tail ends with the host MessageIconActions row.
   The host otherwise hides this row when that turn is no longer the latest. */
[data-turn-tail][data-actions-reveal] > :last-child {
    opacity: 1 !important;
}
/* User and steering copy rows use the same CSS module, without a turn-tail marker.
   Match its stable class suffix rather than a build-specific hash prefix. */
:is([data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]) :is([class$="_actions"], [class*="_actions "]) {
    opacity: 1 !important;
}
`;
function installMessageActions(doc = document) {
  const style = doc.createElement("style");
  style.dataset.plugin = "@nn12138/dsh-voice";
  style.dataset.pluginCss = "@nn12138/dsh-voice/message-actions";
  style.textContent = MESSAGE_ACTIONS_CSS;
  doc.head.appendChild(style);
  return () => style.remove();
}

// lib/core/emitter.js
var Emitter = class {
  listeners = /* @__PURE__ */ new Set();
  /** 注册回调;返回退订函数(重复调用幂等)。 */
  on(cb) {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  /** 同步广播。 */
  emit(...args) {
    for (const cb of this.listeners)
      cb(...args);
  }
};

// lib/client/audio.js
var ASR_SAMPLE_RATE = 16e3;
async function capturePcm(onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: ASR_SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true }
  });
  let actx, source, processor;
  try {
    actx = new AudioContext({ sampleRate: ASR_SAMPLE_RATE });
    await actx.resume();
    const contextRate = actx.sampleRate;
    source = actx.createMediaStreamSource(stream);
    processor = actx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const resampled = contextRate === ASR_SAMPLE_RATE ? input : linearResample(input, contextRate, ASR_SAMPLE_RATE);
      onChunk(floatToInt16(resampled));
    };
    source.connect(processor);
    processor.connect(actx.destination);
    return {
      stop() {
        try {
          processor.onaudioprocess = null;
          processor.disconnect();
          source.disconnect();
          void actx.close().catch(() => {
          });
        } catch {
        }
        for (const track of stream.getTracks())
          track.stop();
      }
    };
  } catch (error) {
    processor?.disconnect();
    source?.disconnect();
    for (const track of stream.getTracks()) track.stop();
    if (actx && actx.state !== "closed") await actx.close().catch(() => {
    });
    throw error;
  }
}
function floatToInt16(input) {
  const int16 = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    int16[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return int16;
}
function linearResample(input, fromRate, toRate) {
  const ratio = toRate / fromRate;
  const outLen = Math.round(input.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}
function encodeBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// lib/client/asr.js
function createRecognizer(engine, sessionId, callAsr) {
  if (engine === "native")
    return new NativeRecognizer({ sessionId, callAsr });
  return new WebSpeechRecognizer();
}
var WebSpeechRecognizer = class {
  lang;
  finalizeTimeoutMs;
  recognition = null;
  text = new Emitter();
  errors = new Emitter();
  ends = new Emitter();
  /** 已收到定稿(final 到达即置位;停麦时无需再等) */
  finalized = false;
  /** 是否收到过任何文本(无文本时停麦无需等待) */
  gotText = false;
  /** 最近一次停止是否由用户发起(区分自然结束) */
  userStopped = false;
  stopPromise = null;
  finalWaiter = null;
  constructor(lang = "zh-CN", finalizeTimeoutMs = 500) {
    this.lang = lang;
    this.finalizeTimeoutMs = finalizeTimeoutMs;
  }
  async start() {
    const Ctor = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
    if (Ctor === void 0) {
      throw new Error("浏览器不支持 SpeechRecognition(可降级键盘输入)");
    }
    this.finalized = false;
    this.gotText = false;
    this.userStopped = false;
    this.stopPromise = null;
    this.finalWaiter = null;
    const recognition = new Ctor();
    recognition.lang = this.lang;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      if (last === void 0)
        return;
      const transcript = last[0]?.transcript ?? "";
      if (transcript === "")
        return;
      this.gotText = true;
      if (last.isFinal) {
        this.finalized = true;
        this.finalWaiter?.();
        this.finalWaiter = null;
      }
      this.text.emit(transcript, last.isFinal);
    };
    recognition.onerror = (event) => {
      this.errors.emit(new Error(event.error));
    };
    recognition.onend = () => {
      if (!this.userStopped)
        this.ends.emit();
    };
    this.recognition = recognition;
    recognition.start();
  }
  stop() {
    if (this.stopPromise !== null)
      return this.stopPromise;
    this.userStopped = true;
    this.recognition?.stop();
    this.recognition = null;
    this.stopPromise = new Promise((resolve) => {
      if (this.finalized || !this.gotText) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.finalWaiter = null;
        resolve();
      }, this.finalizeTimeoutMs);
      this.finalWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    return this.stopPromise;
  }
  onText(cb) {
    return this.text.on(cb);
  }
  onError(cb) {
    return this.errors.on(cb);
  }
  onEnd(cb) {
    return this.ends.on(cb);
  }
};
var NativeRecognizer = class {
  options;
  text = new Emitter();
  errors = new Emitter();
  ends = new Emitter();
  /** 串行推送链:前一块 dispatch 完成后才发下一块 */
  queue = Promise.resolve();
  capture = null;
  stopped = true;
  stopPromise = null;
  /** 本轮累计定稿文本(start() 重置) */
  finalizedText = "";
  constructor(options) {
    this.options = options;
  }
  async start() {
    this.stopped = false;
    this.stopPromise = null;
    this.finalizedText = "";
    const capture = await (this.options.capture ?? capturePcm)((int16) => this.onChunk(int16));
    if (this.stopped) {
      capture.stop();
      return;
    }
    this.capture = capture;
  }
  onChunk(int16) {
    if (this.stopped)
      return;
    this.enqueue(encodeBase64(int16), false);
  }
  enqueue(audio, final) {
    this.queue = this.queue.then(() => this.dispatch(audio, final));
  }
  async dispatch(audio, final) {
    try {
      const res = await this.options.callAsr({ sessionId: this.options.sessionId, audio, final });
      if (res.delta === "")
        return;
      if (res.final) {
        this.finalizedText += res.delta;
        this.text.emit(this.finalizedText, true);
      } else {
        this.text.emit(res.delta, false);
      }
    } catch (err) {
      console.error("dsh-voice ASR:", err instanceof Error ? err.message : String(err));
      if (final) throw err;
    }
  }
  stop() {
    if (this.stopPromise !== null)
      return this.stopPromise;
    this.stopped = true;
    this.capture?.stop();
    this.capture = null;
    this.enqueue("", true);
    this.stopPromise = this.queue;
    return this.stopPromise;
  }
  onText(cb) {
    return this.text.on(cb);
  }
  onError(cb) {
    return this.errors.on(cb);
  }
  onEnd(cb) {
    return this.ends.on(cb);
  }
};

// lib/core/wire.js
var VOICE_CHANNEL = "/voice";
var VOICE_ENDPOINTS = {
  ping: "ping",
  config: "config",
  asr: "asr"
};
var TTS_CHANNEL = "/tts";
var TTS_ENDPOINTS = {
  config: "config",
  status: "status",
  select: "select",
  unload: "unload",
  segments: "segments",
  voices: "voices",
  setVoice: "setVoice",
  speak: "speak",
  // 克隆音色的增删:面板里直接导入一段参考音频,不必再去文件管理器里拖文件。
  // 与 voices(列举)分开,是因为写盘要走另一条校验路径(见 index.js)。
  saveRef: "saveRef",
  deleteRef: "deleteRef",
  /**
   * 只列参考音频目录,**绝不加载任何模型**。
   * 不能用 voices 代替:那个端点会 ensureReady(),也就是打开设置面板就会
   * 把 24s 的 CosyVoice3 拉进显存 —— 只是想改个语言设置的用户不该付这个代价。
   */
  refs: "refs"
};
var VoiceRpcError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "VoiceRpcError";
  }
};

// lib/client/voice-service.js
function decode(res) {
  if (!res.ok)
    throw new VoiceRpcError(res.error.code, res.error.message);
  return res.value;
}
function createVoiceService(call) {
  return {
    ping: async () => decode(await call(VOICE_CHANNEL, VOICE_ENDPOINTS.ping, {})),
    fetchConfig: async () => decode(await call(VOICE_CHANNEL, VOICE_ENDPOINTS.config, {})),
    asr: async (payload) => decode(await call(VOICE_CHANNEL, VOICE_ENDPOINTS.asr, payload))
  };
}

// lib/client/runtime.js
var VoiceRuntime = class {
  ctx;
  config;
  engine = null;
  listening = false;
  starting = false;
  disposed = false;
  recognizer = null;
  /** 本轮累计定稿文本(停麦时提交;onText(final) 替换式更新) */
  pendingText = "";
  /** 当前部分识别文本(边说边出字,未定稿) */
  partialText = "";
  /** 轮次守卫:启动被打断、停麦后作废一切迟到回调 */
  round = 0;
  /** 停止进行中:onEnd/onError 与用户点停并发时防重入 */
  stopping = false;
  /** 开启本轮识别的会话;停麦提交一律归它(跨会话点停不串台) */
  activeSession = null;
  listeners = new Emitter();
  deps;
  constructor(ctx, config, deps = {}) {
    this.ctx = ctx;
    this.config = config;
    const rpc = deps.rpc ?? createVoiceService((channel, endpoint, payload) => this.ctx.connection.rpc.call(channel, endpoint, payload));
    this.deps = {
      createRecognizer: deps.createRecognizer ?? ((engine, sessionId) => createRecognizer(engine, sessionId, (payload) => rpc.asr(payload))),
      submit: deps.submit ?? ((sessionId, text) => this.appendDraft(sessionId, text)),
      rpc
    };
  }
  /** 每次点击都握手:等待 host 按需启动模型，不能复用旧的存活状态。 */
  async getEngine() {
    if (this.config.engine === "browser") return "browser";
    const { engine } = await this.deps.rpc.ping();
    if (engine !== "native" && engine !== "browser") throw new Error("语音服务返回了无效引擎");
    if (this.config.engine === "native" && engine !== "native")
      throw new Error("本地语音服务不可用");
    return engine;
  }
  /**
   * host /voice.config 到达后更新引擎选择。空闲时立即失效解析缓存,
   * 下一轮从新配置开始;正在识别的一轮不打断。
   */
  setEngine(engine) {
    if (this.config.engine === engine)
      return;
    this.config = { ...this.config, engine };
    if (!this.listening)
      this.engine = null;
  }
  isListening() {
    return this.listening;
  }
  isStarting() {
    return this.starting;
  }
  subscribe(cb) {
    return this.listeners.on(cb);
  }
  notify() {
    this.listeners.emit();
  }
  /** 点击即启动模型；握手成功后才采声，加载时再次点击可取消本轮。 */
  async toggleMic(sessionId) {
    if (this.disposed) return;
    if (this.listening) {
      await this.stopMic(this.activeSession ?? sessionId);
      return;
    }
    const round = ++this.round;
    this.activeSession = sessionId;
    this.listening = true;
    this.starting = true;
    this.pendingText = "";
    this.partialText = "";
    this.notify();
    try {
      const engine = await this.getEngine();
      if (this.round !== round) return;
      const rec = this.deps.createRecognizer(engine, sessionId);
      rec.onText((text, final) => {
        if (this.round !== round) return;
        if (final) {
          this.pendingText = text;
          this.partialText = "";
        } else {
          this.partialText = text;
        }
        this.notify();
      });
      rec.onError((err) => {
        if (this.round !== round) return;
        this.pendingText = "";
        this.partialText = "";
        void this.stopMic(sessionId).then(() => {
          console.error("dsh-voice ASR:", err);
        });
      });
      rec.onEnd(() => {
        if (this.round !== round) return;
        void this.stopMic(sessionId);
      });
      this.recognizer = rec;
      await rec.start();
      if (this.round !== round) {
        void rec.stop().catch(() => {
        });
        return;
      }
      this.starting = false;
      this.notify();
    } catch (err) {
      if (this.round !== round) return;
      this.round += 1;
      this.recognizer = null;
      this.activeSession = null;
      this.listening = false;
      this.starting = false;
      this.engine = null;
      this.notify();
      this.reportMicError(sessionId, err);
      throw err;
    }
  }
  /** 停止识别;定稿文本非空则追加到输入框草稿，不发送消息。幂等;轮次守卫杜绝迟到回调。 */
  async stopMic(sessionId) {
    const rec = this.recognizer;
    if (rec === null) {
      this.round += 1;
      this.activeSession = null;
      this.listening = false;
      this.starting = false;
      this.engine = null;
      this.notify();
      return;
    }
    const target = this.activeSession ?? sessionId;
    if (this.stopping)
      return;
    this.stopping = true;
    this.starting = false;
    this.notify();
    try {
      await rec.stop();
    } catch (err) {
      console.error("dsh-voice ASR 收尾失败:", err);
      this.pendingText = "";
      this.partialText = "";
      const scope = this.ctx.sessions.scope(target);
      const conversation = scope?.get("conversation");
      conversation?.input.for(scope).notify("error", "语音转写失败：" + String(err));
    }
    if (this.disposed) return;
    this.round += 1;
    this.stopping = false;
    this.recognizer = null;
    this.activeSession = null;
    const text = (this.pendingText + this.partialText).trim();
    this.pendingText = "";
    this.partialText = "";
    this.listening = false;
    this.engine = null;
    this.notify();
    if (text !== "")
      await this.deps.submit(target, text);
  }
  /** 插件卸载/HMR 时取消录音意图；迟到的加载结果不得重新打开麦克风。 */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.round += 1;
    const rec = this.recognizer;
    this.recognizer = null;
    this.activeSession = null;
    this.pendingText = "";
    this.partialText = "";
    this.listening = false;
    this.starting = false;
    this.stopping = false;
    this.notify();
    if (rec) void rec.stop().catch(() => {
    });
  }
  /** 当前部分识别文本(按钮提示实时回显用)。 */
  getPartial() {
    if (this.starting) return this.config.engine === "browser" ? "正在准备麦克风…" : "正在启动语音服务、加载模型，请稍候…";
    return this.stopping ? "正在转写，请稍候…" : this.partialText;
  }
  reportMicError(sessionId, error) {
    const messages = {
      NotFoundError: "没有检测到可用麦克风。请先连接麦克风或带麦克风的耳机，并在系统声音设置中确认输入设备，然后重试。",
      DevicesNotFoundError: "没有检测到可用麦克风。请先连接麦克风或带麦克风的耳机，并在系统声音设置中确认输入设备，然后重试。",
      NotAllowedError: "麦克风访问被拒绝。请检查浏览器中本网站的麦克风权限，以及系统的麦克风隐私设置。",
      PermissionDeniedError: "麦克风访问被拒绝。请检查浏览器中本网站的麦克风权限，以及系统的麦克风隐私设置。",
      NotReadableError: "麦克风无法读取，可能被其他程序占用或设备异常。请检查系统输入设备后重试。",
      OverconstrainedError: "麦克风不支持请求的录音参数，请检查系统默认输入设备后重试。"
    };
    const scope = this.ctx.sessions.scope(sessionId);
    const conversation = scope?.get("conversation");
    conversation?.input.for(scope).notify("error", messages[error?.name] ?? "无法开始语音输入：" + String(error));
  }
  async appendDraft(sessionId, text) {
    const scope = this.ctx.sessions.scope(sessionId);
    if (scope === void 0)
      return;
    const conversation = scope.get("conversation");
    if (conversation === void 0)
      return;
    const input = conversation.input.for(scope);
    const state = input.state.getSnapshot();
    const end = state.draft.length - state.occurrences.reduce((n, ref) => n + ref.length - 1, 0);
    const separator = state.draft !== "" && !/\s$/u.test(state.draft) ? "\n" : "";
    const inserted = (state.phase === "plain" || state.phase === "claimed") && scope.bail("slash/input-insert-text", {
      text: separator + text,
      span: { start: end, end, draftRev: state.draftRev }
    }) === true;
    if (!inserted) {
      input.notify("error", "语音转写未写入草稿，请复制后手动粘贴：\n" + text);
    }
  }
};

// lib/client/hotkey.js
var MODIFIER_KEYS = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  shift: "shift"
};
var MODIFIER_LABELS = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift"
};
function splitParts(spec) {
  return spec.toLowerCase().split("+").map((p) => p.trim()).filter((p) => p !== "");
}
function parseHotkey(spec) {
  const parsed = { ctrl: false, alt: false, shift: false, code: "" };
  let key = "";
  for (const p of splitParts(spec)) {
    const mod = MODIFIER_KEYS[p];
    if (mod !== void 0)
      parsed[mod] = true;
    else
      key = p;
  }
  if (key === "")
    return null;
  parsed.code = key === "space" ? "Space" : key === "enter" ? "Enter" : key === "esc" ? "Escape" : /^[a-z0-9]$/.test(key) ? "Key" + key.toUpperCase() : key;
  return parsed;
}
function hotkeyLabel(spec) {
  const parts = splitParts(spec);
  const key = parts.filter((p) => MODIFIER_KEYS[p] === void 0).pop() ?? "";
  const prefix = parts.filter((p) => MODIFIER_KEYS[p] !== void 0).map((p) => MODIFIER_LABELS[MODIFIER_KEYS[p]]).join("+");
  const keyLabel = key === "space" ? "空格" : key === "" ? "" : key.toUpperCase();
  return prefix === "" ? keyLabel : prefix + "+" + keyLabel;
}

// lib/core/config.js
var ENGINE_VALUES = ["auto", "browser", "native"];
var DEFAULTS = {
  engine: "native",
  hotkey: "ctrl+space",
  modelDir: "",
  vadThreshold: 0.3,
  tailPadSeconds: 0.6,
  asrDir: "asr-zh"
};
function isVoiceEngine(value) {
  return ENGINE_VALUES.includes(value);
}

// lib/client/mic-button.js
var import_jsx_runtime = require("react/jsx-runtime");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");
function IconMicrophoneOutline16() {
  return (0, import_jsx_runtime.jsxs)("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", children: [(0, import_jsx_runtime.jsx)("rect", { x: "6", y: "2.75", width: "4", height: "6.75", rx: "2", stroke: "currentColor", strokeWidth: "1.5" }), (0, import_jsx_runtime.jsx)("path", { d: "M3.75 7.25a4.25 4.25 0 0 0 8.5 0", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }), (0, import_jsx_runtime.jsx)("path", { d: "M8 11.75v1.5M5.25 13.25h5.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" })] });
}
function MicButton(props) {
  const { onToggle } = props;
  const listening = props.useListening((value) => value);
  const starting = props.useStarting((value) => value);
  const partial = props.usePartial((value) => value);
  const hotkey = props.useHotkey((value) => value);
  const title = starting ? partial + "（点击取消录音）" : listening ? partial !== "" ? partial + "（点击停止并写入草稿）" : "正在听…点击停止并写入草稿" : "语音输入(" + hotkey + ")";
  return (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, {
    variant: "toolbar",
    size: "sm",
    icon: listening ? (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives2.IconStopFill16, { style: { color: "var(--dsw-alias-danger, #d33)" } }) : (0, import_jsx_runtime.jsx)(IconMicrophoneOutline16, {}),
    "aria-label": starting ? title : listening ? "停止语音输入" : "开始语音输入",
    "aria-busy": starting,
    title,
    children: starting ? (0, import_jsx_runtime.jsx)("span", { role: "status", children: "语音加载中…" }) : void 0,
    style: listening ? { color: "var(--dsw-alias-danger, #d33)" } : void 0,
    onClick: onToggle
  });
}

// lib/client/speak-button.js
var import_jsx_runtime2 = require("react/jsx-runtime");
var import_dsh_client_ui_primitives3 = require("@deepseek-ai/dsh-client-ui-primitives");
function IconSpeakerOutline16() {
  return (0, import_jsx_runtime2.jsxs)("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", children: [(0, import_jsx_runtime2.jsx)("path", { d: "M8.25 3.25 4.75 6H2.75v4h2l3.5 2.75V3.25Z", stroke: "currentColor", strokeWidth: "1.5", strokeLinejoin: "round" }), (0, import_jsx_runtime2.jsx)("path", { d: "M10.75 5.75a3.25 3.25 0 0 1 0 4.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }), (0, import_jsx_runtime2.jsx)("path", { d: "M12.75 3.75a6 6 0 0 1 0 8.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" })] });
}
function IconMuteOutline16() {
  return (0, import_jsx_runtime2.jsxs)("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", children: [(0, import_jsx_runtime2.jsx)("path", { d: "M8.25 3.25 4.75 6H2.75v4h2l3.5 2.75V3.25Z", stroke: "currentColor", strokeWidth: "1.5", strokeLinejoin: "round" }), (0, import_jsx_runtime2.jsx)("path", { d: "M10.75 6.5l3 3M13.75 6.5l-3 3", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" })] });
}
function SpeakButton(props) {
  const { messageId, onSpeak } = props;
  const busy = props.useTts((value) => value.busy);
  const speaking = props.useTts((value) => value.speaking);
  const speakingId = props.useTts((value) => value.speakingMessageId);
  const active = speakingId === messageId && (speaking || busy);
  const title = active ? "停止朗读" : speaking || busy ? "朗读这条回复(会打断当前朗读)" : "朗读这条回复";
  return (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives3.Button, { variant: "toolbar", size: "sm", icon: active ? (0, import_jsx_runtime2.jsx)(IconMuteOutline16, {}) : (0, import_jsx_runtime2.jsx)(IconSpeakerOutline16, {}), "aria-label": title, title, "aria-pressed": active ? "true" : "false", style: active ? { color: "var(--dsw-alias-brand, #4a7dff)" } : void 0, onClick: () => onSpeak(messageId) });
}

// lib/client/tts-picker.js
var import_react_dom = require("react-dom");
var import_react = require("react");
var import_jsx_runtime3 = require("react/jsx-runtime");
var import_dsh_client_ui_primitives4 = require("@deepseek-ai/dsh-client-ui-primitives");
var import_dsh_client_ui_primitives5 = require("@deepseek-ai/dsh-client-ui-primitives");
var PANEL_WIDTH = 380;
var PANEL_MAX_HEIGHT = 460;
var MIN_SPACE_ABOVE = 220;
var panelStyle = {
  position: "fixed",
  zIndex: 3e3,
  width: PANEL_WIDTH,
  maxHeight: PANEL_MAX_HEIGHT,
  // 必须显式 border-box:面板 portal 到 body,拿不到应用里那条全局 box-sizing
  // 规则,默认 content-box 会让 max-height 不含 10px padding + 边框 ——
  // 按 max-height 夹出来的位置实际会多出 22px 从顶部溢出(实测 y=-12)。
  boxSizing: "border-box",
  overflowY: "auto",
  padding: "10px",
  borderRadius: "10px",
  border: "1px solid var(--dsw-alias-border, rgba(127,127,127,0.3))",
  background: "var(--dsw-alias-bg-elevated, #1e1f24)",
  color: "inherit",
  boxShadow: "0 12px 32px rgba(0,0,0,0.32)",
  fontSize: "12px",
  lineHeight: "1.5"
};
var sectionTitleStyle = {
  margin: "10px 0 6px",
  fontSize: "11px",
  opacity: 0.66,
  letterSpacing: "0.02em"
};
var hintStyle = {
  marginTop: "6px",
  fontSize: "11px",
  lineHeight: 1.5,
  opacity: 0.62,
  wordBreak: "break-word"
};
var rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  padding: "7px 8px",
  borderRadius: "8px",
  border: "1px solid transparent",
  background: "transparent",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
  font: "inherit"
};
function badge(text, tone) {
  const colors = {
    ok: "var(--dsw-alias-success, #3fa96a)",
    busy: "var(--dsw-alias-warning, #d39a2e)",
    off: "var(--dsw-alias-text-secondary, #8a8f99)"
  };
  return (0, import_jsx_runtime3.jsx)("span", { style: { color: colors[tone] ?? colors.off, fontSize: "11px", whiteSpace: "nowrap" }, children: text });
}
var selectStyle = {
  flex: 1,
  minWidth: 0,
  padding: "5px 6px",
  borderRadius: "6px",
  border: "1px solid var(--dsw-alias-border, rgba(127,127,127,0.3))",
  background: "var(--dsw-alias-bg-elevated, #1e1f24)",
  color: "inherit",
  font: "inherit"
};
function optionValue(item) {
  if (typeof item === "string")
    return item;
  return String(item?.id ?? item?.name ?? "");
}
function optionLabel(item) {
  if (typeof item === "string")
    return item;
  return String(item?.label ?? item?.name ?? optionValue(item));
}
function pairPart(voice, key) {
  for (const part of String(voice ?? "").split(",")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === key)
      return part.slice(at + 1).trim();
  }
  return "";
}
function pairWith(voice, key, value) {
  const pairs = /* @__PURE__ */ new Map();
  for (const part of String(voice ?? "").split(",")) {
    const at = part.indexOf("=");
    if (at !== -1)
      pairs.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  pairs.set(key, value);
  return [...pairs].map(([k, v]) => `${k}=${v}`).join(",");
}
function engineState(engine, preferred, active, status) {
  if (!engine.installed)
    return badge("未安装", "off");
  if (active === engine.id && status === "loading")
    return badge("加载中…", "busy");
  if (active === engine.id)
    return badge("已加载", "ok");
  if (preferred === engine.id && status === "loading")
    return badge("加载中…", "busy");
  return null;
}
function TtsPicker(props) {
  const { onSelect, onUnload, onAutoRead, onSetVoice, onLoadVoices } = props;
  const engines = props.useTts((value) => value.engines);
  const preferred = props.useTts((value) => value.preferred);
  const active = props.useTts((value) => value.active);
  const status = props.useTts((value) => value.status);
  const error = props.useTts((value) => value.error);
  const note = props.useTts((value) => value.note);
  const autoRead = props.useTts((value) => value.autoRead);
  const voice = props.useTts((value) => value.voice);
  const voiceGroups = props.useTts((value) => value.voiceGroups);
  const voiceKind = props.useTts((value) => value.voiceKind);
  const refDir = props.useTts((value) => value.refDir);
  const vram = props.useTts((value) => value.vramUsedMb);
  const [open, setOpen] = (0, import_react.useState)(false);
  const [anchor, setAnchor] = (0, import_react.useState)(null);
  const buttonRef = (0, import_react.useRef)(null);
  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect)
      return;
    const roomAbove = rect.top - 8;
    const roomBelow = window.innerHeight - rect.bottom - 8;
    const right = Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - PANEL_WIDTH - 8));
    if (roomAbove >= MIN_SPACE_ABOVE || roomAbove >= roomBelow) {
      setAnchor({ side: "above", offset: Math.max(8, window.innerHeight - rect.top + 8), right, maxHeight: Math.max(160, Math.min(PANEL_MAX_HEIGHT, roomAbove - 8)) });
      return;
    }
    setAnchor({ side: "below", offset: Math.max(8, rect.bottom + 8), right, maxHeight: Math.max(160, Math.min(PANEL_MAX_HEIGHT, roomBelow - 8)) });
  };
  (0, import_react.useEffect)(() => {
    if (!open)
      return;
    place();
    const onDown = (event) => {
      if (buttonRef.current?.contains(event.target))
        return;
      const panel2 = document.getElementById("dsh-voice-tts-panel");
      if (panel2?.contains(event.target))
        return;
      setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape")
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  const selected = engines.find((engine) => engine.id === preferred);
  const label = selected ? `${selected.medal} ${selected.label}` : preferred ?? "朗读";
  const busy = status === "loading";
  const title = active ? `${label}（显存中:${engines.find((e) => e.id === active)?.label ?? active}）` : `${label}（未加载,首次朗读时才加载）`;
  const voiceSelects = voiceGroups.length === 0 ? [(0, import_jsx_runtime3.jsx)("select", {
    key: "voice-empty",
    style: selectStyle,
    value: voice,
    disabled: true,
    children: (0, import_jsx_runtime3.jsx)("option", { value: voice, children: voice || "（尚未载入音色列表)" })
  })] : voiceGroups.flatMap((group) => {
    const isSingle = group.key === null;
    const current = isSingle ? voice : pairPart(voice, group.key);
    const missing = current !== "" && !group.items.some((item) => optionValue(item) === current);
    const nodes = [];
    if (!isSingle)
      nodes.push((0, import_jsx_runtime3.jsx)("div", { key: `lg-${group.key}`, style: { fontSize: "11px", opacity: 0.6 }, children: group.label }));
    nodes.push((0, import_jsx_runtime3.jsxs)("select", {
      key: `sel-${group.key ?? "single"}`,
      style: selectStyle,
      value: current,
      onChange: (event) => onSetVoice(isSingle ? event.target.value : pairWith(voice, group.key, event.target.value)),
      children: [
        // 当前值不在列表里(默认音色名、或列表不含它)时也要能显示出来。
        current === "" || missing ? (0, import_jsx_runtime3.jsx)("option", { value: current, children: current || "（未选择)" }) : null,
        ...group.items.map((item) => (0, import_jsx_runtime3.jsx)("option", { value: optionValue(item), children: optionLabel(item) }, optionValue(item)))
      ]
    }));
    return nodes;
  });
  const panel = open && anchor ? (0, import_react_dom.createPortal)((0, import_jsx_runtime3.jsxs)("div", {
    id: "dsh-voice-tts-panel",
    style: {
      ...panelStyle,
      maxHeight: anchor.maxHeight,
      ...anchor.side === "above" ? { bottom: anchor.offset } : { top: anchor.offset },
      right: anchor.right
    },
    "data-dsh-voice-side": anchor.side,
    role: "dialog",
    "aria-label": "朗读设置",
    children: [
      (0, import_jsx_runtime3.jsx)("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }, children: [
        (0, import_jsx_runtime3.jsx)("strong", { style: { fontSize: "12px" }, children: "朗读设置" }),
        (0, import_jsx_runtime3.jsx)("label", { style: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }, children: [
          (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: autoRead, onChange: (event) => onAutoRead(event.target.checked) }),
          "自动朗读新回复"
        ] })
      ] }),
      (0, import_jsx_runtime3.jsx)("div", { style: sectionTitleStyle, children: "回复用哪个模型读（换模型会先卸载旧的)" }),
      ...engines.map((engine) => {
        const isPreferred = engine.id === preferred;
        const state = engineState(engine, preferred, active, status);
        return (0, import_jsx_runtime3.jsxs)("button", {
          type: "button",
          key: engine.id,
          onClick: () => onSelect(engine.id),
          title: engine.blurb,
          style: {
            ...rowStyle,
            borderColor: isPreferred ? "var(--dsw-alias-brand, #4a7dff)" : "transparent",
            background: isPreferred ? "rgba(74,125,255,0.10)" : "transparent",
            opacity: engine.installed ? 1 : 0.55
          },
          children: [
            (0, import_jsx_runtime3.jsx)("span", { style: { width: "18px", textAlign: "center" }, children: engine.medal }),
            (0, import_jsx_runtime3.jsxs)("span", { style: { flex: 1, minWidth: 0 }, children: [
              (0, import_jsx_runtime3.jsxs)("span", { style: { display: "flex", alignItems: "center", gap: "6px" }, children: [
                (0, import_jsx_runtime3.jsx)("span", { style: { fontWeight: isPreferred ? 600 : 400 }, children: engine.label }),
                state
              ] }),
              (0, import_jsx_runtime3.jsx)("span", { style: { display: "block", opacity: 0.6, fontSize: "11px" }, children: `${engine.voiceKind === "preset" ? "预置音色" : "可克隆"} · RTF ${engine.rtf} · 约 ${engine.vramGb}GB${engine.commercial ? "" : " · 仅非商用"}` })
            ] })
          ]
        });
      }),
      (0, import_jsx_runtime3.jsx)("div", { style: sectionTitleStyle, children: voiceKind === "preset" ? "人声（预置音色)" : "人声（参考音频克隆)" }),
      (0, import_jsx_runtime3.jsxs)("div", { style: { display: "flex", gap: "6px", alignItems: "stretch" }, children: [
        (0, import_jsx_runtime3.jsx)("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "4px" }, children: voiceSelects }),
        (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives4.Button, { variant: "toolbar", size: "sm", onClick: () => onLoadVoices(), children: "载入音色" })
      ] }),
      // 克隆引擎的"音色"就是一段参考音频,所以这里必须告诉用户文件放哪儿 ——
      // 否则那个下拉看起来就只有出厂那两段,像是"不能换"。
      voiceKind === "preset" ? null : (0, import_jsx_runtime3.jsxs)("div", { style: hintStyle, children: [
        "克隆音色 = 参考音频:把 3~10 秒干净人声 wav 放进 ",
        (0, import_jsx_runtime3.jsx)("code", { style: { opacity: 0.9, wordBreak: "break-all" }, children: refDir || "（未配置参考音频目录)" }),
        ",同名 .txt 写上这段音频说了什么(更准)。放好后点「载入音色」,它会出现在上面的下拉里。"
      ] }),
      (0, import_jsx_runtime3.jsx)("div", { style: { marginTop: "10px", paddingTop: "8px", borderTop: "1px solid var(--dsw-alias-border, rgba(127,127,127,0.22))", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }, children: [
        (0, import_jsx_runtime3.jsxs)("span", { style: { opacity: 0.66, fontSize: "11px" }, children: [
          vram === null || vram === void 0 ? "显存:未知" : `整卡已用显存:${vram} MB`,
          active ? ` · 驻留:${engines.find((e) => e.id === active)?.label ?? active}` : " · 当前未加载任何模型"
        ] }),
        (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives4.Button, { variant: "toolbar", size: "sm", disabled: !active, onClick: () => onUnload(), children: "卸载模型" })
      ] }),
      error ? (0, import_jsx_runtime3.jsx)("div", { style: { marginTop: "6px", color: "var(--dsw-alias-danger, #d33)", fontSize: "11px" }, children: error }) : null,
      note ? (0, import_jsx_runtime3.jsx)("div", { style: { marginTop: "4px", opacity: 0.7, fontSize: "11px" }, children: note }) : null
    ]
  }), document.body) : null;
  return (0, import_jsx_runtime3.jsxs)("span", { style: { display: "inline-flex", alignItems: "center" }, children: [
    (0, import_jsx_runtime3.jsx)("span", { ref: buttonRef, style: { display: "inline-flex" }, children: (0, import_jsx_runtime3.jsxs)(import_dsh_client_ui_primitives4.Button, {
      variant: "toolbar",
      size: "sm",
      "aria-label": "朗读设置",
      "aria-expanded": open ? "true" : "false",
      title,
      onClick: () => setOpen((value) => !value),
      icon: busy ? (0, import_jsx_runtime3.jsx)("span", { role: "status", children: "…" }) : (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives5.IconChevronDownOutline14, {}),
      children: label
    }) }),
    panel
  ] });
}

// lib/client/audio-player.js
var AudioQueue = class {
  constructor(log = () => {
  }) {
    this.log = log;
    this.items = [];
    this.current = null;
    this.playing = false;
    this.unlocked = false;
    this.listeners = /* @__PURE__ */ new Set();
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
      const el = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=");
      el.volume = 0;
      void el.play().catch(() => {
      });
    } catch (error) {
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
            el.onerror = () => reject(new Error("音频播放失败"));
            void el.play().catch(reject);
          });
        } finally {
          URL.revokeObjectURL(url);
          el.onended = null;
          el.onerror = null;
          if (this.current === el) {
            this.current = null;
            this.cancelCurrent = null;
          }
        }
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.items.length = 0;
      this.error = error?.name === "NotAllowedError" ? "浏览器拦截了自动朗读,请先点一下页面再试" : String(error?.message ?? error);
      this.log(`AudioQueue: ${this.error}`);
    } finally {
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
        el.src = "";
      } catch (error) {
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
};

// lib/client/session-text.js
function textFromMessage(message) {
  const content = message?.content;
  if (!Array.isArray(content))
    return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}
function eventOf(entry) {
  return entry?.event ?? entry;
}
function createSessionReader(sessions) {
  return {
    /**
     * 取某条已定稿回复的文本。
     * 找不到就返回空串(调用方据此提示"这条回复没有可朗读的文本")。
     */
    assistantText(sessionId, messageId) {
      if (!sessionId || !messageId)
        return "";
      const binding = sessions?.binding?.(sessionId);
      if (!binding)
        return "";
      let entries;
      try {
        entries = binding.eventSource.getSnapshot()?.entries ?? [];
      } catch {
        return "";
      }
      for (let i = entries.length - 1; i >= 0; i--) {
        const event = eventOf(entries[i]);
        if (event?.type !== "assistant/message")
          continue;
        if (event.data?.message?.id !== messageId)
          continue;
        return textFromMessage(event.data.message);
      }
      return "";
    },
    /**
     * 订阅"新的已定稿助手回复"。
     * 事件窗口追加或流式回复定稿时同步发布，不需要轮询。
     * @returns 取消订阅函数。
     */
    onAssistantMessage(sessionId, handler) {
      const binding = sessions?.binding?.(sessionId);
      if (!binding)
        return () => {
        };
      const seen = /* @__PURE__ */ new Set();
      const remember = (entries) => {
        for (const entry of entries ?? []) {
          const event = eventOf(entry);
          if (entry?.type !== "transient" && event?.type === "assistant/message" && event.data?.message?.id)
            seen.add(event.data.message.id);
        }
      };
      try {
        remember(binding.eventSource.getSnapshot()?.entries);
      } catch {
      }
      return binding.eventSource.subscribe(() => {
        let change;
        try {
          change = binding.eventSource.getSnapshot()?.change;
        } catch {
          return;
        }
        if (change?.kind === "replace" || change?.kind === "prepend") {
          remember(change.entries);
          return;
        }
        const entries = change?.kind === "settle-assistant" ? change.entry ? [change.entry] : [] : change?.kind === "append" ? change.entries ?? [] : [];
        for (const entry of entries) {
          if (entry?.type === "transient") continue;
          const event = eventOf(entry);
          if (event?.type !== "assistant/message")
            continue;
          const messageId = event.data?.message?.id;
          const text = textFromMessage(event.data?.message);
          if (!messageId || !text.trim())
            continue;
          if (seen.has(messageId))
            continue;
          seen.add(messageId);
          handler({ messageId, text });
        }
      });
    }
  };
}

// lib/client/tts-service.js
function decode2(res) {
  if (!res.ok)
    throw new VoiceRpcError(res.error.code, res.error.message);
  return res.value;
}
function createTtsService(call) {
  return {
    /** 引擎目录 + 当前选择(不含任何加载副作用)。 */
    fetchConfig: async () => decode2(await call(TTS_CHANNEL, TTS_ENDPOINTS.config, {})),
    /** 非阻塞快照:加载中会返回 state='loading'。 */
    status: async () => decode2(await call(TTS_CHANNEL, TTS_ENDPOINTS.status, {})),
    /** 切引擎:宿主会先卸载旧引擎再加载新的。 */
    select: async (engine) => decode2(await call(TTS_CHANNEL, TTS_ENDPOINTS.select, { engine })),
    unload: async () => decode2(await call(TTS_CHANNEL, TTS_ENDPOINTS.unload, {})),
    /** 纯文本切句;engine 决定数字展开规则,不触发任何模型加载。 */
    segments: async (text, engine, options = {}) => decode2(await call(TTS_CHANNEL, TTS_ENDPOINTS.segments, { text, ...engine ? { engine } : {}, ...options })),
    voices: async (engine) => decode2(await call(TTS_CHANNEL, TTS_ENDPOINTS.voices, engine ? { engine } : {})),
    setVoice: async (voice) => decode2(await call(TTS_CHANNEL, TTS_ENDPOINTS.setVoice, { voice })),
    speak: async (text, options = {}) => decode2(await call(TTS_CHANNEL, TTS_ENDPOINTS.speak, { text, ...options })),
    /** 导入一段克隆音色(音频内容走 base64)。返回新目录,省一次列举往返。 */
    saveRef: async (name2, base642, text, ext) => decode2(await call(TTS_CHANNEL, TTS_ENDPOINTS.saveRef, { name: name2, audio: base642, text, ext })),
    /** 删掉一个克隆音色(连同同名 .txt)。 */
    deleteRef: async (name2) => decode2(await call(TTS_CHANNEL, TTS_ENDPOINTS.deleteRef, { name: name2 }))
  };
}
function wavBlob(base642, mime = "audio/wav") {
  const binary = atob(base642);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// lib/client/tts-store.js
var STORAGE_ENGINE = "dsh-voice.tts.engine";
var STORAGE_AUTO = "dsh-voice.tts.autoRead";
var GROUP_LABELS = { zh: "中文音色", en: "英文音色" };
function voiceLabel(voice) {
  const text = String(voice ?? "");
  if (!text.includes("/") && !text.includes("\\"))
    return text;
  const base = text.slice(Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1);
  return base.replace(/\.(wav|flac)$/i, "") || text;
}
function normalizeVoices(raw) {
  if (Array.isArray(raw)) {
    const voices = raw.filter((item) => typeof item === "string" && item !== "" || item !== null && typeof item === "object");
    return { voices, voiceGroups: voices.length ? [{ key: null, label: null, items: voices }] : [] };
  }
  if (raw !== null && typeof raw === "object") {
    const voiceGroups = [];
    const voices = [];
    for (const [key, list] of Object.entries(raw)) {
      if (!Array.isArray(list) || list.length === 0)
        continue;
      voiceGroups.push({ key, label: GROUP_LABELS[key] ?? key, items: list });
      voices.push(...list);
    }
    return { voices, voiceGroups };
  }
  return { voices: [], voiceGroups: [] };
}
function initialState() {
  return {
    started: false,
    engines: [],
    /** 用户想用的引擎(可能尚未加载)。 */
    preferred: null,
    /** 显存里真正驻留的引擎。 */
    active: null,
    status: "idle",
    error: null,
    voice: "",
    voices: [],
    /** 分组后的音色目录(见 normalizeVoices);Kokoro 会有 zh/en 两组。 */
    voiceGroups: [],
    /** 上面这份目录属于哪个引擎 —— 换引擎时必须作废,否则渲染旧引擎的音色名。 */
    voiceEngine: null,
    voiceKind: "preset",
    /** 参考音频目录(克隆音色的来源);面板据此告示用户"文件放哪儿"。 */
    refDir: "",
    autoRead: false,
    speaking: false,
    busy: false,
    /** 正在朗读哪条消息(用于按钮显示停止态)。 */
    speakingMessageId: null,
    note: "",
    vramUsedMb: null,
    loadSeconds: null,
    lastEvent: ""
  };
}
function readStorage(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}
function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
  }
}
function valueEquals(a, b) {
  if (a === b)
    return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i])
        continue;
      if (typeof a[i] === "object" && typeof b[i] === "object") {
        if (JSON.stringify(a[i]) !== JSON.stringify(b[i]))
          return false;
        continue;
      }
      return false;
    }
    return true;
  }
  return false;
}
var TtsController = class {
  constructor({ rpc, sessions, log = () => {
  } }) {
    this.log = log;
    this.service = createTtsService(rpc);
    this.reader = createSessionReader(sessions);
    this.audio = new AudioQueue(log);
    this.state = initialState();
    this.listeners = /* @__PURE__ */ new Set();
    this.poll = null;
    this.speechGeneration = 0;
    this.autoGeneration = 0;
    this.autoQueue = null;
    this.unbindSession = null;
    this.boundSession = void 0;
    this.disposed = false;
    this.state.autoRead = readStorage(STORAGE_AUTO, null) !== "0";
    const saved = readStorage(STORAGE_ENGINE, "");
    this.savedEngine = saved || null;
  }
  // ---- 订阅面(useSyncExternalStore 契约) ----
  subscribe = (cb) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = () => this.state;
  /** 只有真的变化才换对象引用,否则 React 会无限重渲染。 */
  update(patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (!valueEquals(this.state[key], value)) {
        changed = true;
        break;
      }
    }
    if (!changed)
      return;
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners)
      cb();
  }
  // ---- 生命周期 ----
  async start() {
    if (this.state.started || this.disposed)
      return;
    this.update({ started: true });
    const unlock = () => this.audio.unlock();
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    await this.refreshConfig();
  }
  async refreshConfig() {
    try {
      const config = await this.service.fetchConfig();
      const engines = config.engines ?? [];
      const known = engines.some((e) => e.id === this.savedEngine);
      const preferred = engines.some((e) => e.id === config.engine) ? config.engine : known ? this.savedEngine : engines[0]?.id ?? config.engine;
      this.savedEngine = preferred;
      this.update({
        engines,
        preferred,
        autoRead: typeof config.autoRead === "boolean" ? config.autoRead : this.state.autoRead,
        refDir: config.refDir ?? this.state.refDir
      });
      await this.refreshStatus();
    } catch (error) {
      this.log(`TTS 配置读取失败: ${String(error)}`);
      this.update({ error: `朗读服务不可用:${String(error?.message ?? error)}` });
    }
  }
  /**
   * 读一次状态快照。宿主侧是非阻塞的,加载中会返回 loading。
   * 只有处于 loading 时才起轮询,避免常态空转。
   */
  async refreshStatus() {
    try {
      const status = await this.service.status();
      const active = status.active === void 0 ? this.state.active : status.active;
      this.update({
        engines: status.engines ?? this.state.engines,
        active,
        status: status.state ?? "idle",
        error: status.error ?? null,
        // 同 active:字段缺失不等于"音色被清空",显式的 '' 才是。
        voice: status.voice === void 0 ? this.state.voice : status.voice,
        ...this.applyVoices(status.voices, active),
        voiceKind: status.voiceKind ?? this.state.voiceKind,
        refDir: status.refDir ?? this.state.refDir,
        vramUsedMb: status.vramUsedMb ?? null,
        loadSeconds: status.loadSeconds ?? null,
        lastEvent: status.lastEvent ?? ""
      });
    } catch (error) {
      this.log(`TTS 状态读取失败: ${String(error)}`);
      this.update({ error: String(error?.message ?? error) });
    }
    this.schedulePoll();
    return this.state;
  }
  schedulePoll() {
    const wantPoll = this.state.status === "loading";
    if (wantPoll && this.poll === null) {
      this.poll = setInterval(() => {
        void this.refreshStatus();
      }, 700);
    } else if (!wantPoll && this.poll !== null) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }
  // ---- 引擎选择 ----
  /** 用户显式点了某个引擎:立刻切(宿商会先卸载旧的),并加载新的。 */
  async select(engine) {
    if (this.disposed || !engine)
      return;
    this.savedEngine = engine;
    writeStorage(STORAGE_ENGINE, engine);
    const previous = this.state.active;
    this.update({
      preferred: engine,
      error: null,
      note: previous && previous !== engine ? "正在卸载上一个模型…" : "正在加载…"
    });
    try {
      const status = await this.service.select(engine);
      this.applyStatus(status);
    } catch (error) {
      this.update({ error: `切换失败:${String(error?.message ?? error)}` });
    }
  }
  async unload() {
    if (this.disposed)
      return;
    this.update({ note: "正在卸载…" });
    try {
      const status = await this.service.unload();
      this.applyStatus(status);
      this.update({ note: status.lastEvent || "已卸载" });
    } catch (error) {
      this.update({ error: `卸载失败:${String(error?.message ?? error)}` });
    }
  }
  /**
   * 把宿主回的 voices 载荷翻译成状态补丁。
   *
   * 关键规则:**载荷没带列表时保留已有分组,不要清空**。宿主有好几条路径不发
   * 音色列表(worker 的 setVoice 就只回 voice),早期版本在这里无条件覆盖,于是
   * 「选完音色 → 下一次 status 轮询」把分组打回单个占位选择框,用户看起来就是
   * 刚配的人声丢了。
   *
   * 唯一必须清空的情况是**引擎真的换了**(含被卸载,active 变 null):旧引擎的
   * 音色名对新引擎没有意义。
   *
   * 同理,`active` 缺失(undefined)时沿用旧值而不是当成 null —— 否则一份不完整
   * 的快照就会被误读成"模型已经卸载",顺手把音色目录也清了。显式的 null 才表示
   * 显存里真的没有模型。
   */
  applyVoices(rawVoices, activeEngine) {
    const nextEngine = activeEngine ?? null;
    const engineChanged = nextEngine !== (this.state.voiceEngine ?? null);
    const normalized = normalizeVoices(rawVoices);
    if (normalized.voiceGroups.length)
      return { ...normalized, voiceEngine: nextEngine };
    if (engineChanged)
      return { voices: [], voiceGroups: [], voiceEngine: nextEngine };
    return {};
  }
  applyStatus(status) {
    const active = status.active === void 0 ? this.state.active : status.active;
    this.update({
      engines: status.engines ?? this.state.engines,
      active,
      status: status.state ?? "idle",
      error: status.error ?? null,
      voice: status.voice ?? this.state.voice,
      ...this.applyVoices(status.voices, active),
      voiceKind: status.voiceKind ?? this.state.voiceKind,
      refDir: status.refDir ?? this.state.refDir,
      vramUsedMb: status.vramUsedMb ?? null,
      loadSeconds: status.loadSeconds ?? null,
      lastEvent: status.lastEvent || this.state.lastEvent,
      note: status.lastEvent || this.state.note
    });
    this.schedulePoll();
  }
  // ---- 音色(人声配置)----
  setAutoRead(enabled) {
    if (!enabled) this.autoGeneration++;
    this.update({ autoRead: enabled });
    writeStorage(STORAGE_AUTO, enabled ? "1" : "0");
  }
  async setVoice(voice) {
    if (this.disposed || !voice)
      return;
    this.update({ note: "正在应用音色…" });
    try {
      const result = await this.service.setVoice(voice);
      this.update({
        voice: result.voice ?? voice,
        ...this.applyVoices(result.voices, this.state.active),
        note: `音色:${voiceLabel(result.voice ?? voice)}`
      });
    } catch (error) {
      this.update({ error: `音色设置失败:${String(error?.message ?? error)}` });
    }
  }
  /** 载入音色列表(会按需加载引擎,所以只在用户展开音色面板时调)。 */
  async loadVoices(engine) {
    try {
      const result = await this.service.voices(engine);
      const active = result.engine ?? this.state.active;
      this.update({
        ...this.applyVoices(result.voices, active),
        voice: result.voice ?? this.state.voice,
        active
      });
      await this.refreshStatus();
      this.schedulePoll();
    } catch (error) {
      this.update({ error: `音色列表读取失败:${String(error?.message ?? error)}` });
    }
  }
  // ---- 朗读 ----
  /** 会话切换时重绑自动朗读。 */
  bindSession(sessionId) {
    if (this.disposed || sessionId === this.boundSession)
      return;
    this.autoGeneration++;
    this.boundSession = sessionId;
    this.unbindSession?.();
    this.unbindSession = null;
    if (sessionId === void 0)
      return;
    this.unbindSession = this.reader.onAssistantMessage(sessionId, ({ messageId, text }) => {
      if (!this.state.autoRead || this.disposed)
        return;
      const queuedGeneration = this.autoGeneration;
      const read = async () => {
        if (this.state.busy || this.state.speaking) {
          await new Promise((resolve) => {
            const unsubscribe = this.subscribe(() => {
              if (this.disposed || queuedGeneration !== this.autoGeneration || !this.state.busy && !this.state.speaking) {
                unsubscribe();
                resolve();
              }
            });
          });
        }
        if (queuedGeneration !== this.autoGeneration || !this.state.autoRead || this.disposed) return;
        return this.speakText(text, { engine: this.savedEngine ?? void 0, messageId, automatic: true });
      };
      this.autoQueue = (this.autoQueue ? this.autoQueue.then(read) : read()).catch((error) => this.log(String(error)));
    });
  }
  /** 点某条消息的朗读按钮。 */
  async speakMessage(sessionId, messageId) {
    if (this.state.speakingMessageId === messageId && (this.state.speaking || this.state.busy)) {
      this.stop();
      return;
    }
    const text = this.reader.assistantText(sessionId, messageId);
    if (!text.trim()) {
      this.update({ error: "这条回复没有可朗读的文本" });
      return;
    }
    await this.speakText(text, { engine: this.savedEngine ?? void 0, messageId });
  }
  /**
   * 主流程:切句 → 逐句合成 → 顺序播放。
   * 每一句合成后立刻入队,所以第一句在整段合成完之前就响了。
   */
  async speakText(text, { engine, messageId = null, plainText = false, automatic = false } = {}) {
    if (this.disposed)
      return;
    const content = String(text ?? "");
    if (!content.trim()) {
      this.update({ error: "没有可朗读的文本" });
      return;
    }
    if (!automatic) this.autoGeneration++;
    const generation = ++this.speechGeneration;
    this.audio.stop();
    this.audio.unlock();
    const target = engine ?? this.state.preferred ?? void 0;
    this.update({ busy: true, error: null, note: "正在准备文本…", speaking: false, speakingMessageId: messageId });
    let engineChanged = false;
    const failed = [];
    let spoken = 0;
    try {
      const prepared = await this.service.segments(content, target, plainText ? { markdown: false } : {});
      if (generation !== this.speechGeneration)
        return;
      const segments = prepared.segments ?? [];
      if (segments.length === 0) {
        this.update({ busy: false, speakingMessageId: null, note: "没有可朗读的内容" });
        return;
      }
      const label = this.state.engines.find((e) => e.id === (target ?? this.state.preferred))?.label ?? (target ?? "");
      this.update({
        note: prepared.degraded ? `${label}:文本预处理降级,仍将朗读 ${segments.length} 句` : `${label}:共 ${segments.length} 句,正在合成第 1 句…`
      });
      this.update({ note: this.state.active && this.state.active === target ? `${label}:共 ${segments.length} 句` : `${label}:首次朗读需要加载模型,可能要几十秒…` });
      for (let i = 0; i < segments.length; i++) {
        if (generation !== this.speechGeneration)
          return;
        if (!/[\p{L}\p{N}]/u.test(segments[i])) continue;
        this.update({ note: `${label}:正在合成第 ${i + 1}/${segments.length} 句…` });
        let result = null;
        let lastError = null;
        for (let attempt = 0; attempt < 2 && result === null; attempt++) {
          try {
            result = await this.service.speak(segments[i], { ...target ? { engine: target } : {}, prepared: plainText || !prepared.degraded });
            if (!result?.wav && /[\p{L}\p{N}]/u.test(segments[i])) {
              const reason = result?.skipped ?? "没有返回音频";
              result = null;
              throw new Error(reason);
            }
          } catch (error) {
            lastError = error;
            if (generation !== this.speechGeneration)
              return;
          }
        }
        if (generation !== this.speechGeneration)
          return;
        if (result === null) {
          failed.push({ index: i + 1, text: segments[i], error: String(lastError?.message ?? lastError) });
          this.log(`TTS 第 ${i + 1}/${segments.length} 句合成失败,跳过: ${String(lastError?.message ?? lastError)}`);
          continue;
        }
        if (result.skipped) {
          this.log(`TTS 跳过第 ${i + 1} 句: ${result.skipped}`);
          continue;
        }
        if (result.wav) {
          spoken++;
          this.audio.enqueue(wavBlob(result.wav, result.mime));
          if (result.engine && result.engine !== this.state.active)
            engineChanged = true;
          this.update({
            speaking: true,
            active: result.engine ?? this.state.active,
            note: `${label}:正在朗读第 ${i + 1}/${segments.length} 句`
          });
          if (engineChanged) {
            engineChanged = false;
            await this.refreshStatus();
          }
        }
      }
      if (generation === this.speechGeneration) {
        await this.audio.waitUntilIdle?.();
        if (generation !== this.speechGeneration) return;
        await this.refreshStatus();
        if (generation !== this.speechGeneration) return;
        if (failed.length > 0 && spoken === 0) {
          this.update({
            note: "",
            busy: false,
            speaking: false,
            speakingMessageId: null,
            error: `${label}:${segments.length} 句全部合成失败(${failed[0].error})`
          });
        } else if (failed.length > 0) {
          this.update({
            note: `${label}:朗读完成,${failed.length} 句合成失败已跳过(第 ${failed.map((f) => f.index).join("、")} 句)`,
            error: null,
            busy: false,
            speaking: false,
            speakingMessageId: null
          });
        } else {
          this.update({ note: "朗读完成", busy: false, speaking: false, speakingMessageId: null });
        }
      }
    } catch (error) {
      if (generation !== this.speechGeneration)
        return;
      this.log(`TTS 朗读失败: ${String(error)}`);
      this.update({ busy: false, speaking: false, speakingMessageId: null, error: `朗读失败:${String(error?.message ?? error)}`, note: "" });
    }
  }
  /** 停止朗读(不卸载模型)。 */
  stop() {
    this.autoGeneration++;
    this.speechGeneration++;
    this.audio.stop();
    this.update({ speaking: false, busy: false, speakingMessageId: null, note: "已停止" });
  }
  dispose() {
    if (this.disposed)
      return;
    this.disposed = true;
    this.speechGeneration++;
    this.autoGeneration++;
    this.unbindSession?.();
    if (this.poll !== null) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.audio.dispose();
    this.update({ busy: false, speaking: false, speakingMessageId: null });
    this.listeners.clear();
  }
};

// lib/client/settings-store.js
var VOICE_CHANNEL2 = "/voice";
var TTS_CHANNEL2 = "/tts";
function initialState2() {
  return {
    /** 'loading' 首读中 | 'ready' 可读(可写与否看 writable) */
    status: "loading",
    /** 解析后的完整设置。 */
    value: null,
    /** 用户层里**显式改过**的字段 —— 面板据此标记,并允许单独恢复默认。 */
    overridden: [],
    /** settings 文档是否接受写入(memory 模式 / 没 provider 都是 false)。 */
    writable: false,
    /** 'host' 与宿主文档同步 | 'memory' 只在本进程内。 */
    mode: "host",
    /** 正在写(按钮置忙,防连点)。 */
    saving: false,
    /** 面板顶部错误条。 */
    error: "",
    /** 面板顶部说明条。 */
    note: "",
    /**
     * host 注册设置命名空间失败的原因(用户 settings.yaml 里的 voice 段
     * 有非法值)。非空时面板必须显示:否则用户只会看到"面板是灰的、
     * 我改的值没生效",而文件里那行错字无从查起。
     */
    settingsError: "",
    /** 语音输入语言下拉的可选值(带中文标签,由 host 下发)。 */
    languages: [],
    /** 朗读语言指令下拉的可选值(同样由 host 下发,见 core/tts-instruct.js)。 */
    instructLanguages: [],
    /** 朗读引擎目录(host 已按 ttsVisibleEngines 过滤)。 */
    engines: [],
    /**
     * **全部**引擎(不受"显示哪些引擎"过滤)。
     * 面板那份勾选框必须用它渲染:只列可见的话,取消勾选之后就再也勾不回来了。
     */
    engineChoices: [],
    /** 参考音频目录(绝对路径,要显示给用户看)。 */
    refDir: "",
    /** 目录里现在有哪些参考音频。 */
    refs: [],
    refsBusy: false
  };
}
function sameField(a, b) {
  if (a === b)
    return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      return false;
    return a.every((item, i) => {
      const other = b[i];
      if (item === other)
        return true;
      if (item !== null && other !== null && typeof item === "object" && typeof other === "object")
        return JSON.stringify(item) === JSON.stringify(other);
      return false;
    });
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object")
    return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
var VoiceSettingsStore = class {
  /**
   * @param options.bindScope - `() => SettingsScope|null`。必须是回调而不是
   *   现成的 scope:bind 要在插件的 fiber 上调用(见 dsh-client-ui-settings)。
   * @param options.rpc - (channel, endpoint, payload) => Promise<{ok,value,error}>
   * @param options.log - 诊断出口。
   */
  constructor({ bindScope, rpc, onVoiceSelected = async () => {
  }, log = () => {
  } } = {}) {
    this.onVoiceSelected = onVoiceSelected;
    this.bindScope = bindScope ?? (() => null);
    this.rpc = rpc;
    this.log = log;
    this.state = initialState2();
    this.listeners = /* @__PURE__ */ new Set();
    this.scope = null;
    this.unsubscribe = null;
    this.scopeValue = null;
    this.hostValue = null;
    this.userKeys = [];
    this.disposed = false;
    this.started = false;
  }
  getSnapshot = () => this.state;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(patch) {
    let changed = false;
    for (const [key, next] of Object.entries(patch)) {
      if (!sameField(this.state[key], next)) {
        changed = true;
        break;
      }
    }
    if (!changed)
      return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.log(`语音设置订阅者抛错: ${String(error)}`);
      }
    }
  }
  async start() {
    if (this.started || this.disposed)
      return;
    this.started = true;
    if (this.scope === null) {
      try {
        this.attachScope(this.bindScope());
      } catch (error) {
        this.log(`语音设置作用域绑定失败: ${String(error)}`);
        this.attachScope(null);
      }
    }
    await this.refresh();
  }
  /**
   * 接上/摘掉设置作用域。
   *
   * 之所以是"可后接"的,而不是构造时一次定死:`settingsScope` 在本插件里是
   * **可选**依赖 —— 设置界面没装载时麦克风和朗读必须照常工作,所以作用域
   * 可能在 start() 之后才出现,也可能中途消失。
   * @param scope - 绑好的作用域;null 表示摘掉(退回 host 下发的只读值)。
   */
  attachScope(scope) {
    if (this.disposed)
      return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.scope = scope;
    if (scope === null) {
      this.scopeValue = null;
      this.userKeys = [];
      this.publish();
      return;
    }
    this.unsubscribe = scope.subscribe(() => this.syncFromScope());
    this.syncFromScope();
  }
  /** 把 scope 快照折进面板状态。scope 是权威源,读到什么就是什么。 */
  syncFromScope() {
    if (this.scope === null || this.disposed)
      return;
    const snapshot = this.scope.getSnapshot();
    const user = snapshot.user !== null && typeof snapshot.user === "object" ? snapshot.user : null;
    if (snapshot.value !== void 0)
      this.scopeValue = snapshot.value;
    this.userKeys = user === null ? [] : Object.keys(user);
    this.publish();
  }
  /**
   * 重算对外那一个快照。
   * 单一来源优先级:scope 有解析值就用它(它是三层解析的结果,host 下发的
   * 那份只是同一个对象的副本);scope 没有才退回 host 下发的那份。
   */
  publish(extra = {}) {
    const value = this.scopeValue ?? this.hostValue;
    const writable = this.scope !== null && this.scope.getSnapshot?.().writable === true;
    const mode = this.scope?.getSnapshot?.().mode ?? "memory";
    this.update({
      value,
      overridden: this.userKeys,
      writable,
      mode,
      // 有值就算 ready。没有 scope 时 writable=false,面板会把控件置灰
      // 并说明"要改请改配置文件",而不是假装能改。
      status: value === null ? "loading" : "ready",
      ...extra
    });
  }
  /** 从 host 拉语言表 / 引擎目录 / 参考音频目录。 */
  async refresh() {
    const [voice, tts] = await Promise.all([
      this.call(VOICE_CHANNEL2, "config"),
      this.call(TTS_CHANNEL2, "config")
    ]);
    const patch = {};
    if (voice !== null) {
      if (Array.isArray(voice.languages))
        patch.languages = voice.languages;
      if (Array.isArray(voice.instructLanguages))
        patch.instructLanguages = voice.instructLanguages;
      if (Array.isArray(voice.ttsEngines))
        patch.engineChoices = voice.ttsEngines;
      if (voice.settings !== null && typeof voice.settings === "object")
        this.hostValue = voice.settings;
      if (typeof voice.settingsError === "string")
        patch.settingsError = voice.settingsError;
    }
    if (tts !== null) {
      if (Array.isArray(tts.engines))
        patch.engines = tts.engines;
      if (typeof tts.refDir === "string" && tts.refDir)
        patch.refDir = tts.refDir;
      if (Array.isArray(tts.refs))
        patch.refs = tts.refs;
    }
    this.publish(patch);
  }
  async call(channel, endpoint, payload = {}) {
    try {
      const res = await this.rpc(channel, endpoint, payload);
      if (res?.ok !== true)
        throw new Error(res?.error?.message ?? "RPC 失败");
      return res.value;
    } catch (error) {
      this.log(`语音设置 ${channel}/${endpoint} 失败: ${String(error)}`);
      return null;
    }
  }
  /** 重新列一次参考音频目录。不加载模型(见 wire.js 的 refs 端点说明)。 */
  async refreshRefs() {
    this.update({ refsBusy: true });
    const value = await this.call(TTS_CHANNEL2, TTS_ENDPOINTS.refs, {});
    const patch = { refsBusy: false };
    if (value !== null) {
      if (Array.isArray(value.refs))
        patch.refs = value.refs;
      if (typeof value.refDir === "string" && value.refDir)
        patch.refDir = value.refDir;
    }
    this.update(patch);
  }
  /**
   * 写一个字段。值必须是 JSON 可序列化的:scope.set 会把它原样存进用户层,
   * 传进一个 React 事件对象会以"非 JSON 值"被拒。
   */
  async set(field, value) {
    if (this.scope === null) {
      this.update({ error: "设置文档不可写：这个部署没有装载 settings provider，请改 cordis.patch.yml 后重启" });
      return false;
    }
    this.update({ saving: true, error: "", note: "" });
    try {
      await this.scope.set(field, value);
      this.syncFromScope();
      this.update({ saving: false, note: "已保存" });
      if (field === "ttsVisibleEngines")
        await this.refresh();
      return true;
    } catch (error) {
      this.update({ saving: false, error: `保存失败：${String(error?.message ?? error)}` });
      return false;
    }
  }
  /** 单个字段恢复默认(从用户层清掉,退回 cordis.patch.yml / schema 默认)。 */
  async resetField(field) {
    if (this.scope === null)
      return false;
    this.update({ saving: true, error: "", note: "" });
    try {
      await this.scope.unset(field);
      this.syncFromScope();
      this.update({ saving: false, note: "已恢复默认" });
      await this.refresh();
      return true;
    } catch (error) {
      this.update({ saving: false, error: `恢复失败：${String(error?.message ?? error)}` });
      return false;
    }
  }
  /**
   * 全部恢复默认。
   * 用 mutate+unset 而不是"写一份空对象":unset 只删掉用户层里**确实存在**
   * 的键,而写空值会把每个字段都变成"用户显式设成空",那是另一回事
   * (而且会被 schema 拒掉)。
   */
  async resetAll() {
    if (this.scope === null)
      return false;
    const fields = this.userKeys;
    if (fields.length === 0) {
      this.update({ note: "当前没有任何自定义设置" });
      return true;
    }
    this.update({ saving: true, error: "", note: "" });
    try {
      await this.scope.mutate(fields.map((field) => ({ op: "unset", path: [field] })));
      this.syncFromScope();
      this.update({ saving: false, note: "已全部恢复默认" });
      await this.refresh();
      return true;
    } catch (error) {
      this.update({ saving: false, error: `恢复失败：${String(error?.message ?? error)}` });
      return false;
    }
  }
  /** 导入一个克隆音色(音频内容由组件读成 base64)。 */
  async saveRef({ name: name2, audio, text, ext }, engine) {
    this.update({ refsBusy: true, error: "", note: "" });
    const value = await this.call(TTS_CHANNEL2, TTS_ENDPOINTS.saveRef, { name: name2, audio, text, ext });
    if (value === null) {
      this.update({ refsBusy: false, error: "导入失败（宿主拒绝了这次写入，详见宿主日志）" });
      return false;
    }
    this.update({ refsBusy: false, note: `已导入音色「${value.saved?.label ?? name2}」` });
    if (Array.isArray(value.refs))
      this.update({ refs: value.refs });
    if (typeof value.refDir === "string" && value.refDir)
      this.update({ refDir: value.refDir });
    if (engine && value.saved?.id) {
      const selected = await this.useRef(value.saved.id, engine);
      if (!selected) this.update({ error: "音色已保存，但未能设为当前音色，请在列表中点“使用”重试。" });
    }
    return true;
  }
  /** Persist engine and its voice together; preserve every other engine's voice. */
  async useRef(id, engine) {
    if (!this.state.writable || !this.scope) return false;
    if (!this.state.engineChoices.some((e) => e.id === engine && e.voiceKind === "clone" && e.installed !== false)) {
      this.update({ error: "请选择可用的克隆引擎" });
      return false;
    }
    this.update({ saving: true, error: "", note: "" });
    try {
      const value = this.scope.getSnapshot().value ?? this.state.value ?? {};
      const ops = [
        { op: "set", path: ["ttsEngine"], value: engine },
        { op: "set", path: ["ttsVoice"], value: { ...value.ttsVoice, [engine]: id } }
      ];
      if (value.ttsVisibleEngines?.length && !value.ttsVisibleEngines.includes(engine))
        ops.push({ op: "set", path: ["ttsVisibleEngines"], value: [...value.ttsVisibleEngines, engine] });
      await this.scope.mutate(ops);
      this.syncFromScope();
      await this.onVoiceSelected();
      this.update({ note: "已选用音色", saving: false });
      return true;
    } catch (error) {
      this.update({ saving: false, error: `使用音色失败：${error?.message ?? error}` });
      return false;
    }
  }
  async previewRef(id, engine, text, isCurrent = () => true) {
    if (!text?.trim()) throw new Error("请填写示例文本");
    if (!await this.useRef(id, engine)) throw new Error(this.state.error || "设置不可写");
    const call = async (endpoint, payload) => {
      if (!isCurrent() || this.disposed) throw new Error("试听已取消");
      const res = await this.rpc(TTS_CHANNEL2, endpoint, payload);
      if (!res?.ok) throw new Error(res?.error?.message ?? "朗读服务不可用");
      return res.value;
    };
    await call(TTS_ENDPOINTS.select, { engine });
    await call(TTS_ENDPOINTS.setVoice, { voice: id });
    const result = await call(TTS_ENDPOINTS.speak, { text: text.trim().slice(0, 200), engine, voice: id });
    if (!result?.wav) throw new Error("引擎没有生成示例音频，请检查参考音频和文本后重试");
    return result;
  }
  /** 删掉一个克隆音色(连同同名 .txt)。 */
  async deleteRef(name2) {
    this.update({ refsBusy: true, error: "", note: "" });
    const value = await this.call(TTS_CHANNEL2, TTS_ENDPOINTS.deleteRef, { name: name2 });
    if (value === null) {
      this.update({ refsBusy: false, error: "删除失败" });
      return false;
    }
    this.update({ refsBusy: false, note: value.removed ? `已删除「${name2}」` : `没找到「${name2}」` });
    if (Array.isArray(value.refs))
      this.update({ refs: value.refs });
    return true;
  }
  dispose() {
    if (this.disposed)
      return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
};

// lib/client/settings-section.js
var import_react3 = require("react");

// lib/client/clone-voice-block.js
var import_react2 = require("react");
var import_dsh_client_ui_primitives6 = require("@deepseek-ai/dsh-client-ui-primitives");

// lib/client/ref-recorder.js
var REFERENCE_SCRIPT = "你好，这是我的声音。希望今天的每一次交流，都能清晰自然，充满温暖。";
var SAMPLE_SCRIPT = "你好，很高兴认识你。这是使用你保存的音色生成的示例，今后我可以用这个声音为你朗读。";
var MAX_RECORD_SECONDS = 20;
function pcmWav(chunks, sampleRate = ASR_SAMPLE_RATE) {
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const ascii = (offset2, text) => [...text].forEach((char, i) => view.setUint8(offset2 + i, char.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) {
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  return buffer;
}
function availableRefName(refs, base = "我的音色") {
  const labels = new Set(refs.map((ref) => ref.label));
  if (!labels.has(base)) return base;
  let n = 2;
  while (labels.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
var ReferenceRecorder = class {
  constructor(onChange, capture = capturePcm) {
    this.onChange = onChange;
    this.capture = capture;
    this.generation = 0;
    this.state = { status: "idle", seconds: 0, wav: null, error: "" };
  }
  update(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
  async start() {
    this.cancel();
    const generation = this.generation;
    this.chunks = [];
    this.samples = 0;
    this.update({ status: "starting", seconds: 0, wav: null, error: "" });
    try {
      const capture = await this.capture((chunk) => {
        if (generation !== this.generation) return;
        const keep = chunk.slice(0, MAX_RECORD_SECONDS * ASR_SAMPLE_RATE - this.samples);
        this.chunks.push(keep);
        this.samples += keep.length;
        this.update({ seconds: this.samples / ASR_SAMPLE_RATE });
        if (this.samples >= MAX_RECORD_SECONDS * ASR_SAMPLE_RATE) this.stop();
      });
      if (generation !== this.generation) {
        capture.stop();
        return;
      }
      this.active = capture;
      this.update({ status: "recording" });
      this.timer = setTimeout(() => this.stop(), (MAX_RECORD_SECONDS + 1) * 1e3);
    } catch (error) {
      if (generation !== this.generation) return;
      this.cancel();
      const denied = error?.name === "NotAllowedError";
      this.update({ status: "idle", error: denied ? "麦克风权限被拒绝，请在浏览器中允许麦克风后重试。" : `无法录制：${error?.message ?? error}` });
    }
  }
  release() {
    clearTimeout(this.timer);
    this.active?.stop();
    this.active = null;
  }
  cancel() {
    this.generation++;
    this.release();
    this.chunks = [];
    this.update({ status: "idle", seconds: 0, wav: null, error: "" });
  }
  stop() {
    if (!["recording", "starting"].includes(this.state.status)) return;
    this.generation++;
    this.release();
    if (this.samples < 3 * ASR_SAMPLE_RATE) {
      this.update({ status: "idle", wav: null, error: "录音不足 3 秒，请重新录制并完整读完参考文本。" });
    } else {
      let peak = 0;
      for (const chunk of this.chunks) for (const sample of chunk) peak = Math.max(peak, Math.abs(sample));
      this.update(peak < 64 ? { status: "idle", wav: null, error: "没有录到清晰的声音，请检查麦克风后重试。" } : { status: "ready", wav: pcmWav(this.chunks), error: "" });
    }
    this.chunks = [];
  }
  dispose() {
    this.onChange = () => {
    };
    this.cancel();
  }
};

// lib/client/clone-voice-block.js
function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
function ClipPlayer({ blob, label, autoPlay = false }) {
  const audio = (0, import_react2.useRef)(null);
  const [url, setUrl] = (0, import_react2.useState)("");
  (0, import_react2.useEffect)(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    const element = audio.current;
    return () => {
      element?.pause();
      URL.revokeObjectURL(next);
    };
  }, [blob]);
  (0, import_react2.useEffect)(() => {
    if (url && autoPlay) void audio.current?.play().catch(() => {
    });
  }, [url, autoPlay]);
  return (0, import_react2.createElement)("div", null, (0, import_react2.createElement)("div", null, label), (0, import_react2.createElement)("audio", {
    ref: audio,
    src: url || void 0,
    controls: true,
    "aria-label": label,
    style: { width: "100%", maxWidth: "460px", height: "36px", marginTop: "6px" }
  }));
}
function CloneVoiceBlock({ state, disabled, store, styles: S2, Select: Select2 }) {
  const fileRef = (0, import_react2.useRef)(null);
  const recorder = (0, import_react2.useRef)(null);
  const request = (0, import_react2.useRef)(0);
  const [recording, setRecording] = (0, import_react2.useState)({ status: "idle", seconds: 0, wav: null, error: "" });
  const [name2, setName] = (0, import_react2.useState)("");
  const [text, setText] = (0, import_react2.useState)("");
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [error, setError] = (0, import_react2.useState)("");
  const [raw, setRaw] = (0, import_react2.useState)(null);
  const [preview, setPreview] = (0, import_react2.useState)(null);
  const [previewing, setPreviewing] = (0, import_react2.useState)("");
  const [sample, setSample] = (0, import_react2.useState)(SAMPLE_SCRIPT);
  const engines = (state.engineChoices ?? []).filter((e) => e.voiceKind === "clone" && e.installed !== false);
  const [chosenEngine, setChosenEngine] = (0, import_react2.useState)("");
  const engine = engines.some((e) => e.id === chosenEngine) ? chosenEngine : engines.find((e) => e.id === state.value?.ttsEngine)?.id ?? engines.find((e) => e.id === "cosyvoice3")?.id ?? engines[0]?.id ?? "";
  const capturing = ["starting", "recording"].includes(recording.status);
  const locked = disabled || busy || state.refsBusy || !!previewing;
  (0, import_react2.useEffect)(() => {
    recorder.current = new ReferenceRecorder(setRecording);
    return () => {
      request.current++;
      recorder.current?.dispose();
      recorder.current = null;
    };
  }, []);
  (0, import_react2.useEffect)(() => {
    setRaw(recording.wav ? new Blob([recording.wav], { type: "audio/wav" }) : null);
  }, [recording.wav]);
  const start = () => {
    setError("");
    setPreview(null);
    if (!name2.trim()) setName(availableRefName(state.refs));
    if (!text.trim()) setText(REFERENCE_SCRIPT);
    void recorder.current?.start();
  };
  const save = async (buffer, ext, fallback, recorded) => {
    const label = (name2.trim() || fallback).replace(/\.(wav|flac)$/i, "");
    if (!label || label.length > 100 || /[\u0000-\u001f\u007f/\\:*?"<>|]/.test(label) || /^[.\s]|[.\s]$/.test(label)) {
      setError("请填写有效的音色名（最多 100 个字符，不含路径或特殊符号）。");
      return;
    }
    if (state.refs.some((ref) => ref.label === label)) {
      setError("已经有同名音色，请换一个名字，避免覆盖之前的录音。");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const ok = await store.saveRef({ name: label, audio: base64(buffer), text, ext }, recorded ? engine : void 0);
      if (ok) {
        recorder.current?.cancel();
        setName("");
        setText("");
      }
    } catch (e) {
      setError(`保存失败：${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };
  const onFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/\.(wav|flac)$/i.test(file.name) || file.size > 32 * 1024 * 1024) {
      setError("请选择 32MB 以内的 WAV 或 FLAC 音频。");
      return;
    }
    try {
      await save(await file.arrayBuffer(), file.name.toLowerCase().endsWith(".flac") ? ".flac" : ".wav", file.name.replace(/\.[^.]+$/, ""), false);
    } catch (e) {
      setError(`读取失败：${e?.message ?? e}`);
    }
  };
  const stopPreview = () => {
    request.current++;
    setPreviewing("");
    setPreview(null);
  };
  const previewRef = async (ref) => {
    const id = ++request.current;
    setError("");
    setPreview(null);
    setPreviewing(ref.id);
    try {
      const result = await store.previewRef(ref.id, engine, sample, () => id === request.current);
      if (id !== request.current) return;
      setPreview({ blob: wavBlob(result.wav, result.mime), label: `${ref.label} · ${engines.find((e) => e.id === engine)?.label ?? engine} · 合成示例` });
    } catch (e) {
      if (id === request.current) setError(`试听失败：${e?.message ?? e}`);
    } finally {
      if (id === request.current) setPreviewing("");
    }
  };
  const button = (label, onClick, off = false) => (0, import_react2.createElement)(import_dsh_client_ui_primitives6.Button, { variant: "outline", size: "sm", disabled: off, onClick, children: label });
  const input = { ...S2.input, minWidth: 0 };
  return (0, import_react2.createElement)(
    "div",
    { style: S2.field, "data-voice-clone": "" },
    (0, import_react2.createElement)("h3", { style: S2.groupTitle }, "录制与克隆音色"),
    (0, import_react2.createElement)("p", { style: S2.groupHint }, "录一段清晰的单人声音，建议 3～10 秒，最多 20 秒。每段录音可以独立命名、保存和使用。"),
    (0, import_react2.createElement)("label", { style: S2.field }, "克隆引擎", (0, import_react2.createElement)(Select2, { value: engine, options: engines.map((e) => ({ value: e.id, label: e.label })), disabled: locked || capturing, onChange: (v) => {
      stopPreview();
      setChosenEngine(v);
    } })),
    !engine ? (0, import_react2.createElement)("div", { style: S2.hint }, "当前没有可用的克隆引擎，仍可录音并保存，安装引擎后再使用。") : null,
    (0, import_react2.createElement)("label", { style: S2.field }, "音色名", (0, import_react2.createElement)("input", { style: input, value: name2, maxLength: 100, disabled: locked || capturing, placeholder: "例如：我的声音、轻声朗读", onChange: (e) => setName(e.target.value) })),
    (0, import_react2.createElement)("label", { style: S2.field }, "参考文本（请按此朗读，也可以改成自己的内容）", (0, import_react2.createElement)("textarea", {
      style: { ...S2.input, minHeight: "72px", resize: "vertical" },
      value: text,
      disabled: locked || capturing,
      placeholder: REFERENCE_SCRIPT,
      onChange: (e) => setText(e.target.value)
    })),
    (0, import_react2.createElement)(
      "div",
      { style: S2.row },
      capturing ? button(recording.status === "starting" ? "取消等待麦克风" : "停止录制", () => recording.status === "starting" ? recorder.current?.cancel() : recorder.current?.stop()) : button(recording.wav ? "重新录制" : "开始录制", start, locked),
      recording.wav ? button(busy ? "保存中…" : engine ? "保存并使用音色" : "保存音色", () => {
        void save(recording.wav, ".wav", availableRefName(state.refs), true);
      }, locked) : null,
      recording.wav || capturing ? button("取消录音", () => recorder.current?.cancel(), busy) : null,
      !recording.wav && !capturing ? button("导入音频文件", () => fileRef.current?.click(), locked) : null,
      (0, import_react2.createElement)("input", { ref: fileRef, type: "file", accept: ".wav,.flac,audio/wav,audio/flac", disabled: locked || capturing, style: { display: "none" }, onChange: (e) => {
        void onFile(e);
      } })
    ),
    (0, import_react2.createElement)("div", { role: "status", style: S2.hint }, capturing ? `正在${recording.status === "starting" ? "等待麦克风权限" : "录制"} · ${recording.seconds.toFixed(1)} / 20 秒` : recording.wav ? `已录制 ${recording.seconds.toFixed(1)} 秒，可先听原录音，再保存音色。` : ""),
    raw ? (0, import_react2.createElement)(ClipPlayer, { blob: raw, label: "原录音" }) : null,
    error || recording.error ? (0, import_react2.createElement)("div", { role: "alert", style: { ...S2.banner, ...S2.bannerError } }, error || recording.error) : null,
    (0, import_react2.createElement)("label", { style: S2.field }, "示例文本", (0, import_react2.createElement)("textarea", { style: { ...S2.input, minHeight: "65px", resize: "vertical" }, maxLength: 200, value: sample, disabled: capturing || !!previewing, onChange: (e) => setSample(e.target.value) })),
    (0, import_react2.createElement)("div", { style: S2.hint }, "“使用并试听”会选用该音色，并朗读上面的示例文本。首次试听需加载模型，可能需要几十秒。"),
    previewing ? (0, import_react2.createElement)("div", { role: "status", style: S2.row }, "正在加载模型或合成示例…", button("取消试听", stopPreview)) : null,
    preview ? (0, import_react2.createElement)("div", null, (0, import_react2.createElement)(ClipPlayer, { blob: preview.blob, label: preview.label, autoPlay: true }), button("关闭试听", stopPreview)) : null,
    (0, import_react2.createElement)("div", { style: S2.row }, (0, import_react2.createElement)("strong", null, `已保存音色（${state.refs.length}）`), button("刷新列表", () => {
      void store.refreshRefs();
    }, locked || capturing)),
    state.refs.length === 0 ? (0, import_react2.createElement)("div", { style: S2.muted }, "还没有音色，录制或导入后会显示在这里。") : state.refs.map((ref) => (0, import_react2.createElement)(
      "div",
      { key: ref.id, style: { ...S2.refRow, flexWrap: "wrap" } },
      (0, import_react2.createElement)(
        "span",
        { style: { flex: "1 1 160px", overflowWrap: "anywhere" } },
        ref.label,
        state.value?.ttsEngine === engine && state.value?.ttsVoice?.[engine] === ref.id ? "（使用中）" : ""
      ),
      button("使用", () => {
        stopPreview();
        void store.useRef(ref.id, engine);
      }, locked || capturing || !engine),
      button("使用并试听", () => {
        void previewRef(ref);
      }, locked || capturing || !engine || !sample.trim()),
      button("删除", () => {
        stopPreview();
        void store.deleteRef(ref.label);
      }, locked || capturing)
    )),
    (0, import_react2.createElement)("details", { style: S2.details }, (0, import_react2.createElement)("summary", { style: S2.summary }, "音色存储位置"), (0, import_react2.createElement)("code", { style: S2.mono }, state.refDir || "（未知）"))
  );
}

// lib/client/settings-section.js
var import_dsh_client_ui_primitives7 = require("@deepseek-ai/dsh-client-ui-primitives");
var S = {
  root: { display: "flex", flexDirection: "column", gap: "18px", padding: "4px 2px 24px", fontSize: "13px", lineHeight: "1.55" },
  banner: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 10px",
    borderRadius: "8px",
    border: "1px solid var(--dsw-alias-border, rgba(127,127,127,0.28))",
    background: "var(--dsw-alias-bg-subtle, rgba(127,127,127,0.08))"
  },
  bannerError: { borderColor: "var(--dsw-alias-danger, #d33)", color: "var(--dsw-alias-danger, #d33)" },
  group: { display: "flex", flexDirection: "column", gap: "14px" },
  groupTitle: { fontSize: "14px", fontWeight: 600, margin: 0, letterSpacing: "0.02em" },
  groupHint: { opacity: 0.7, fontSize: "12px", margin: 0 },
  field: { display: "flex", flexDirection: "column", gap: "5px" },
  fieldHead: { display: "flex", alignItems: "center", gap: "8px", minHeight: "20px" },
  fieldLabel: { fontWeight: 500 },
  badge: {
    marginLeft: "6px",
    padding: "1px 5px",
    borderRadius: "4px",
    fontSize: "11px",
    background: "var(--dsw-alias-brand-weak, rgba(74,125,255,0.16))",
    color: "var(--dsw-alias-brand, #4a7dff)"
  },
  hint: { opacity: 0.68, fontSize: "12px" },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "5px 8px",
    borderRadius: "6px",
    border: "1px solid var(--dsw-alias-border, rgba(127,127,127,0.32))",
    background: "var(--dsw-alias-bg-layer-2, Canvas)",
    color: "var(--dsw-alias-label-primary, CanvasText)",
    colorScheme: "inherit",
    font: "inherit"
  },
  select: {
    width: "100%",
    boxSizing: "border-box",
    padding: "5px 8px",
    borderRadius: "6px",
    border: "1px solid var(--dsw-alias-border, rgba(127,127,127,0.32))",
    background: "var(--dsw-alias-bg-layer-2, Canvas)",
    color: "var(--dsw-alias-label-primary, CanvasText)",
    colorScheme: "inherit",
    font: "inherit"
  },
  row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  check: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" },
  checkGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "6px 12px" },
  details: { border: "1px solid var(--dsw-alias-border, rgba(127,127,127,0.24))", borderRadius: "8px", padding: "8px 10px" },
  summary: { cursor: "pointer", fontSize: "12px", opacity: 0.85 },
  detailsBody: { display: "flex", flexDirection: "column", gap: "14px", paddingTop: "12px" },
  footer: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", borderTop: "1px solid var(--dsw-alias-border, rgba(127,127,127,0.24))", paddingTop: "12px" },
  mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", wordBreak: "break-all" },
  refRow: { display: "flex", alignItems: "center", gap: "8px", padding: "4px 0" },
  muted: { opacity: 0.6, fontSize: "12px" }
};
var ENGINE_OPTIONS = [
  { value: "auto", label: "自动（优先本地模型，不可用才退回浏览器识别）" },
  { value: "native", label: "只用本地模型（质量最好，占显存）" },
  { value: "browser", label: "只用浏览器识别（不占显存，中文一般）" }
];
var NATIVE_BACKEND_OPTIONS = [
  { value: "zipformer", label: "zipformer（sherpa-onnx，最省显存，只认中文）" },
  { value: "qwen", label: "Qwen3-ASR（30 种语言，自动检测，约 4.8GB 显存）" },
  { value: "whisper", label: "faster-whisper（多语言，CPU 也能跑）" }
];
var DEVICE_OPTIONS = [
  { value: "cuda", label: "GPU（cuda，快）" },
  { value: "cpu", label: "CPU（不占显存，慢很多）" }
];
function Field({ label, hint, overridden, onReset, disabled, children }) {
  return (0, import_react3.createElement)(
    "div",
    { style: S.field },
    (0, import_react3.createElement)(
      "div",
      { style: S.fieldHead },
      (0, import_react3.createElement)(
        "span",
        { style: S.fieldLabel },
        label,
        overridden ? (0, import_react3.createElement)("span", { style: S.badge, title: "这一项被你改过，不再是配置文件的默认值" }, "已改") : null
      ),
      overridden && onReset ? (0, import_react3.createElement)(import_dsh_client_ui_primitives7.Button, { variant: "ghost", size: "sm", disabled, onClick: onReset, title: "恢复这一项的默认值", children: "恢复默认" }) : null
    ),
    children,
    hint ? (0, import_react3.createElement)("div", { style: S.hint }, hint) : null
  );
}
function Select({ value, options, onChange, disabled }) {
  return (0, import_react3.createElement)("select", {
    style: S.select,
    value: value === void 0 || value === null ? "" : String(value),
    disabled: disabled === true,
    onChange: (event) => onChange(event.target.value)
  }, options.map((option) => (0, import_react3.createElement)("option", {
    key: String(option.value),
    value: String(option.value),
    style: { background: "var(--dsw-alias-bg-layer-2, Canvas)", color: "var(--dsw-alias-label-primary, CanvasText)" }
  }, option.label)));
}
function Check({ checked, onChange, label, disabled }) {
  return (0, import_react3.createElement)(
    "label",
    { style: S.check },
    (0, import_react3.createElement)("input", {
      type: "checkbox",
      checked: checked === true,
      disabled: disabled === true,
      onChange: (event) => onChange(event.target.checked)
    }),
    (0, import_react3.createElement)("span", null, label)
  );
}
function TextInput({ value, onCommit, disabled, placeholder, type = "text", min, max, step }) {
  const [draft, setDraft] = (0, import_react3.useState)(value === void 0 || value === null ? "" : String(value));
  const editing = (0, import_react3.useRef)(false);
  (0, import_react3.useEffect)(() => {
    if (!editing.current)
      setDraft(value === void 0 || value === null ? "" : String(value));
  }, [value]);
  const commit = () => {
    const next = draft;
    if (next === String(value ?? ""))
      return;
    onCommit(type === "number" ? Number(next) : next);
  };
  return (0, import_react3.createElement)("input", {
    type,
    value: draft,
    disabled: disabled === true,
    placeholder,
    min,
    max,
    step,
    style: S.input,
    onFocus: () => {
      editing.current = true;
    },
    onChange: (event) => setDraft(event.target.value),
    onBlur: () => {
      editing.current = false;
      commit();
    },
    onKeyDown: (event) => {
      if (event.key === "Enter")
        event.currentTarget.blur();
      if (event.key === "Escape") {
        editing.current = false;
        setDraft(value === void 0 || value === null ? "" : String(value));
        event.currentTarget.blur();
      }
    }
  });
}
function actions(store) {
  return {
    set: (field, value) => {
      void store.set(field, value);
    },
    reset: (field) => {
      void store.resetField(field);
    },
    resetAll: () => {
      void store.resetAll();
    }
  };
}
function VoiceSettingsSection(props) {
  const state = props.useSettings((value2) => value2);
  const store = props.store;
  const act = actions(store);
  const disabled = state.writable !== true || state.saving === true;
  const value = state.value ?? {};
  const overridden = new Set(state.overridden);
  const isOverridden = (field) => overridden.has(field);
  const languageOptions = state.languages.length > 0 ? state.languages : [{ value: "auto", label: "自动检测（推荐）" }];
  const instructChoices = Array.isArray(state.instructLanguages) ? state.instructLanguages : [];
  const instructOptions = instructChoices.length > 0 ? instructChoices : [{ value: "auto", label: "不指定（保持原样,最快）" }];
  const allEngines = state.engineChoices ?? [];
  const visibleEngines = Array.isArray(value.ttsVisibleEngines) && value.ttsVisibleEngines.length > 0 ? value.ttsVisibleEngines : allEngines.map((engine) => engine.id);
  const cloneEngines = allEngines.filter((engine) => engine.voiceKind !== "preset");
  const voices = value.ttsVoice !== null && typeof value.ttsVoice === "object" ? value.ttsVoice : {};
  const engineLabel = (id) => allEngines.find((engine) => engine.id === id)?.label ?? id;
  const engineOptions = allEngines.filter((engine) => engine.id === value.ttsEngine || visibleEngines.includes(engine.id)).map((engine) => ({
    value: engine.id,
    label: engineLabel(engine.id) + (engine.installed === false ? "（未安装）" : "") + (visibleEngines.includes(engine.id) ? "" : "（已隐藏，实际会用第一个可见引擎）")
  }));
  const toggleEngine = (id, on) => {
    const next = on ? [...visibleEngines, id] : visibleEngines.filter((item) => item !== id);
    if (next.length === 0) {
      return;
    }
    act.set("ttsVisibleEngines", next);
  };
  const setEngineVoice = (engine, voice) => {
    const next = { ...voices };
    if (voice === "") delete next[engine];
    else next[engine] = voice;
    act.set("ttsVoice", next);
  };
  return (0, import_react3.createElement)(
    "div",
    { style: S.root, className: "dsh-voice-settings" },
    (0, import_react3.createElement)("style", null, ".dsh-voice-settings { color-scheme: inherit; } body[data-ds-dark-theme] .dsh-voice-settings { color-scheme: dark; } body:not([data-ds-dark-theme]) .dsh-voice-settings { color-scheme: light; }"),
    state.status === "loading" ? (0, import_react3.createElement)("div", { style: S.banner }, "正在读取语音设置…") : null,
    state.writable !== true && state.status !== "loading" ? (0, import_react3.createElement)(
      "div",
      { style: S.banner },
      (0, import_react3.createElement)("span", null, "这个部署没有可写的设置文档（settings provider 未装载或处于 memory 模式），下面显示的是当前实际生效的值。要修改请编辑 cordis.patch.yml 后重启。")
    ) : null,
    state.error ? (0, import_react3.createElement)("div", { style: { ...S.banner, ...S.bannerError } }, state.error) : null,
    // host 注册命名空间失败:通常是用户手改 settings.yaml 的 voice 段打错了
    // 一个字。必须把原文（含字段路径与期待取值）摆出来,否则这个面板只会
    // 静静地显示一份默认值,用户完全不知道发生了什么。
    state.settingsError ? (0, import_react3.createElement)(
      "div",
      { style: { ...S.banner, ...S.bannerError, flexDirection: "column", alignItems: "flex-start" } },
      (0, import_react3.createElement)("strong", null, "设置文档里的 voice 段有不合法的值,这一页读不到它"),
      (0, import_react3.createElement)("code", { style: S.mono }, state.settingsError),
      (0, import_react3.createElement)(
        "span",
        { style: S.muted },
        "下面显示的是配置文件（cordis.patch.yml）里那一层加上默认值。请按上面的提示改掉 settings.yaml 里对应的那一项,然后重启;改完之前这个页面里改什么都不算数。"
      )
    ) : null,
    state.note && !state.error ? (0, import_react3.createElement)("div", { style: S.banner }, state.note) : null,
    // ---- 语音输入(STT)----
    (0, import_react3.createElement)(
      "div",
      { style: S.group },
      (0, import_react3.createElement)("h3", { style: S.groupTitle }, "语音输入（STT）"),
      (0, import_react3.createElement)("p", { style: S.groupHint }, "麦克风按钮用哪个模型、认什么语言。改语言不用重启,下一句录音就生效;换模型会重建识别子进程(下一次点麦克风时)。"),
      (0, import_react3.createElement)(Field, {
        label: "语音输入方式",
        overridden: isOverridden("engine"),
        onReset: () => act.reset("engine"),
        disabled
      }, (0, import_react3.createElement)(Select, { value: value.engine, options: ENGINE_OPTIONS, disabled, onChange: (v) => act.set("engine", v) })),
      (0, import_react3.createElement)(Field, {
        label: "本地识别模型",
        hint: "只有「语音输入方式」用到本地模型时才会加载。换这项会重建子进程,约几秒到几十秒。",
        overridden: isOverridden("nativeBackend"),
        onReset: () => act.reset("nativeBackend"),
        disabled
      }, (0, import_react3.createElement)(Select, { value: value.nativeBackend, options: NATIVE_BACKEND_OPTIONS, disabled, onChange: (v) => act.set("nativeBackend", v) })),
      (0, import_react3.createElement)(Field, {
        label: "识别语言",
        hint: "默认让模型自己判断。口音重、或者中英混说时,指定语言会更稳。注意这不会翻译 —— 说什么语言就转写什么语言。",
        overridden: isOverridden("asrLanguage"),
        onReset: () => act.reset("asrLanguage"),
        disabled
      }, (0, import_react3.createElement)(Select, { value: value.asrLanguage, options: languageOptions, disabled, onChange: (v) => act.set("asrLanguage", v) })),
      (0, import_react3.createElement)(Field, {
        label: "识别设备",
        overridden: isOverridden("asrDevice"),
        onReset: () => act.reset("asrDevice"),
        disabled
      }, (0, import_react3.createElement)(Select, { value: value.asrDevice, options: DEVICE_OPTIONS, disabled, onChange: (v) => act.set("asrDevice", v) })),
      (0, import_react3.createElement)(Field, {
        label: "开关麦克风的快捷键",
        hint: "写法如 alt+m、ctrl+shift+space。改完立刻生效,不用重启。",
        overridden: isOverridden("hotkey"),
        onReset: () => act.reset("hotkey"),
        disabled
      }, (0, import_react3.createElement)(TextInput, { value: value.hotkey, disabled, placeholder: "alt+m", onCommit: (v) => act.set("hotkey", v) })),
      (0, import_react3.createElement)(
        "details",
        { style: S.details },
        (0, import_react3.createElement)("summary", { style: S.summary }, "高级：模型路径与录音灵敏度"),
        (0, import_react3.createElement)(
          "div",
          { style: S.detailsBody },
          (0, import_react3.createElement)(Field, {
            label: "静音判定阈值",
            hint: "越高越不容易把环境噪声当人声,太高会吃字头。默认 0.006。",
            overridden: isOverridden("vadThreshold"),
            onReset: () => act.reset("vadThreshold"),
            disabled
          }, (0, import_react3.createElement)(TextInput, { value: value.vadThreshold, type: "number", step: "0.001", min: "0", disabled, onCommit: (v) => act.set("vadThreshold", v) })),
          (0, import_react3.createElement)(Field, {
            label: "尾巴补录秒数",
            hint: "停止说话后再多录这么久,避免最后一个字被切掉。",
            overridden: isOverridden("tailPadSeconds"),
            onReset: () => act.reset("tailPadSeconds"),
            disabled
          }, (0, import_react3.createElement)(TextInput, { value: value.tailPadSeconds, type: "number", step: "0.05", min: "0", disabled, onCommit: (v) => act.set("tailPadSeconds", v) })),
          (0, import_react3.createElement)(Field, {
            label: "ASR 用的 Python",
            hint: "跑识别子进程的解释器,必须带 torch 与对应后端库。",
            overridden: isOverridden("pythonExecutable"),
            onReset: () => act.reset("pythonExecutable"),
            disabled
          }, (0, import_react3.createElement)(TextInput, { value: value.pythonExecutable, disabled, onCommit: (v) => act.set("pythonExecutable", v) })),
          (0, import_react3.createElement)(Field, {
            label: "Qwen3-ASR 模型目录",
            overridden: isOverridden("qwenModelDir"),
            onReset: () => act.reset("qwenModelDir"),
            disabled
          }, (0, import_react3.createElement)(TextInput, { value: value.qwenModelDir, disabled, onCommit: (v) => act.set("qwenModelDir", v) })),
          (0, import_react3.createElement)(Field, {
            label: "faster-whisper 模型目录",
            overridden: isOverridden("whisperModelDir"),
            onReset: () => act.reset("whisperModelDir"),
            disabled
          }, (0, import_react3.createElement)(TextInput, { value: value.whisperModelDir, disabled, onCommit: (v) => act.set("whisperModelDir", v) })),
          (0, import_react3.createElement)(Field, {
            label: "zipformer 模型根目录 / 子目录名",
            overridden: isOverridden("modelDir") || isOverridden("asrDir"),
            onReset: () => {
              act.reset("modelDir");
              act.reset("asrDir");
            },
            disabled
          }, (0, import_react3.createElement)(
            "div",
            { style: S.row },
            (0, import_react3.createElement)("div", { style: { flex: "1 1 auto" } }, (0, import_react3.createElement)(TextInput, { value: value.modelDir, disabled, onCommit: (v) => act.set("modelDir", v) })),
            (0, import_react3.createElement)("div", { style: { flex: "0 0 140px" } }, (0, import_react3.createElement)(TextInput, { value: value.asrDir, disabled, onCommit: (v) => act.set("asrDir", v) }))
          ))
        )
      )
    ),
    // ---- 朗读(TTS)----
    (0, import_react3.createElement)(
      "div",
      { style: S.group },
      (0, import_react3.createElement)("h3", { style: S.groupTitle }, "朗读（TTS）"),
      (0, import_react3.createElement)("p", { style: S.groupHint }, "助手回复的自动朗读。引擎同一时刻只有一个驻留显存,换引擎会先卸载旧的再加载新的。"),
      (0, import_react3.createElement)(Field, {
        label: "默认引擎",
        hint: '朗读面板里的选择会写回这一项,所以"上次用的引擎"重启后还在。',
        overridden: isOverridden("ttsEngine"),
        onReset: () => act.reset("ttsEngine"),
        disabled
      }, (0, import_react3.createElement)(Select, {
        value: value.ttsEngine,
        disabled,
        options: engineOptions,
        onChange: (v) => act.set("ttsEngine", v)
      })),
      (0, import_react3.createElement)(Field, {
        label: "朗读面板里显示哪些引擎",
        hint: "只影响下拉里出现什么,不影响能力:被藏起来的引擎照样能用,只是不在面板里出现。至少留一个。",
        overridden: isOverridden("ttsVisibleEngines"),
        onReset: () => act.reset("ttsVisibleEngines"),
        disabled
      }, (0, import_react3.createElement)("div", { style: S.checkGrid }, allEngines.map((engine) => (0, import_react3.createElement)(Check, {
        key: engine.id,
        checked: visibleEngines.includes(engine.id),
        disabled,
        label: engine.label + (engine.installed === false ? "（未安装）" : ""),
        onChange: (on) => toggleEngine(engine.id, on)
      })))),
      (0, import_react3.createElement)(Field, {
        label: "朗读设备",
        overridden: isOverridden("ttsDevice"),
        onReset: () => act.reset("ttsDevice"),
        disabled
      }, (0, import_react3.createElement)(Select, { value: value.ttsDevice, options: DEVICE_OPTIONS, disabled, onChange: (v) => act.set("ttsDevice", v) })),
      (0, import_react3.createElement)(Field, {
        label: "自动朗读",
        hint: "回复写完后自动朗读。与聊天区的“自动朗读新回复”开关同步，修改会保存。",
        overridden: isOverridden("ttsAutoRead"),
        onReset: () => act.reset("ttsAutoRead"),
        disabled
      }, (0, import_react3.createElement)(Check, { checked: value.ttsAutoRead === true, disabled, label: "回复写完后自动朗读", onChange: (v) => act.set("ttsAutoRead", v) })),
      (0, import_react3.createElement)(Field, {
        label: "朗读语言",
        hint: "只对 CosyVoice 3 生效:让模型用指定语言朗读,而且**原始阿拉伯数字也会按该语言读出来**(3,5、2026 都读对),所以不必再把数字写成单词。它不会覆盖中文文本 —— 中文回复照旧读中文,可以一直开着。代价是每次合成要重算声纹,比原来慢一点。",
        overridden: isOverridden("ttsInstructLanguage"),
        onReset: () => act.reset("ttsInstructLanguage"),
        disabled
      }, (0, import_react3.createElement)(Select, {
        value: value.ttsInstructLanguage,
        options: instructOptions,
        disabled,
        onChange: (v) => act.set("ttsInstructLanguage", v)
      })),
      (0, import_react3.createElement)(Field, {
        label: "自定义朗读指令",
        hint: "留空就用上面选的语言。写在这里的会原样交给模型,可以用来要求口音、语气或情绪;助手前缀与结尾标记会自动补全,不用自己写。",
        overridden: isOverridden("ttsInstructText"),
        onReset: () => act.reset("ttsInstructText"),
        disabled
      }, (0, import_react3.createElement)(TextInput, {
        value: value.ttsInstructText,
        disabled,
        placeholder: "例如:请用轻快的语气朗读下面这句话",
        onCommit: (v) => act.set("ttsInstructText", v)
      })),
      cloneEngines.length > 0 ? (0, import_react3.createElement)(Field, {
        label: "克隆引擎的音色",
        hint: "值来自上面的参考音频目录。改了之后,那个引擎下次加载就会用它;如果它正驻留显存,会立刻切过去。",
        overridden: isOverridden("ttsVoice"),
        onReset: () => act.reset("ttsVoice"),
        disabled
      }, cloneEngines.map((engine) => (0, import_react3.createElement)(
        "div",
        { key: engine.id, style: S.row },
        (0, import_react3.createElement)("span", { style: { flex: "0 0 140px" } }, engine.label),
        (0, import_react3.createElement)("div", { style: { flex: "1 1 auto" } }, (0, import_react3.createElement)(Select, {
          value: voices[engine.id] ?? "",
          disabled,
          options: [
            { value: "", label: "（引擎默认音色）" },
            ...state.refs.map((ref) => ({ value: ref.id, label: ref.label }))
          ],
          onChange: (v) => setEngineVoice(engine.id, v)
        }))
      ))) : null,
      (0, import_react3.createElement)(CloneVoiceBlock, { styles: S, Select, state, disabled, store }),
      (0, import_react3.createElement)(
        "details",
        { style: S.details },
        (0, import_react3.createElement)("summary", { style: S.summary }, "高级：安装路径与文本规范化"),
        (0, import_react3.createElement)(
          "div",
          { style: S.detailsBody },
          (0, import_react3.createElement)(Field, {
            label: "引擎安装根目录",
            hint: "每个引擎有独立 venv,路径不通用。改了会重建 TTS 进程。",
            overridden: isOverridden("ttsRoot"),
            onReset: () => act.reset("ttsRoot"),
            disabled
          }, (0, import_react3.createElement)(TextInput, { value: value.ttsRoot, disabled, onCommit: (v) => act.set("ttsRoot", v) })),
          (0, import_react3.createElement)(Field, {
            label: "模型权重根目录",
            overridden: isOverridden("ttsModelsRoot"),
            onReset: () => act.reset("ttsModelsRoot"),
            disabled
          }, (0, import_react3.createElement)(TextInput, { value: value.ttsModelsRoot, disabled, onCommit: (v) => act.set("ttsModelsRoot", v) })),
          (0, import_react3.createElement)(Field, {
            label: "参考音频目录",
            overridden: isOverridden("ttsRefDir"),
            onReset: () => act.reset("ttsRefDir"),
            disabled
          }, (0, import_react3.createElement)(TextInput, { value: value.ttsRefDir, disabled, onCommit: (v) => act.set("ttsRefDir", v) })),
          (0, import_react3.createElement)(Field, {
            label: "文本规范化脚本",
            overridden: isOverridden("ttsTextnormPath"),
            onReset: () => act.reset("ttsTextnormPath"),
            disabled
          }, (0, import_react3.createElement)(TextInput, { value: value.ttsTextnormPath, disabled, onCommit: (v) => act.set("ttsTextnormPath", v) })),
          (0, import_react3.createElement)(Field, {
            label: "跑脚本的解释器",
            overridden: isOverridden("ttsPrepPython"),
            onReset: () => act.reset("ttsPrepPython"),
            disabled
          }, (0, import_react3.createElement)(TextInput, { value: value.ttsPrepPython, disabled, onCommit: (v) => act.set("ttsPrepPython", v) }))
        )
      )
    ),
    (0, import_react3.createElement)(
      "div",
      { style: S.footer },
      (0, import_react3.createElement)(import_dsh_client_ui_primitives7.Button, {
        variant: "outline",
        size: "sm",
        disabled,
        onClick: act.resetAll,
        children: "全部恢复默认"
      }),
      (0, import_react3.createElement)(
        "span",
        { style: S.muted },
        state.overridden.length === 0 ? "所有设置都还是配置文件里的值。" : `有 ${state.overridden.length} 项被改过（带「已改」标记），点上面可以整体清回配置文件的值。`
      ),
      state.saving ? (0, import_react3.createElement)("span", { style: S.muted }, "保存中…") : null
    )
  );
}

// lib/client/index.js
var VOICE_NAMESPACE = "voice";
var name = "dsh-voice";
var inject = ["sessions", "slots", "connection"];
function apply(ctx, config = {}) {
  ctx.effect(() => installMessageActions(), "dsh-voice: historical message actions");
  let boundScope = null;
  const clientConfig = {
    engine: isVoiceEngine(config.engine) ? config.engine : DEFAULTS.engine,
    hotkey: typeof config.hotkey === "string" && config.hotkey.trim() !== "" ? config.hotkey : DEFAULTS.hotkey
  };
  const configEvents = new Emitter();
  const runtime = new VoiceRuntime(ctx, { engine: clientConfig.engine });
  let disposed = false;
  ctx.effect(() => () => {
    disposed = true;
    runtime.dispose();
  }, "dsh-voice: microphone lifetime");
  const listeningSource = {
    getSnapshot: () => runtime.isListening(),
    subscribe: (cb) => runtime.subscribe(cb)
  };
  const startingSource = {
    getSnapshot: () => runtime.isStarting(),
    subscribe: (cb) => runtime.subscribe(cb)
  };
  const partialSource = {
    getSnapshot: () => runtime.getPartial(),
    subscribe: (cb) => runtime.subscribe(cb)
  };
  const hotkeySource = {
    getSnapshot: () => hotkeyLabel(clientConfig.hotkey),
    subscribe: (cb) => configEvents.on(cb)
  };
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
    name: "conversation.input.left",
    id: "voice-mic",
    order: 0,
    inject: (sessionId) => ({
      onToggle: () => {
        void runtime.toggleMic(sessionId).catch((err) => {
          console.error("dsh-voice mic:", err);
        });
      },
      hooks: { listening: listeningSource, starting: startingSource, partial: partialSource, hotkey: hotkeySource }
    })
  }, MicButton));
  let hotkey = parseHotkey(clientConfig.hotkey);
  ctx.effect(() => {
    const onKey = (event) => {
      if (hotkey === null)
        return;
      if (event.ctrlKey !== hotkey.ctrl || event.altKey !== hotkey.alt || event.shiftKey !== hotkey.shift)
        return;
      if (event.code !== hotkey.code)
        return;
      const target = event.target;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable))
        return;
      event.preventDefault();
      const current = ctx.sessions.list.getSnapshot().current;
      if (current === void 0)
        return;
      void runtime.toggleMic(current).catch((err) => {
        console.error("dsh-voice mic:", err);
      });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, "dsh-voice: global hotkey");
  const voice = createVoiceService((channel, endpoint, payload) => ctx.connection.rpc.call(channel, endpoint, payload));
  const tts = new TtsController({
    rpc: (channel, endpoint, payload) => ctx.connection.rpc.call(channel, endpoint, payload),
    sessions: ctx.sessions,
    log: (message) => console.warn("dsh-voice tts:", message)
  });
  ctx.effect(() => () => {
    tts.dispose();
  }, "dsh-voice: read-aloud lifetime");
  ctx.effect(() => installSelectionReader(tts), "dsh-voice: selected passage read-aloud");
  void tts.start();
  ctx.effect(() => {
    const sync = () => tts.bindSession(ctx.sessions.list.getSnapshot().current);
    sync();
    return ctx.sessions.list.subscribe(sync);
  }, "dsh-voice: read-aloud session binding");
  ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
    name: "conversation.chat.assistant-actions",
    id: "voice-speak",
    order: 20,
    label: "朗读",
    inject: (sessionId) => ({
      onSpeak: (messageId) => {
        void tts.speakMessage(sessionId, messageId);
      },
      hooks: { tts }
    })
  }, SpeakButton));
  ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
    name: "conversation.input.right",
    id: "voice-tts",
    order: 50,
    label: "朗读设置",
    inject: () => ({
      onSelect: (engine) => {
        void tts.select(engine);
      },
      onUnload: () => {
        void tts.unload();
      },
      onAutoRead: (enabled) => {
        if (settingsStore.getSnapshot().writable) void settingsStore.set("ttsAutoRead", enabled);
        else tts.setAutoRead(enabled);
      },
      onSetVoice: (v) => {
        void tts.setVoice(v);
      },
      onLoadVoices: () => {
        void tts.loadVoices(tts.state.preferred ?? void 0);
      },
      hooks: { tts }
    })
  }, TtsPicker));
  const settingsStore = new VoiceSettingsStore({
    bindScope: () => boundScope,
    onVoiceSelected: () => tts.refreshConfig(),
    rpc: (channel, endpoint, payload) => ctx.connection.rpc.call(channel, endpoint, payload),
    log: (message) => console.warn("dsh-voice settings:", message)
  });
  ctx.inject(["settingsScope"], (scoped) => {
    boundScope = scoped.settingsScope.bind({ namespace: VOICE_NAMESPACE });
    settingsStore.attachScope(boundScope);
    const syncAutoRead = () => {
      const enabled = boundScope?.getSnapshot()?.value?.ttsAutoRead;
      if (typeof enabled === "boolean") tts.setAutoRead(enabled);
    };
    const unsubscribe = boundScope.subscribe(syncAutoRead);
    syncAutoRead();
    return () => {
      unsubscribe();
      boundScope = null;
      settingsStore.attachScope(null);
    };
  });
  ctx.effect(() => () => settingsStore.dispose(), "dsh-voice: settings page lifetime");
  void settingsStore.start();
  const settingsSource = {
    getSnapshot: () => settingsStore.getSnapshot(),
    subscribe: (cb) => settingsStore.subscribe(cb)
  };
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "voice",
    // 40 排在模型(10)之后,但仍在插件配置页之前:语音是常用设置,
    // 但不如模型选择那么"每次都要动"。
    order: 40,
    label: () => "语音",
    inject: () => ({
      store: settingsStore,
      hooks: { settings: settingsSource }
    })
  }, VoiceSettingsSection));
  void voice.fetchConfig().then((remote) => {
    if (disposed) return;
    if (isVoiceEngine(remote.engine)) {
      clientConfig.engine = remote.engine;
      runtime.setEngine(remote.engine);
    }
    if (typeof remote.hotkey === "string" && remote.hotkey.trim() !== "" && remote.hotkey !== clientConfig.hotkey) {
      clientConfig.hotkey = remote.hotkey;
      hotkey = parseHotkey(remote.hotkey);
      configEvents.emit();
    }
  }).catch((err) => {
    console.warn("dsh-voice: /voice.config 不可用,使用 client 默认配置", err);
  });
}
return module.exports;}});
