// Conversation mode V1 (lib/live-voice.ts on the server): talk with an agent
// through Gemini Live. Microphone → 16 kHz PCM → /ws/voice/<agent>; the agent's
// 24 kHz PCM is played back to back. The captain can talk over the agent: a
// loudness gate stops playback at once, before the server's "interrupted".
class LiveVoice {
  constructor({ agent = "alice", onEvent = () => {}, onState = () => {} } = {}) {
    this.agent = agent;
    this.onEvent = onEvent;
    this.onState = onState;
    this.state = "off";
    this.loud = 0;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.onState(s);
  }

  async start() {
    this.setState("connecting");
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch {
      this.onEvent({ type: "error", message: "The microphone is blocked; allow it for this site and try again." });
      return this.stop();
    }
    this.inCtx = new AudioContext({ sampleRate: 16000 });
    this.outCtx = new AudioContext({ sampleRate: 24000 });
    await this.inCtx.audioWorklet.addModule("/pcm-capture.js");
    this.sources = new Set();
    this.playHead = 0;
    this.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/voice/${this.agent}`);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => (typeof e.data === "string" ? this.event(JSON.parse(e.data)) : this.play(e.data));
    this.ws.onclose = () => this.stop();
    const node = new AudioWorkletNode(this.inCtx, "pcm-capture");
    node.port.onmessage = (e) => {
      if (this.ready && this.ws.readyState === 1) this.ws.send(e.data.pcm);
      this.gate(e.data.rms);
    };
    this.inCtx.createMediaStreamSource(this.mic).connect(node);
    this.node = node;
  }

  event(e) {
    if (e.type === "ready") {
      this.ready = true;
      this.setState("listening");
    }
    if (e.type === "interrupted") this.stopPlayback();
    this.onEvent(e);
  }

  /** One chunk of the agent's voice, queued right after the previous one. */
  play(data) {
    const pcm = new Int16Array(data);
    if (!pcm.length || !this.outCtx) return;
    const buf = this.outCtx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = this.outCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outCtx.destination);
    const at = Math.max(this.outCtx.currentTime + 0.02, this.playHead);
    src.start(at);
    this.playHead = at + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size && this.state === "speaking") this.setState("listening");
    };
    this.setState("speaking");
  }

  stopPlayback() {
    for (const s of this.sources || []) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources?.clear();
    if (this.outCtx) this.playHead = this.outCtx.currentTime;
    if (this.state === "speaking") this.setState("listening");
  }

  /** Barge-in: two loud chunks (80 ms) while the agent speaks stop its voice here and now. */
  gate(rms) {
    this.loud = rms > 0.045 ? this.loud + 1 : 0;
    if (this.loud >= 2 && this.state === "speaking") {
      this.stopPlayback();
      this.onEvent({ type: "barge" });
    }
  }

  /** Type a line into the live talk instead of speaking it. */
  say(text) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: "text", text }));
  }

  stop() {
    if (this.state === "off") return;
    try {
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: "end" }));
      this.ws?.close();
    } catch {
      /* closing */
    }
    this.stopPlayback();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.inCtx?.close().catch(() => {});
    this.outCtx?.close().catch(() => {});
    this.ready = false;
    this.setState("off");
  }
}
window.LiveVoice = LiveVoice;
