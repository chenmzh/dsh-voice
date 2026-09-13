"""Private JSON-lines TTS worker: stdin requests only, stdout protocol only.

Sibling of ``worker.py`` (ASR). Same contract, opposite direction: this process
keeps ONE TTS model resident in VRAM and answers many synthesis requests, so the
5-40 s model load is paid once per engine switch instead of once per sentence.

Why a resident process at all: the four engines under ``.runtime/tts/<engine>/``
ship CLI scripts whose logic lives inside ``main()``, so every invocation reloads
the model (Kokoro 5.4 s, CosyVoice 7-24 s, IndexTTS 24-40 s). That
is fine for a batch bake-off and useless for reading an assistant reply aloud.
The engine's *proven* synthesis call sequence is reimplemented here verbatim;
the only change is that it runs against a model object that stays loaded.

Protocol (one JSON object per line on stdout, nothing else):
    startup   {"ready": true, "engine": ..., "sampleRate": ..., "loadSeconds": ...,
               "voices": [...], "voice": ..., "device": ...}
              or {"ready": false, "error": ...} then exit 1
    requests  {"id":N,"cmd":"load"} | {"id":N,"cmd":"voices"} |
              {"id":N,"cmd":"setVoice","voice":NAME} | {"id":N,"cmd":"stats"} |
              {"id":N,"cmd":"unload"} | {"id":N,"text":...}
    replies   every reply echoes "id" and carries "ok"; failures carry "error".

Gotchas honoured here (each one cost hours somewhere else -- see CONVENTIONS.md
and each engine's REPORT.md):

* ``torchaudio >= 2.9`` routes ``load``/``save`` through TorchCodec, which needs
  FFmpeg *shared* libraries. CosyVoice therefore imports ``cv_compat`` (a
  soundfile-backed shim) before anything else; and this worker never saves audio through
  torchaudio -- it encodes 16-bit PCM WAV with the stdlib ``wave`` module, so no
  writable temp file is needed anywhere.
* ``LD_LIBRARY_PATH`` must be correct for the CUDA runtime *before* ``import
  torch``, hence the ``os.execv`` re-exec idiom (same trick as ``worker.py``),
  because the engine's ``env.sh`` cannot be sourced by an already-running Python.
* Only Kokoro and IndexTTS read raw Arabic numerals correctly. CosyVoice gets
  digits spelled out in Chinese by ``.runtime/tts/tools/textnorm.py``.
  That module is imported, not reimplemented.
* This worker must NOT take the shared ``flock`` GPU lock: it is long-lived and
  would starve the batch tooling. Callers may wrap a single invocation in
  ``.runtime/tts/bin/gpu-run.sh`` if they want serialisation.
* A live ASR worker holds ~4.8 GB of the 16 GB card. Load one TTS engine at a
  time and ``unload`` (or exit) between engines.
"""
import os
import sys

# --------------------------------------------------------------------------- #
# 1. Environment before importing torch/model libraries, then re-exec.
# --------------------------------------------------------------------------- #
VOICE_HOME = os.environ.get('DSH_VOICE_HOME', os.path.join(os.environ.get('DSH_HOME', os.path.expanduser('~/.dsh')), 'voice'))
TTS_ROOT = os.environ.get('TTS_ROOT', os.environ.get('DSH_VOICE_TTS_ROOT', os.path.join(VOICE_HOME, 'tts')))


def _engine_from_argv(argv):
    """Pre-parse --engine cheaply: argparse cannot run before the re-exec."""
    for i, arg in enumerate(argv):
        if arg == '--engine' and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith('--engine='):
            return arg.split('=', 1)[1]
    return None


ENGINE = _engine_from_argv(sys.argv)

if not os.environ.get('DSH_TTS_ENV_READY'):
    import glob
    import sysconfig

    # Extracted .deb libraries (espeak-ng) plus the CUDA runtime libs shipped
    # inside the engine's own venv as nvidia-* wheels.
    lib_dirs = [
        os.path.join(TTS_ROOT, 'ext', 'usr', 'lib', 'x86_64-linux-gnu'),
    ]
    lib_dirs += glob.glob(sysconfig.get_paths()['purelib'] + '/nvidia/*/lib')
    os.environ['LD_LIBRARY_PATH'] = ':'.join(
        lib_dirs + ([os.environ['LD_LIBRARY_PATH']] if os.environ.get('LD_LIBRARY_PATH') else []))

    espeak_data = os.path.join(TTS_ROOT, 'ext', 'usr', 'lib', 'x86_64-linux-gnu', 'espeak-ng-data')
    if os.path.isdir(espeak_data):
        os.environ.setdefault('ESPEAK_DATA_PATH', espeak_data)
    os.environ['HF_HOME'] = os.path.join(TTS_ROOT, 'hf')
    os.environ['MODELS_ROOT'] = os.environ.get(
        'MODELS_ROOT', os.environ.get('DSH_VOICE_MODELS_ROOT', os.path.join(VOICE_HOME, 'models', 'tts')))
    # The engines are installed and verified: never reach for the network.
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    os.environ['PYTHONUNBUFFERED'] = '1'
    # Some libraries shell out to `uv pip install` for lazy assets and misbehave
    # when invoked through an absolute venv python without VIRTUAL_ENV set.
    os.environ.setdefault('VIRTUAL_ENV', os.path.dirname(os.path.dirname(sys.executable)))
    os.environ.setdefault('COSYVOICE_WETEXT_DIR', os.path.join(
        os.environ['MODELS_ROOT'], 'cosyvoice', 'wetext'))

    os.environ['PATH'] = os.path.join(TTS_ROOT, 'bin') + os.pathsep + os.environ.get('PATH', '')
    os.environ['PYTHONPATH'] = os.pathsep.join(
        p for p in [os.path.join(TTS_ROOT, ENGINE or '', 'repo'),
                    os.path.join(TTS_ROOT, 'tools'),
                    os.environ.get('PYTHONPATH', '')] if p)

    os.environ['DSH_TTS_ENV_READY'] = '1'
    os.execv(sys.executable, [sys.executable, *sys.argv])

