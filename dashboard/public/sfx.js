// sfx.js - small non-verbal sounds for the voice modes (V4), synthesized with
// Web Audio so there are no clips to license: a rustle of papers or a page turn
// on rotation with the spoken acknowledgements, a quill scratch, and a soft
// chime when hands-free reopens the mic (the captain's cue to talk).
(() => {
  let ctx = null;

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  /** White noise, `secs` long. */
  function noise(c, secs) {
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * secs), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    return src;
  }

  /** One burst of filtered noise: a crackle of paper, a scratch of a nib. */
  function burst(c, at, { dur, freq, q = 1.2, gain = 0.25, type = "bandpass", sweepTo }) {
    const src = noise(c, dur + 0.05);
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, at);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.02, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(at);
    src.stop(at + dur + 0.05);
  }

  function tone(c, at, freq, dur, gain) {
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(c.destination);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  const SOUNDS = {
    /** A few sheets shuffled: short, bright crackles. */
    papers(c, t) {
      const n = 4 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) burst(c, t + i * (0.05 + Math.random() * 0.05), { dur: 0.05 + Math.random() * 0.07, freq: 2500 + Math.random() * 3000, q: 0.9, gain: 0.12 + Math.random() * 0.1 });
      return 0.5;
    },
    /** One page turned: a swept whoosh with a crisp end. */
    page(c, t) {
      burst(c, t, { dur: 0.32, freq: 900, sweepTo: 4500, q: 0.7, gain: 0.18 });
      burst(c, t + 0.28, { dur: 0.06, freq: 5200, q: 1.5, gain: 0.12 });
      return 0.4;
    },
    /** A quill's quick strokes. */
    quill(c, t) {
      for (let i = 0; i < 5; i++) burst(c, t + i * 0.09, { dur: 0.06, freq: 6000 + Math.random() * 1500, q: 3, gain: 0.06, type: "highpass" });
      return 0.5;
    },
    /** Two soft notes: "your turn" when hands-free opens the mic. */
    chime(c, t) {
      tone(c, t, 1318.5, 0.35, 0.06);
      tone(c, t + 0.09, 1975.5, 0.45, 0.05);
      return 0.55;
    },
  };

  window.FleetSfx = {
    names: Object.keys(SOUNDS),
    /** Create the audio context inside a tap (phones play nothing otherwise). */
    unlock() {
      audio();
    },
    /** Play a sound; resolves when it has finished (about half a second). */
    play(name) {
      const c = audio();
      const make = SOUNDS[name];
      if (!c || !make) return Promise.resolve();
      const secs = make(c, c.currentTime + 0.01);
      return new Promise((r) => setTimeout(r, secs * 1000));
    },
  };
})();
