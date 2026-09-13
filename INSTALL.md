# 安装与运行时配置

插件代码与模型运行时分开管理。默认目录如下，均在仓库外：

```text
~/.dsh/voice/
  tts/
    kokoro/venv/bin/python
    cosyvoice/venv/bin/python
    cosyvoice/repo/
    indextts/venv/bin/python
    indextts/repo/
    hf/                         # Kokoro 的 Hugging Face 缓存
  models/tts/
    cosyvoice/CosyVoice2-0.5B/
    cosyvoice/Fun-CosyVoice3-0.5B/
    cosyvoice/wetext/
    indextts/checkpoints/
```

通过 `DSH_VOICE_HOME` 改整个数据根目录，或设置 `DSH_VOICE_TTS_ROOT`、`DSH_VOICE_MODELS_ROOT`。启动 DSH 时这些环境变量必须可见。也可在 DSH 语音设置中填 `ttsRoot`、`ttsModelsRoot`；路径使用展开后的绝对路径，不要依赖 YAML 自动展开 `~`。

## 语音输入

**Zipformer 中文识别**：

```bash
dsh plugin --profile web add sherpa-onnx-node
node tools/download-models.cjs "$HOME/.dsh/voice/models/asr"
```

在设置中将 `nativeBackend` 设为 `zipformer`，`modelDir` 指向上述 `models/asr`。下载器只在手动执行时下载公开模型，默认来源 Hugging Face，可用 `HF_ENDPOINT` 指定镜像。

**Whisper 多语言识别**：创建单独 Python 环境，安装 `faster-whisper` 和 `numpy`，从其支持的模型来源下载 CTranslate2 格式权重。在设置中选择 `whisper`，填写 `pythonExecutable`、`whisperModelDir` 和 `asrDevice`。CPU 可用，但延迟取决于模型大小。

**Qwen ASR**：创建与 Qwen ASR 兼容的 Python/PyTorch 环境，安装 `qwen-asr`，下载 Qwen3-ASR 权重。设置 `nativeBackend: qwen`、`pythonExecutable`、`qwenModelDir`。`python/requirements-asr.txt` 列出可选识别依赖；无需为了 Whisper 安装 Qwen。

## 语音输出

各引擎的 Torch、Transformers 依赖可能冲突，使用上面的独立环境布局。仓库不会自动安装 CUDA、引擎源码或模型。

- **Kokoro**：在 `tts/kokoro/venv` 中安装 Kokoro 与所需中英文语音前端，准备 espeak-ng。使用 `HF_HOME` 指向 `tts/hf`，预先缓存 `hexgrad/Kokoro-82M` 和 `hexgrad/Kokoro-82M-v1.1-zh` 的模型及所选音色。worker 使用本地缓存，不接受 `--model-dir`。
- **CosyVoice 2/3**：将 [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) 源码与子模块放到 `tts/cosyvoice/repo`，按照该版本的安装说明准备 `tts/cosyvoice/venv`，把模型放入上述对应目录。两个引擎共享代码和环境。安装 `soundfile`；仓库自带 `cv_compat.py` 处理音频读写及可选本地 WeText 模型。完整参考转写有助于零样本克隆；法语等语言可在语音设置中选择朗读语言。
- **IndexTTS**：将 [IndexTTS](https://github.com/index-tts/index-tts) 源码放到 `tts/indextts/repo`，使用包含 `IndexTTS2` 接口的兼容版本，按其依赖说明准备环境和 checkpoints。引擎默认参考音色来自外部仓库示例，也可在设置面板录制自己的音色。

需要 GPU 的配置应使用适合本机显卡的 PyTorch/CUDA 组合。`ttsDevice` 支持 `cpu` / `cuda`，但具体模型的 CPU 兼容性和速度由其实现决定。面板列出的性能数字仅作参考，不代表每台机器的保证。

安装完成后，在设置中选中引擎并点击试听。缺少解释器、模型或参考音色时，会显示对应错误；仅打开页面不会加载模型。

## 测试

默认 Node 测试使用模拟推理和合成数据，文本预处理测试不需要 GPU。Python worker 冒烟测试可通过 `DSH_VOICE_TEST_PYTHON` 指向安装了 `numpy` 的解释器；参考文件测试可额外设置 `DSH_VOICE_TEST_REFERENCE` 指向另外获取的 CosyVoice 官方 `asset/zero_shot_prompt.wav`（并配置相应运行时根目录）。这些环境变量和文件不会被写入仓库。