import argparse
import base64
import contextlib
import importlib.util
import json
import re
import time
import wave

import numpy as np

# Text normalisation lives in .runtime/tts/tools/textnorm.py. It is imported
# through an explicit file path so that no engine repo can shadow the name.
_TEXTNORM_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'textnorm.py')
try:
    _spec = importlib.util.spec_from_file_location('dsh_tts_textnorm', _TEXTNORM_PATH)
    textnorm = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(textnorm)
    prepare_for_tts = textnorm.prepare_for_tts
    segment_text = getattr(textnorm, 'segment_text', None)
    TEXTNORM_ERROR = None
except Exception as _exc:                                   # pragma: no cover
    prepare_for_tts = None
    segment_text = None
    TEXTNORM_ERROR = '%s: %s' % (type(_exc).__name__, _exc)

# Engine import roots, same ones the proven scripts insert:
#   <TTS_ROOT>/<engine>          e.g. cosyvoice/synth.py needs `import cv_compat`
#   <TTS_ROOT>/<engine>/repo     e.g. indextts/synth.py -> `import indextts`
#   <TTS_ROOT>/<engine>/repo/third_party/Matcha-TTS
#                                cosyvoice/run_tts.py needs `import matcha`
#                                (cosyvoice.flow.flow_matching imports it)
# cosyvoice3 shares CosyVoice 2's venv AND its repo checkout, so its import root
# is the cosyvoice directory (only the model dir differs).
_IMPORT_ROOT_NAME = 'cosyvoice' if (ENGINE or '').startswith('cosyvoice') else (ENGINE or '')
_ENGINE_IMPORT_ROOTS = [
    os.path.join(TTS_ROOT, _IMPORT_ROOT_NAME),
    os.path.join(TTS_ROOT, _IMPORT_ROOT_NAME, 'repo'),
    os.path.join(TTS_ROOT, _IMPORT_ROOT_NAME, 'repo', 'src'),
    os.path.join(TTS_ROOT, _IMPORT_ROOT_NAME, 'repo', 'third_party', 'Matcha-TTS'),
]
for _root in reversed([p for p in _ENGINE_IMPORT_ROOTS if os.path.isdir(p)]):
    if _root not in sys.path:
        sys.path.insert(0, _root)


def _fallback_prepare(text):
    """Only used if textnorm.py is missing; markdown is still stripped."""
    text = re.sub(r'```.*?```', ' ', text, flags=re.S)
    text = re.sub(r'[`*_#>\|]', ' ', text)
    return re.sub(r'[ \t]+', ' ', text).strip()


#: Engines whose text frontend has no digit handling, per textnorm.SPELL_DEFAULT
#: (cosyvoice spells digits out, kokoro/indextts do not). Read from the
#: module when possible so the two never drift apart.
_FALLBACK_SPELL = {'cosyvoice': True, 'cosyvoice3': True,
                   'indextts': False, 'kokoro': False}


def spelling_enabled(engine_name, override=None):
    """Single source of truth for the spell decision, reused by every path."""
    if override is None:
        table = getattr(textnorm, 'SPELL_DEFAULT', None) if textnorm else None
        if table is None:
            table = _FALLBACK_SPELL
        return bool(table.get(engine_name.lower(), False))
    return bool(override)


def _fallback_segment(text, max_chars=90, min_chars=8):
    """Only used if textnorm.py has no segment_text()."""
    parts = [p for p in re.split(r'(?<=[。！？!?；;…\n])', text or '') if p.strip()]
    merged = []
    for part in parts:
        if merged and len(merged[-1]) < min_chars:
            merged[-1] += part
        else:
            merged.append(part)
    return [m.strip() for m in merged if m.strip()]


SEGMENT_TEXT = segment_text or _fallback_segment

#: 至少有一个可读字符(字母/数字/汉字)才算能合成。
#: 纯标点片段(典型:被切句切出来的孤零零一个 `”`)会让模型产出 0 个音频块,
#: CosyVoice 于是抛 "produced no audio chunks" —— 那是**上游的真实报错**,但把
#: 它当成"这句没得读"更贴近事实,也让客户端有明确的东西可以跳过。
SPEAKABLE = re.compile(r'[^\W_]', re.UNICODE)


def has_speakable(text):
    return bool(SPEAKABLE.search(text or ''))


def ref_sidecar_text(wav_path):
    """参考音频旁边的同名 .txt = 这段音频逐字说了什么。

    有它,CosyVoice 才会走 zero-shot(带 prompt text)而不是 cross-lingual;
    相似度和跟读稳定性都明显更好。没有就回 '',由引擎自己决定退化路径。
    """
    stem = os.path.splitext(wav_path)[0]
    try:
        with open(stem + '.txt', 'r', encoding='utf-8') as fh:
            return ' '.join(fh.read().split())
    except OSError:
        return ''


# --------------------------------------------------------------------------- #
# 2. CLI
# --------------------------------------------------------------------------- #
parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument('--engine',
                    choices=['kokoro', 'cosyvoice', 'cosyvoice3', 'indextts'],
                    required=True)
parser.add_argument('--voice', default=None, help='voice name, preset name or zh=..,en=.. pair')
parser.add_argument('--model-dir', default=None, help='override the engine model directory')
parser.add_argument('--models-root', default=None)
parser.add_argument('--device', choices=['cuda', 'cpu'], default='cuda')
parser.add_argument('--autoload', choices=['1', '0'], default='1')
parser.add_argument('--no-normalize', dest='normalize', action='store_false', default=True)
args = parser.parse_args()

MODELS_ROOT = args.models_root or os.environ.get(
    'MODELS_ROOT', os.environ.get('DSH_VOICE_MODELS_ROOT', os.path.join(VOICE_HOME, 'models', 'tts')))
