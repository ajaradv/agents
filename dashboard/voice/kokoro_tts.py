"""Local text-to-speech for the dashboard: Kokoro-82M (ONNX), one long-lived process.

Started by dashboard/lib/voice.ts with
  uv run --python 3.12 --with kokoro-onnx --with soundfile python -I kokoro_tts.py <model-dir>
Model files (kokoro-v1.0.int8.onnx, voices-v1.0.bin) live in <model-dir>; bin/voice-setup fetches them.

Protocol: one JSON object per line on stdin {"id", "text", "voice", "speed"};
one JSON object per line on stdout {"id", "ok", "wav" (base64 16-bit mono WAV) | "error"}.
The first line out is {"ready": true, "voices": [...]} once the model is loaded.
Kokoro only reads; it cannot answer the text instead of speaking it.
"""
import base64
import io
import json
import sys

import soundfile as sf
from kokoro_onnx import Kokoro


def main() -> None:
    model_dir = sys.argv[1]
    kokoro = Kokoro(f"{model_dir}/kokoro-v1.0.int8.onnx", f"{model_dir}/voices-v1.0.bin")
    voices = set(kokoro.get_voices())
    print(json.dumps({"ready": True, "voices": sorted(voices)}), flush=True)
    for raw in sys.stdin:
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            continue
        rid = req.get("id")
        try:
            text = str(req.get("text", "")).strip()[:4000]
            if not text:
                raise ValueError("empty text")
            voice = req.get("voice") if req.get("voice") in voices else "af_heart"
            speed = min(1.5, max(0.7, float(req.get("speed", 1.0))))
            samples, rate = kokoro.create(text, voice=voice, speed=speed, lang="en-gb" if voice.startswith("b") else "en-us")
            buf = io.BytesIO()
            sf.write(buf, samples, rate, format="WAV", subtype="PCM_16")
            out = {"id": rid, "ok": True, "wav": base64.b64encode(buf.getvalue()).decode()}
        except Exception as e:  # report and keep serving
            out = {"id": rid, "ok": False, "error": str(e)[:300]}
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
