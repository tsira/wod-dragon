/* WOD DRAGON — Plate Stack foley, procedurally synthesized in WebAudio.
   Interim while AI SFX generation tooling is down; parameters tuned to read as
   gym metal. Each function is one cue. No assets, works offline. */
'use strict';

const Foley = (() => {
  let ctx = null;
  function ac() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); return ctx; }

  function noiseBuffer(sec) {
    const a = ac(), b = a.createBuffer(1, a.sampleRate * sec, a.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /* metallic partial: inharmonic sine with fast exponential decay */
  function partial(freq, gain, decay, when = 0, type = 'sine') {
    const a = ac(), o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, a.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + when + decay);
    o.connect(g).connect(a.destination);
    o.start(a.currentTime + when); o.stop(a.currentTime + when + decay + 0.05);
  }

  /* filtered noise burst: impact transient / scrape */
  function burst({ dur = 0.06, gain = 0.5, freq = 3000, q = 1, when = 0, sweepTo = null }) {
    const a = ac(), src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = noiseBuffer(dur + 0.05);
    f.type = 'bandpass'; f.frequency.setValueAtTime(freq, a.currentTime + when); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, a.currentTime + when + dur);
    g.gain.setValueAtTime(gain, a.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + when + dur);
    src.connect(f).connect(g).connect(a.destination);
    src.start(a.currentTime + when);
  }

  return {
    unlock() { ac().resume && ac().resume(); },

    /* Round transition: bumper slides on and clanks against the stack */
    plateClank() {
      burst({ dur: 0.10, gain: 0.5, freq: 900, q: 0.8 });                  // rubber/steel thud
      [1244, 1861, 2653, 3322].forEach((f, i) =>
        partial(f, 0.16 / (i + 1), 0.34 + i * 0.05, 0.012));               // ring of the stack
      burst({ dur: 0.25, gain: 0.10, freq: 5200, q: 3, when: 0.02 });      // sizzle tail
    },

    /* Segment start: collar spun on and snapped */
    collarClick() {
      burst({ dur: 0.05, gain: 0.32, freq: 4200, q: 4, sweepTo: 2400 });   // spin zip
      partial(3050, 0.14, 0.10, 0.05);                                     // snap
      partial(4570, 0.08, 0.07, 0.05);
    },

    /* Final-3s tick: knurling scrape (call once per second) */
    knurlTick() {
      burst({ dur: 0.05, gain: 0.34, freq: 2600, q: 6, sweepTo: 3400 });
    },

    /* Workout done: loaded bar dropped from overhead */
    barDrop() {
      const bounce = (t, g) => {
        burst({ dur: 0.09, gain: g, freq: 320, q: 0.7, when: t });         // floor thud
        partial(58, g * 0.9, 0.30, t);                                     // sub weight
        [1244, 1861, 2653].forEach((f, i) => partial(f, g * 0.22 / (i + 1), 0.4, t + 0.01));
      };
      bounce(0, 0.85); bounce(0.42, 0.4); bounce(0.68, 0.18);              // drop + bounces
      burst({ dur: 0.7, gain: 0.08, freq: 900, q: 0.5, when: 0.05 });      // room rumble
    },

    /* Rest begins: chalk clap */
    chalkClap() {
      burst({ dur: 0.08, gain: 0.4, freq: 1400, q: 0.6 });
      burst({ dur: 0.35, gain: 0.12, freq: 800, q: 0.4, when: 0.04 });     // dust bloom
    },
  };
})();

if (typeof module !== 'undefined') module.exports = Foley;