DEVICE = args.device
DEVICE_STR = DEVICE
if DEVICE == 'cuda':
    DEVICE_STR = 'cuda:0'


def emit(data):
    """stdout carries the protocol and nothing else."""
    print(json.dumps(data, ensure_ascii=False), flush=True)


def log(message):
    print(message, file=sys.stderr, flush=True)


def _fail(message):
    raise RuntimeError(message)


def encode_wav(audio, sample_rate):
    """16-bit PCM mono WAV bytes, in-process. Never touches torchaudio.save."""
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    if x.size == 0:
        pcm = np.zeros(0, dtype='<i2')
    else:
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
        pcm = np.rint(np.clip(x, -1.0, 1.0) * 32767.0).astype('<i2')
    import io
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def peak_amplitude(audio):
    x = np.asarray(audio, dtype=np.float32)
    return float(np.max(np.abs(x))) if x.size else 0.0


def peak_vram_gb():
    try:
        import torch
        if torch.cuda.is_available():
            return round(torch.cuda.max_memory_allocated() / 1e9, 3)
    except Exception:
        pass
    return None


def as_mono_float(audio):
    if hasattr(audio, 'detach'):
        audio = audio.detach().cpu().numpy()
    x = np.asarray(audio, dtype=np.float32)
    if x.ndim > 1:                      # [channels, time] or [time, channels]
        x = x.mean(axis=0) if x.shape[0] <= 8 else x.mean(axis=-1)
    return np.ascontiguousarray(x.reshape(-1), dtype=np.float32)


# --------------------------------------------------------------------------- #
# 3. Engine implementations (call sequences copied from the verified scripts)
# --------------------------------------------------------------------------- #
class EngineBase:
    """Resident model holder. Subclasses copy the proven call sequence."""

    name = 'base'
    default_voice = None

    def __init__(self):
        self.model = None
        self.loaded = False
        self.load_seconds = None
        self.voice = self.default_voice
        self.sample_rate = None

    # -- voice catalogue ---------------------------------------------------- #
    def available_voices(self):
        return []

    def resolve_voice(self, voice):
        """Return the engine-internal voice descriptor for a user-facing name."""
        _fail('this engine has no voices to choose from')

    # -- lifecycle ---------------------------------------------------------- #
    def load(self, model_dir=None):
        _fail('engine %s has no loader' % self.name)

    def unload(self):
        self.model = None
        self.loaded = False

    # -- synthesis ---------------------------------------------------------- #
    def synthesize(self, text, voice, speed, ref_wav, ref_text, cfg_strength, instruct=None):
        _fail('engine %s has no synthesiser' % self.name)

    @property
    def can_switch_voice(self):
        return True


class KokoroEngine(EngineBase):
    """Kokoro-82M, split by script across the zh (v1.1) and en (v1.0) pipelines.

    Verbatim from .runtime/tts/kokoro/synth.py: the v1.1-zh checkpoint has
    en_callable=None and SILENTLY DROPS Latin runs, so a mixed sentence must be
    split and each run routed to the pipeline that can pronounce it. A Latin run
    only earns the English pipeline if it has a real word ("2026" would become
    1.7 s of "twenty twenty-six" instead of being read by the Chinese side).
    """

    name = 'kokoro'
    SR = 24000
    CJK = re.compile(r'[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]')
    WORD = re.compile(r'[A-Za-z]{2,}')

    def __init__(self):
        super().__init__()
        self.zh_repo = 'hexgrad/Kokoro-82M-v1.1-zh'
        self.en_repo = 'hexgrad/Kokoro-82M'
        # Defaults are exactly what the verified smoke.sh/synth.py use.
        self.zh_voice = 'zf_001'
        self.en_voice = 'af_heart'
        self.gap = 0.18
        self.pipes = {}
        self.sample_rate = self.SR
        self.voice = 'zh=%s,en=%s' % (self.zh_voice, self.en_voice)

    # -- voices ------------------------------------------------------------- #
    def _voices_for(self, repo):
        """Real voice names present in the local HF snapshot, never invented."""
        found = set()
        hub = os.environ.get('HF_HOME', os.path.join(TTS_ROOT, 'hf'))
        base = os.path.join(hub, 'hub', 'models--' + repo.replace('/', '--'))
        for root, _dirs, files in os.walk(base):
            for f in files:
                if f.endswith('.pt'):
                    found.add(f[:-3])
        return sorted(found)

    def available_voices(self):
        return {'zh': self._voices_for(self.zh_repo), 'en': self._voices_for(self.en_repo)}

    def resolve_voice(self, voice):
        if voice is None or not str(voice).strip():
            _fail('empty voice name')
        spec = str(voice).strip()
        if '=' in spec:
            pairs = {}
            for part in spec.split(','):
                if '=' not in part:
                    _fail('voice pair must look like zh=NAME,en=NAME (got %r)' % voice)
                key, value = part.split('=', 1)
                key = key.strip().lower()
                if key not in ('zh', 'en'):
                    _fail('unknown voice slot %r (use zh or en)' % key)
                pairs[key] = value.strip()
            zh = pairs.get('zh', self.zh_voice)
            en = pairs.get('en', self.en_voice)
        else:
            zh_available = self._voices_for(self.zh_repo)
            en_available = self._voices_for(self.en_repo)
            if spec in zh_available and spec in en_available:
                zh = en = spec
            elif spec in zh_available:
                zh, en = spec, self.en_voice
            elif spec in en_available:
                zh, en = self.zh_voice, spec
            else:
                _fail('unknown Kokoro voice %r; known zh=%s en=%s'
                      % (spec, zh_available, en_available))
        for slot, name, repo in (('zh', zh, self.zh_repo), ('en', en, self.en_repo)):
            known = self._voices_for(repo)
            if known and name not in known:
                _fail('voice %r is not installed for the %s pipeline (%s); available: %s'
                      % (name, slot, repo, known))
        return {'zh': zh, 'en': en}

    def _apply(self, spec):
        self.zh_voice, self.en_voice = spec['zh'], spec['en']
        self.voice = 'zh=%s,en=%s' % (self.zh_voice, self.en_voice)

    # -- lifecycle ---------------------------------------------------------- #
    def _pipeline(self, key):
        if key not in self.pipes:
            from kokoro import KPipeline
            self.pipes[key] = KPipeline(
                lang_code='z' if key == 'zh' else 'a',
                repo_id=self.zh_repo if key == 'zh' else self.en_repo)
        return self.pipes[key]

    def load(self, model_dir=None):
        if model_dir:
            _fail('kokoro takes no --model-dir; its checkpoints come from the HF cache')
        start = time.perf_counter()
        self._pipeline('zh')
        self._pipeline('en')
        self.load_seconds = time.perf_counter() - start
        self.loaded = True

    def unload(self):
        self.pipes = {}
        super().unload()

    # -- synthesis ---------------------------------------------------------- #
    def _split_runs(self, text):
        runs, cur, cur_cjk = [], '', None
        for ch in text:
            c = bool(self.CJK.match(ch))
            if cur_cjk is None or c == cur_cjk:
                cur += ch
                cur_cjk = c
            else:
                runs.append([cur_cjk, cur])
                cur, cur_cjk = ch, c
        if cur:
            runs.append([cur_cjk, cur])
        merged = []
        for is_cjk, chunk in runs:
            if not is_cjk and not self.WORD.search(chunk):
                if merged:
                    merged[-1][1] += chunk
                else:
                    merged.append([is_cjk, chunk])
            else:
                merged.append([is_cjk, chunk])
        out = []
        for is_cjk, chunk in merged:
            if out and out[-1][0] == is_cjk:
                out[-1][1] += chunk
            else:
                out.append([is_cjk, chunk])
        return [(a, b) for a, b in out]

    def synthesize(self, text, voice, speed, ref_wav, ref_text, cfg_strength, instruct=None):
        if ref_wav:
            _fail('kokoro cannot clone voices; pick a voice name instead')
        spec = self.resolve_voice(voice) if voice is not None else {
            'zh': self.zh_voice, 'en': self.en_voice}
        parts = []
        for is_cjk, chunk in self._split_runs(text):
            if not chunk.strip():
                continue
            key = 'zh' if is_cjk else 'en'
            pipe = self._pipeline(key)
            pieces = [x.numpy() if hasattr(x, 'numpy') else x
                      for _, _, x in pipe(chunk,
                                          voice=spec['zh'] if is_cjk else spec['en'],
                                          speed=float(speed))]
            wav = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
            if wav.size:
                parts.append(wav)
                parts.append(np.zeros(int(self.gap * self.SR), dtype=np.float32))
        if not parts:
            return np.zeros(0, dtype=np.float32), self.SR
        return np.concatenate(parts).astype(np.float32), self.SR


