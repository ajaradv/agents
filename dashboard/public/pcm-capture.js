// AudioWorklet for conversation mode: the microphone as 16-bit PCM chunks of
// 40 ms at the context's rate (16 kHz), each with its loudness (RMS) so the
// page can cut the agent's voice the moment the captain speaks (barge-in).
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = Math.round(sampleRate * 0.04);
    this.buf = new Float32Array(this.frame);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.frame) {
        const pcm = new Int16Array(this.frame);
        let sum = 0;
        for (let j = 0; j < this.frame; j++) {
          const s = Math.max(-1, Math.min(1, this.buf[j]));
          sum += s * s;
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / this.frame) }, [pcm.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
