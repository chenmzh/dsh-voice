"""Private JSON-lines ASR worker; stdin PCM only, stdout protocol only."""
import os
import sys
# Each backend has its own process and CUDA runtime libraries.
if not os.environ.get('DSH_VOICE_CUDA_LIBS_READY'):
    import glob
    import sysconfig
    dirs = glob.glob(sysconfig.get_paths()['purelib'] + '/nvidia/*/lib')
    os.environ['LD_LIBRARY_PATH'] = ':'.join(dirs + [os.environ.get('LD_LIBRARY_PATH', '')])
    os.environ['DSH_VOICE_CUDA_LIBS_READY'] = '1'
    os.execv(sys.executable, [sys.executable, *sys.argv])
import argparse
import base64
import contextlib
import json
import time
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--backend', choices=['qwen', 'whisper'], required=True)
parser.add_argument('--model', required=True)
parser.add_argument('--device', choices=['cpu', 'cuda'], default='cuda')
args = parser.parse_args()
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

def emit(data):
    print(json.dumps(data, ensure_ascii=False), flush=True)

try:
    start = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        if args.backend == 'qwen':
            import torch
            from qwen_asr import Qwen3ASRModel
            if args.device == 'cuda' and not torch.cuda.is_available():
                raise RuntimeError('CUDA is unavailable; CPU fallback is disabled')
            model = Qwen3ASRModel.from_pretrained(
                args.model, dtype=torch.bfloat16 if args.device == 'cuda' else torch.float32,
                device_map='cuda:0' if args.device == 'cuda' else 'cpu',
                max_inference_batch_size=1, max_new_tokens=1024,
                attn_implementation='sdpa',
            )
        else:
            from faster_whisper import WhisperModel
            model = WhisperModel(args.model, device=args.device,
                compute_type='float16' if args.device == 'cuda' else 'int8',
                cpu_threads=4, num_workers=1, local_files_only=True)
    emit({'ready': True, 'backend': args.backend, 'device': args.device,
          'loadSeconds': time.perf_counter()-start})
except Exception as exc:
    emit({'ready': False, 'error': str(exc)})
    raise SystemExit(1)

for line in sys.stdin:
    req = {}
    try:
        req = json.loads(line)
        audio = np.frombuffer(base64.b64decode(req['audio'], validate=True), dtype='<i2').astype(np.float32)/32768
        if audio.size > 16000*120:
            raise ValueError('Recording exceeds 120 seconds')
        start = time.perf_counter()
        # 请求级的语言覆盖(host 按后端翻译好:qwen 收 'German' 这样的规范名,
        # whisper 收 'de' 这样的 ISO 码)。缺省 / 空串 = 自动检测。
        # 这里**不**做校验:取值由 asr-languages.js 那张表保证,后端自己会对
        # 非法值报错,而我们宁愿让它报错也不要静默当成自动检测(那会掩盖配置 bug)。
        want = req.get('language') or None
        with contextlib.redirect_stdout(sys.stderr):
            # Avoid transcribing digital silence (Whisper can hallucinate on it).
            if audio.size < 1600 or np.max(np.abs(audio), initial=0) < 0.001:
                text, language = '', ''
            elif args.backend == 'qwen':
                result = model.transcribe(audio=(audio, 16000), language=want)[0]
                text, language = result.text.strip(), result.language
                if args.device == 'cuda': torch.cuda.synchronize()
            else:
                segments, info = model.transcribe(audio, language=want,
                    beam_size=5, task='transcribe', condition_on_previous_text=False,
                    vad_filter=True)
                text = ''.join(segment.text for segment in segments).strip()
                language = info.language
        emit({'id': req['id'], 'text': text, 'language': language,
              'seconds': time.perf_counter()-start})
    except Exception as exc:
        emit({'id': req.get('id'), 'error': str(exc)})