class CosyVoiceEngine(EngineBase):
    """CosyVoice zero-shot cloning, from .runtime/tts/cosyvoice/run_tts.py.

    Serves BOTH CosyVoice 2 (``--engine cosyvoice``, CosyVoice2-0.5B) and
    CosyVoice 3 (``--engine cosyvoice3``, Fun-CosyVoice3-0.5B): they share the
    same venv and the same ``run_tts.py`` call sequence, and each model dir has
    its own ``cosyvoice.yaml`` / ``cosyvoice3.yaml`` so upstream's ``AutoModel``
    dispatches to CosyVoice2Model / CosyVoice3Model by itself. The one real
    difference is the zero-shot prompt text: CosyVoice 3 wants the
    ``You are a helpful assistant.<|endofprompt|>`` prefix (host-declared, same
    value as tts-engines.js) or clone quality degrades.

    ``cv_compat`` must be imported before ``cosyvoice``/``torchaudio``: it swaps
    torchaudio load/save onto soundfile (torchaudio >= 2.9 would demand TorchCodec
    + FFmpeg shared libs) and pins wetext's snapshot_download to the local FST
    models so the Chinese text frontend does not silently degrade to ''.
    """

    name = 'cosyvoice'
    variant = 'cosyvoice'
    model_name = 'CosyVoice2-0.5B'
    prompt_prefix = ''

    #: Host-visible default voice id (tts-engines.js `defaultVoice`); the repo's
    #: own asset clip. Kept alongside the explicit preset names below.
    VOICE_ALIASES = {'zero_shot_prompt': 'zero_shot_zh'}

    def __init__(self):
        super().__init__()
        self.model_dir = os.path.join(MODELS_ROOT, 'cosyvoice', self.model_name)
        self.refs = {
            'zero_shot_zh': {
                'wav': os.path.join(TTS_ROOT, 'cosyvoice', 'repo', 'asset', 'zero_shot_prompt.wav'),
                'text': '希望你以后能够做的比我还好呦。',
                'note': 'repo asset, 3.48 s 24 kHz Chinese; the verified smoke.sh default',
            },
            'cross_lingual_zh': {
                'wav': os.path.join(TTS_ROOT, 'cosyvoice', 'repo', 'asset', 'cross_lingual_prompt.wav'),
                'text': '',
                'note': 'cross-lingual prompt (prompt text ignored by that API path)',
            },
        }
        self.zero_shot_spk_ids = {}
        self.default_voice = 'zero_shot_zh'
        self.voice = self.default_voice
        self.sample_rate = 24000

    # -- voices ------------------------------------------------------------- #
    def _present_refs(self):
        out = {}
        for name, ref in self.refs.items():
            if os.path.isfile(ref['wav']):
                out[name] = ref
        return out

    def available_voices(self):
        return sorted(set(list(self._present_refs()) + list(self.VOICE_ALIASES)))

    def resolve_voice(self, voice):
        """名字/别名 → 出厂参考音频;其它 → 用户自己的参考音频(参考音频目录)。

        **顺序和身份都是刻意的**:先认名字再看文件,且"文件型音色"的身份就是
        它的绝对路径。旧实现先判 ``os.path.isfile`` 并把 ``name`` 设成 basename
        —— 宿主会把 basename 记成当前音色,worker 一重启 cwd 变了就再也解析不
        回来,音色表现为"选一次就废"。绝对路径重启后依然解析得回来,而且不用把
        参考音频内容塞进每一条合成请求。
        """
        if voice is None or not str(voice).strip():
            _fail('empty voice name')
        spec = str(voice).strip()
        present = self._present_refs()
        name = self.VOICE_ALIASES.get(spec, spec)
        if name in present:
            ref = present[name]
            return {'name': name, 'wav': ref['wav'], 'text': ref['text'], 'textPrefixed': False}
        if os.path.isfile(spec):
            real = os.path.realpath(spec)
            for known, ref in present.items():
                if os.path.realpath(ref['wav']) == real:
                    # 用户直接指了出厂资产的路径:仍按预置处理。否则 prompt text
                    # 会丢,zero-shot 会静默退化成 cross-lingual。
                    return {'name': known, 'wav': ref['wav'], 'text': ref['text'],
                            'textPrefixed': False}
            return {'name': spec, 'wav': spec, 'text': ref_sidecar_text(spec),
                    'textPrefixed': False}
        _fail('unknown %s reference %r; available: %s (or pass an existing wav path, '
              'or a request with "refWav")' % (self.name, spec, sorted(present)))

    def prompt_text_for(self, ref):
        """Zero-shot prompt text, with the CosyVoice 3 assistant prefix applied."""
        text = (ref.get('text') or '').strip()
        if not text:
            return text
        if (ref.get('textPrefixed') or '').strip():
            return text
        return (self.prompt_prefix + text) if self.prompt_prefix else text

    # -- lifecycle ---------------------------------------------------------- #
    def load(self, model_dir=None):
        if model_dir:
            self.model_dir = model_dir
        if not os.path.isdir(self.model_dir):
            _fail('%s model dir not found: %s' % (self.name, self.model_dir))
        start = time.perf_counter()
        import cv_compat                                                     # noqa: F401
        from cosyvoice.cli.cosyvoice import AutoModel
        self.model = AutoModel(model_dir=self.model_dir, fp16=False)
        self.sample_rate = int(self.model.sample_rate)
        self.load_seconds = time.perf_counter() - start
        self.loaded = True
        if self.prompt_prefix:
            log('[%s] zero-shot prompt prefix is %r (model dir %s)'
                % (self.name, self.prompt_prefix, os.path.basename(self.model_dir)))

    # -- synthesis ---------------------------------------------------------- #
    def synthesize(self, text, voice, speed, ref_wav, ref_text, cfg_strength, instruct=None):
        if ref_wav:
            ref = {'name': os.path.basename(ref_wav), 'wav': ref_wav, 'text': ref_text or '',
                   'textPrefixed': bool(ref_text)}
        else:
            ref = self.resolve_voice(voice if voice is not None else self.voice)
        if not os.path.isfile(ref['wav']):
            _fail('reference wav not found: %s' % ref['wav'])
        if instruct:
            # ---- 指令通道(inference_instruct2)------------------------------- #
            # 实测唯一能让"用德语/法语朗读"真正生效的通道,而且它让**原始阿拉伯
            # 数字**也读对(见 lib/core/tts-instruct.js 顶部的证据与
            # lang-probe-out/qwen-cv3final.json)。
            #
            # 两个必须照做的细节:
            #   1. zero_shot_spk_id 保持默认的 ''。传一个已注册的 spk id 会让
            #      frontend_zero_shot 直接返回 spk2info,指令被**静默忽略**;
            #      代价是每次合成重算 campplus + speech tokenizer(没有缓存快路径)。
            #   2. text_frontend=False。开着的话同一个德语指令会被英文数字规则
            #      搅成荷兰语(F4 实测),所以这不是可选项。
            #
            # 指令文本本身已经由 host 补好 'You are a helpful assistant.' 前缀和
            # 收尾的 <|endofprompt|>(CV3 LM 的硬断言),这里原样传,不再加工。
            if not hasattr(self.model, 'inference_instruct2'):
                # 引擎不认识指令时**不能**悄悄当成没说:用户改了设置却没反应,
                # 是这轮里反复出现的"改了没生效"那类 bug。回落保证朗读照常,
                # 日志给出原因。
                log('[%s] 该引擎不支持 inference_instruct2,忽略朗读指令' % self.name)
            else:
                log('[%s] instruct voice=%s ref=%s instruct=%r'
                    % (self.name, ref['name'], ref['wav'], instruct))
                chunks = []
                for out in self.model.inference_instruct2(
                        text, instruct, ref['wav'], stream=False,
                        speed=float(speed), text_frontend=False):
                    chunks.append(out['tts_speech'].detach().cpu())
                if not chunks:
                    _fail('%s instruct produced no audio chunks' % self.name)
                import torch
                return as_mono_float(torch.cat(chunks, dim=1)), self.sample_rate
        prompt_text = self.prompt_text_for(ref)
        if not prompt_text:
            # No transcript: cross-lingual mode. This is the only API path that
            # legitimately has no prompt text (upstream ignores it), but CosyVoice 3
            # still asserts that <|endofprompt|> appears in the TEXT argument --
            # llm.py:479 'not detected in CosyVoice3 text or prompt_text'. The
            # documented CV3 cross-lingual example carries the prefix on the spoken
            # text for exactly this reason, so reuse self.prompt_prefix (empty for
            # v2, which has no such assertion).
            # 音频本身分不出走了哪条路,而"静默退化成 cross-lingual"正是刚让用户
            # 踩到截断的那类 bug,所以两种模式各留一行日志。
            log('[%s] cross-lingual (no prompt text) voice=%s ref=%s'
                % (self.name, ref['name'], ref['wav']))
            chunks = []
            for out in self.model.inference_cross_lingual(
                    self.prompt_prefix + text, ref['wav'], stream=False,
                    speed=float(speed)):
                chunks.append(out['tts_speech'].detach().cpu())
            if not chunks:
                _fail('%s cross-lingual produced no audio chunks' % self.name)
            import torch
            return as_mono_float(torch.cat(chunks, dim=1)), self.sample_rate
        # Speaker-prompt encoding is a fixed per-call cost; cache it once per
        # reference so requests 2..N skip campplus + speech_tokenizer entirely.
        spk_id = self.zero_shot_spk_ids.get(ref['wav'])
        if spk_id is None:
            spk_id = 'dsh-%d' % (len(self.zero_shot_spk_ids) + 1)
            log('[%s] zero-shot voice=%s ref=%s prompt_text=%r'
                % (self.name, ref['name'], ref['wav'], prompt_text))
            ok = self.model.add_zero_shot_spk(prompt_text, ref['wav'], spk_id)
            if ok is not True:
                _fail('add_zero_shot_spk failed for %s' % ref['wav'])
            self.zero_shot_spk_ids[ref['wav']] = spk_id
        chunks = []
        for out in self.model.inference_zero_shot(
                text, '', '', zero_shot_spk_id=spk_id, stream=False, speed=float(speed)):
            chunks.append(out['tts_speech'].detach().cpu())
        if not chunks:
            _fail('%s produced no audio chunks' % self.name)
        import torch
        wav = torch.cat(chunks, dim=1)
        return as_mono_float(wav), self.sample_rate


