# DSH Voice

DSH Web 的本地语音输入、回复朗读和命名音色克隆插件。本仓库基于 MIT 许可的 `@nn12138/dsh-voice` 扩展，保留原插件标识，方便替换安装。

- **语音输入**：支持 Qwen ASR、faster-whisper、Zipformer；识别结果写入输入框草稿，由你确认发送。
- **语音输出**：Kokoro、CosyVoice 2/3、IndexTTS；支持自动朗读新回复、手动朗读历史回复、选中段落朗读和停止。
- **音色克隆**：在设置面板录音、命名、保存多个音色，回放原录音并试听合成示例。
- **主题适配**：语音设置下拉框和选段按钮跟随 DSH 的暗色/亮色主题。
- **文本完整性**：保留加粗正文、法语重音和撇号，清理装饰表情，避免截断单词；自动朗读排队，合成失败有提示。

## 安装

需要 Node.js 22.19+ 或 24+、Python 3.10+，以及已安装的 DSH。Web 接口适配 DSH 0.1.5 系列；其他宿主版本需验证槽位和会话事件兼容性。

```bash
git clone https://github.com/chenmzh/dsh-voice.git
cd dsh-voice
npm ci
npm test
npm run test:textnorm
mkdir -p /tmp/dsh-voice-pack
npm pack --pack-destination /tmp/dsh-voice-pack
dsh plugin --profile web add /tmp/dsh-voice-pack/nn12138-dsh-voice-0.3.0.tgz
```

仓库是私有的，克隆时需要具有访问权限的 GitHub 身份。插件安装不包含模型、Python 推理环境或个人音色；请按 [安装与运行时配置](INSTALL.md) 配置所需引擎。

本仓库设置了 `private: true`，防止意外发布到 npm；仍可本地打包并安装到 DSH。不要与原插件重复安装到同一 profile。

## 使用

1. 打开 DSH 的“设置 → 语音”，选择已配置的语音输入后端、语言、朗读引擎和音色。
2. 点击麦克风录入草稿；确认内容后自行发送。
3. 点击回复的小喇叭朗读，或启用“自动朗读新回复”。选中回复的一部分后点击“朗读所选”。
4. 使用克隆引擎时，在设置中录制参考音频，命名并保存。录音需至少 3 秒，最长 20 秒；可录制多个音色。

整条回复朗读会略过 Markdown 代码块和表格；选段朗读读取选中的可见正文。模型仍可能出现发音或个别词错误，文本完整性检查不能替代语音质量验证。

## 开发与隐私

```bash
npm run build:client
npm test
npm run test:textnorm
npm run check:privacy
node tools/check-privacy.mjs --staged
```

`lib/client/` 和 `lib/core/` 是可维护源码；`lib/client.js` 是生成的 DSH 浏览器入口。文本预处理及兼容辅助代码放在 `python/`，不依赖某台机器的目录。

本仓库只保存源码、合成测试和说明，**不含个人录音、克隆音色、聊天记录、账号配置、密钥或模型权重**。隐私检查会拒绝媒体文件和可疑内容；具体数据流与保护范围见 [PRIVACY.md](PRIVACY.md)。

许可见 [LICENSE](LICENSE)。引擎源码、模型权重和各自示例音频属于独立项目，需另行获取并遵守其许可。
