"""Compatibility shims for running CosyVoice 2/3 with recent Torch builds.

Import this BEFORE `cosyvoice.*`. It fixes two hard incompatibilities between
upstream CosyVoice (Dec-2025 HEAD, written for torch/torchaudio 2.3.1 + conda)
and the only torch build that runs on Blackwell sm_120 (torch 2.14.0+cu130,
torchaudio 2.11.0+cu130):

1. torchaudio >= 2.9 routes torchaudio.load/save through TorchCodec, which is not
   installed and needs FFmpeg *shared* libraries we cannot apt-install.
   CosyVoice's `cosyvoice/utils/file_utils.py:load_wav()` and every
   `torchaudio.save()` call therefore raise ImportError.
   -> Re-implement load/save on top of `soundfile` (pure pip wheel, no root).
      Semantics match what CosyVoice needs: float32, [channels, time], sr returned.

2. `wetext.Normalizer.__init__` calls `modelscope.snapshot_download()` on EVERY
   construction, i.e. it needs network access to modelscope.cn each time the
   frontend is built. On a flaky/rate-limited run that raises (HTTP 403) and
   CosyVoice silently degrades to `text_frontend = ''` -- no number/date/percent
   normalisation at all, which is exactly where the bake-off sentence is hard.
   -> Pin snapshot_download to the local copy of the FST models so the frontend
      is deterministic and offline.  Set COSYVOICE_WETEXT_DIR to relocate it.

Nothing upstream is modified; both shims live here, inside the launcher.
"""
import os
import sys

WETEXT_DIR = os.environ.get(
    'COSYVOICE_WETEXT_DIR',
    os.path.join(os.environ.get('MODELS_ROOT', os.path.join(os.environ.get('DSH_VOICE_HOME', os.path.join(os.environ.get('DSH_HOME', os.path.expanduser('~/.dsh')), 'voice')), 'models', 'tts')), 'cosyvoice', 'wetext'))


def patch_torchaudio():
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio

    def load(uri, frame_offset=0, num_frames=-1, normalize=True,
             channels_first=True, **kwargs):
        data, sr = sf.read(str(uri), dtype='float32', always_2d=True,
                           start=int(frame_offset or 0),
                           frames=int(num_frames) if num_frames and num_frames > 0 else -1)
        t = torch.from_numpy(np.ascontiguousarray(data.T if channels_first else data))
        return t, sr

    def save(uri, src, sample_rate, channels_first=True, **kwargs):
        x = src.detach().cpu().numpy()
        if x.ndim == 1:
            x = x[None, :]
        if channels_first:
            x = x.T
        sf.write(str(uri), x, int(sample_rate), subtype='PCM_16')

    torchaudio.load = load
    torchaudio.save = save


def patch_wetext_offline():
    """Make `wetext.Normalizer(...)` resolve models from a local directory."""
    if not os.path.isdir(WETEXT_DIR):
        return False
    try:
        import wetext.wetext as ww
    except Exception:
        return False

    def snapshot_download(*args, **kwargs):
        return WETEXT_DIR

    ww.snapshot_download = snapshot_download
    return True


def apply():
    patch_torchaudio()
    ok = patch_wetext_offline()
    print(f'[cv_compat] torchaudio load/save -> soundfile; '
          f'wetext offline={ok} ({WETEXT_DIR})', file=sys.stderr, flush=True)


apply()