class CosyVoice3Engine(CosyVoiceEngine):
    """CosyVoice 3 (Fun-CosyVoice3-0.5B): same venv and call path as v2.

    Measured difference in the bake-off: v3 is verbatim-accurate (cer_zh 0.0000)
    but slower than realtime (RTF 1.205, load ~24 s, 3.74 GB), where v2 is
    faster-than-realtime with one polyphone mistake (银行 -> 您好).
    """

    name = 'cosyvoice3'
    variant = 'cosyvoice3'
    model_name = 'Fun-CosyVoice3-0.5B'
    prompt_prefix = 'You are a helpful assistant.<|endofprompt|>'


class IndexTTSEngine(EngineBase):
    """IndexTTS-2.5, from .runtime/tts/indextts/synth.py.

    Verbatim keyword set: use_bf16, use_cuda_kernel=False, use_torch_compile=False
    and the Qwen emotion model left on (it costs ~1.2 GB of the ~7 GB peak; that
    is inside the verified configuration). Inference is called with
    ``output_path=None``, which makes upstream return ``(sample_rate, pcm_int16)``
    instead of writing a wav; those samples are ALREADY 32767-scaled, so they are
    divided back down rather than blindly cast.

    The model caches reference conditioning and only recomputes when
    ``cache_spk_audio_prompt`` changes, so switching voice is cheap and safe.
    """

    name = 'indextts'

    def __init__(self):
        super().__init__()
        self.model_dir = os.path.join(MODELS_ROOT, 'indextts', 'checkpoints')
        self.examples = os.path.join(TTS_ROOT, 'indextts', 'repo', 'examples')
        self.version = '2.5'
        self.half = 'bf16'
        self.lang = 'ZH'
        self.duration_factor = 1.0
        self.default_voice = 'voice_04'
        self.voice = self.default_voice
        self.sample_rate = 22050
        self._ref_cache = {}

    # -- voices ------------------------------------------------------------- #
    def _present_prompts(self):
        out = {}
        if os.path.isdir(self.examples):
            for f in sorted(os.listdir(self.examples)):
                if f.lower().endswith('.wav'):
                    out[f[:-4]] = os.path.join(self.examples, f)
        extra = os.path.join(TTS_ROOT, 'indextts', 'repo', 'examples', 'batch')
        if os.path.isdir(extra):
            for f in sorted(os.listdir(extra)):
                if f.lower().endswith('.wav'):
                    out.setdefault(f[:-4], os.path.join(extra, f))
        return out

    def available_voices(self):
        return sorted(self._present_prompts())

    def resolve_voice(self, voice):
        """示例音色名 → 仓库里的示例;其它 → 用户自己的参考音频(身份=绝对路径)。

        与 CosyVoice 同样的理由:文件型音色的身份必须是绝对路径,否则 worker
        重启后 basename 解析不回来(详见 CosyVoiceEngine.resolve_voice)。
        """
        if voice is None or not str(voice).strip():
            _fail('empty voice name')
        spec = str(voice).strip()
        present = self._present_prompts()
        if spec in present:
            return {'name': spec, 'wav': present[spec]}
        if os.path.isfile(spec):
            real = os.path.realpath(spec)
            for known, wav in present.items():
                if os.path.realpath(wav) == real:
                    return {'name': known, 'wav': wav}
            return {'name': spec, 'wav': spec}
        _fail('unknown IndexTTS prompt %r; available: %s (or pass an existing wav path, '
              'or a request with "refWav")' % (spec, sorted(present)))

    # -- lifecycle ---------------------------------------------------------- #
    def load(self, model_dir=None):
        if model_dir:
            self.model_dir = model_dir
        if not os.path.isdir(self.model_dir):
            _fail('IndexTTS model dir not found: %s' % self.model_dir)
        import torch
        if DEVICE == 'cuda' and not torch.cuda.is_available():
            _fail('CUDA is unavailable; CPU fallback is disabled')
        from indextts.infer_v2_5 import IndexTTS2
        start = time.perf_counter()
        self.model = IndexTTS2(
            cfg_path=os.path.join(self.model_dir, 'config.yaml'),
            model_dir=self.model_dir,
            use_bf16=(self.half in ('bf16', 'fp16')),
            use_cuda_kernel=False,
            use_torch_compile=False,
            use_qwen_emo=True,
            device=DEVICE_STR,
        )
        self.load_seconds = time.perf_counter() - start
        self.loaded = True

    # -- synthesis ---------------------------------------------------------- #
    def _prompt_for(self, ref_wav, voice):
        if ref_wav:
            return {'name': os.path.basename(ref_wav), 'wav': ref_wav}
        return self.resolve_voice(voice if voice is not None else self.voice)

    def synthesize(self, text, voice, speed, ref_wav, ref_text, cfg_strength, instruct=None):
        ref = self._prompt_for(ref_wav, voice)
        if not os.path.isfile(ref['wav']):
            _fail('reference wav not found: %s' % ref['wav'])
        if ref_text:
            _fail('IndexTTS takes no reference transcript; it derives timbre from the wav alone')
        result = None
        for result in self.model.infer(
                spk_audio_prompt=ref['wav'], text=text, output_path=None, lang=self.lang,
                verbose=False, max_text_tokens_per_segment=120,
                duration_factor=self.duration_factor, text_normalization=True):
            pass
        if result is None:
            _fail('IndexTTS returned no audio')
        if isinstance(result, tuple) and len(result) == 2:
            sample_rate, data = result
        else:
            # Some upstream paths yield the bare waveform instead of (sr, wav).
            sample_rate, data = 22050, result
        # Upstream returns `wav.type(torch.int16)` from a tensor that was already
        # clamped to +-32767, i.e. PCM-scale 16-bit samples, not [-1, 1] floats.
        audio = np.asarray(data, dtype=np.float32) / 32767.0
        audio = as_mono_float(audio)
        self.sample_rate = int(sample_rate)
        return audio, int(sample_rate)


ENGINES = {
    'kokoro': KokoroEngine,
    'cosyvoice': CosyVoiceEngine,
    'cosyvoice3': CosyVoice3Engine,
    'indextts': IndexTTSEngine,
}


# --------------------------------------------------------------------------- #
# 4. Startup: load once (unless --autoload 0), then hand over on stdout.
# --------------------------------------------------------------------------- #
engine = ENGINES[args.engine]()

# --model-dir is the authority on WHICH CosyVoice generation is resident: with a
# Fun-CosyVoice3 dir the assistant prompt prefix must be applied even if the
# engine id said "cosyvoice" (and vice versa). Upstream AutoModel picks the model
# class from the dir's cosyvoice.yaml / cosyvoice3.yaml by itself.
if isinstance(engine, CosyVoiceEngine) and args.model_dir:
    _basename = os.path.basename(os.path.normpath(args.model_dir)).lower()
    if 'cosyvoice3' in _basename:
        engine.prompt_prefix = 'You are a helpful assistant.<|endofprompt|>'
    else:
        engine.prompt_prefix = ''

# Text normalisation default per engine comes from textnorm.SPELL_DEFAULT
# (cosyvoice spells digits, kokoro/indextts do not) -- do not second-guess it.
NORMALIZE = args.normalize and prepare_for_tts is not None


def normalize_text(text, override=None):
    """The ONE preparation path: markdown always stripped, digits per engine."""
    if prepare_for_tts is None:
        return _fallback_prepare(text)
    return prepare_for_tts(text, engine=engine.name, markdown=True,
                           spell=spelling_enabled(engine.name, override)
                           if (NORMALIZE or override is not None) else False)


def engine_details():
    """Resident facts the host may want to show; engine-specific, best effort."""
    details = {'textNormalization': bool(NORMALIZE),
               'spellDefault': spelling_enabled(engine.name),
               'fallbackPreparation': prepare_for_tts is None,
               'canSwitchVoice': engine.can_switch_voice}
    if getattr(engine, 'model_dir', None):
        details['modelDir'] = engine.model_dir
    if TEXTNORM_ERROR:
        details['textnormError'] = TEXTNORM_ERROR
    return details


def build_ready():
    voices = engine.available_voices()
    return {
        'ready': True,
        'engine': engine.name,
        'sampleRate': engine.sample_rate,
        'loadSeconds': round(engine.load_seconds or 0.0, 3),
        'voices': voices,
        'voice': engine.voice,
        'device': DEVICE,
        'details': engine_details(),
    }


def set_engine_voice(name):
    """Resolve a user-facing voice name and make it current. Raises on bad names."""
    spec = engine.resolve_voice(name)
    if hasattr(engine, '_apply'):
        engine._apply(spec)
    else:
        engine.voice = spec.get('name') or str(name)
    return engine.voice


if args.voice:
    try:
        set_engine_voice(args.voice)
    except SystemExit:
        raise
    except Exception as exc:
        log('warning: --voice %r did not resolve before load (%s: %s); it will be validated '
            'on first use' % (args.voice, type(exc).__name__, exc))

if args.autoload == '1':
    try:
        start = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            engine.load(args.model_dir)
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit({'ready': False, 'error': '%s: %s' % (type(exc).__name__, exc)})
        raise SystemExit(1)
    if engine.voice is None and engine.default_voice:
        engine.voice = engine.default_voice
    emit(build_ready())
else:
    emit({'ready': True, 'engine': engine.name, 'loaded': False, 'sampleRate': None,
          'loadSeconds': 0.0, 'voices': engine.available_voices(),
          'voice': engine.voice, 'device': DEVICE})

# --------------------------------------------------------------------------- #
# 5. Request loop
# --------------------------------------------------------------------------- #
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = {}
    try:
        req = json.loads(line)
        if not isinstance(req, dict):
            raise ValueError('request must be a JSON object')
        rid = req.get('id')
        cmd = req.get('cmd')

        if cmd == 'unload':
            with contextlib.redirect_stdout(sys.stderr):
                engine.unload()
                try:
                    import torch
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                except Exception:
                    pass
            emit({'id': rid, 'ok': True, 'unloaded': True, 'engine': engine.name,
                  'exiting': True})
            break

        if cmd == 'load':
            if engine.loaded:
                emit({'id': rid, 'ok': True, 'loadSeconds': round(engine.load_seconds or 0.0, 3),
                      'sampleRate': engine.sample_rate, 'alreadyLoaded': True})
                continue
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    engine.load(args.model_dir)
                engine.load_error = None
            except Exception as exc:
                import traceback
                traceback.print_exc(file=sys.stderr)
                engine.load_error = '%s: %s' % (type(exc).__name__, exc)
                emit({'id': rid, 'ok': False, 'error': engine.load_error})
                continue
            emit({'id': rid, 'ok': True, 'loadSeconds': round(engine.load_seconds or 0.0, 3),
                  'sampleRate': engine.sample_rate})
            continue

        if cmd == 'voices':
            emit({'id': rid, 'ok': True, 'voices': engine.available_voices(),
                  'voice': engine.voice})
            continue

        if cmd == 'setVoice':
            name = req.get('voice')
            if not engine.can_switch_voice:
                emit({'id': rid, 'ok': False,
                      'error': 'engine %s cannot switch voice without a reload' % engine.name})
                continue
            emit({'id': rid, 'ok': True, 'voice': set_engine_voice(name)})
            continue

        if cmd == 'prepare':
            # Pure text work: must answer even with no model loaded, and must
            # never touch the GPU. Uses the exact same normalisation as the
            # synthesis path, then splits for sentence-by-sentence playback.
            raw = req.get('text')
            if raw is None:
                raw = ''
            if not isinstance(raw, str):
                emit({'id': rid, 'ok': False, 'error': '"text" must be a string'})
                continue
            normalized = normalize_text(raw, req.get('normalize')).strip()
            segments = SEGMENT_TEXT(normalized) if normalized else []
            emit({'id': rid, 'ok': True, 'engine': engine.name,
                  'spell': spelling_enabled(engine.name, req.get('normalize')),
                  'normalized': normalized, 'segments': segments})
            continue

        if cmd == 'stats':
            emit({
                'id': rid, 'ok': True, 'engine': engine.name, 'loaded': bool(engine.loaded),
                'sampleRate': engine.sample_rate,
                'loadSeconds': None if engine.load_seconds is None else round(engine.load_seconds, 3),
                'voice': engine.voice, 'device': DEVICE, 'peakVramGb': peak_vram_gb(),
                'loadError': getattr(engine, 'load_error', None),
            })
            continue

        if cmd is not None:
            emit({'id': rid, 'ok': False, 'error': 'unknown cmd %r' % cmd})
            continue

        # ---- synthesis request ------------------------------------------- #
        raw = req.get('text')
        if not isinstance(raw, str):
            emit({'id': rid, 'ok': False, 'error': 'request needs "text" (string) or a "cmd"'})
            continue

        # 空文本 / 纯标点的判断必须放在**懒加载之前**:一个只有标点的碎片既不该
        # 触发 20s+ 的模型加载,也不该因为模型对它报 "no audio chunks" 而让整段
        # 朗读中断(客户端把这一句的失败当成致命错误的老行为就是这么被踩到的)。
        # Segments have already been normalized by the host. Applying Markdown
        # parsing twice can erase literal text selected from the rendered reply.
        text = raw.strip() if req.get('prepared') is True else normalize_text(raw, req.get('normalize')).strip()
        if not text or not has_speakable(text):
            emit({'id': rid, 'ok': True, 'wav': None, 'audioSeconds': 0.0,
                  'skipped': 'empty' if not text else 'no speakable text',
                  'voice': engine.voice, 'sampleRate': engine.sample_rate})
            continue

        if not engine.loaded:
            # Lazy load: report the real reason a broken engine cannot work
            # instead of hanging or pretending. The failure is remembered so
            # later requests fail fast with the same real message.
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    engine.load(args.model_dir)
                engine.load_error = None
            except Exception as exc:
                import traceback
                traceback.print_exc(file=sys.stderr)
                engine.load_error = '%s: %s' % (type(exc).__name__, exc)
                emit({'id': rid, 'ok': False,
                      'error': 'model not loaded and loading failed: %s' % engine.load_error})
                continue

        voice = req.get('voice', None)
        speed = float(req.get('speed', 1.0) or 1.0)
        cfg_strength = req.get('cfgStrength', None)
        ref_wav = req.get('refWav') or None
        ref_text = req.get('refText') or ''
        # 朗读语言指令(CosyVoice 系列的 inference_instruct2)。host 只在设置里
        # 真的指定了语言/自定义指令时才发这个字段,默认是 None = 走原路径。
        instruct = req.get('instruct') or None
        if instruct and not str(engine.name).startswith('cosyvoice'):
            # 用户可能把语言指令设成德语却仍在用 kokoro —— 那时设置被静默忽略,
            # 表现就是"我改了设置但听起来没变"。留一行日志让这件事可查。
            log('[%s] 忽略朗读指令(只有 CosyVoice 系列支持): %r' % (engine.name, instruct))
            instruct = None
        if ref_wav and not os.path.isfile(ref_wav):
            emit({'id': rid, 'ok': False, 'error': 'refWav not found: %s' % ref_wav})
            continue

        start = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            audio, sample_rate = engine.synthesize(text, voice, speed, ref_wav, ref_text,
                                                   cfg_strength, instruct=instruct)
            try:
                import torch
                if DEVICE == 'cuda' and torch.cuda.is_available():
                    torch.cuda.synchronize()
            except Exception:
                pass
        synth_seconds = time.perf_counter() - start

        peak = peak_amplitude(audio)
        wav_bytes = encode_wav(audio, sample_rate)
        emit({
            'id': rid, 'ok': True,
            'wav': base64.b64encode(wav_bytes).decode('ascii'),
            'sampleRate': int(sample_rate),
            'audioSeconds': round(len(np.asarray(audio).reshape(-1)) / float(sample_rate), 3),
            'synthSeconds': round(synth_seconds, 3),
            'voice': ref_wav and os.path.basename(ref_wav) or engine.voice,
            'text': text,
            'peakAmplitude': round(peak, 4),
            'engine': engine.name,
        })
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit({'id': req.get('id') if isinstance(req, dict) else None, 'ok': False,
              'error': '%s: %s' % (type(exc).__name__, exc)})

raise SystemExit(0)
