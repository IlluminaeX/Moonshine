// The "someone joined" sounds, made with the Web Audio API (no sound files to ship). Each one is a
// short, soft, rising phrase of layered tones with a gentle echo, so it reads as "connected" rather
// than "alert". Used by the notification popup and by the preview button in Settings.
(() => {
  const NOTE = { C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, B5: 987.77, C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, B6: 1975.53, F5: 698.46, A4: 440, E4: 329.63 };

  /** One tone: a sine body plus quieter overtones, a soft attack and a long natural fade. */
  function tone(ctx, out, { freq, at = 0, dur = 0.9, gain = 0.2, overtones = [[2, 0.25], [3, 0.08]], attack = 0.012, type = 'sine' }) {
    const t = ctx.currentTime + at;
    for (const [mult, level] of [[1, 1], ...overtones]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq * mult;
      const peak = gain * level;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur / (mult > 1 ? 1 + mult * 0.35 : 1));
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }

  /** A bell: inharmonic partials that die away at different speeds. */
  function bell(ctx, out, { freq, at = 0, gain = 0.16, dur = 1.6 }) {
    const t = ctx.currentTime + at;
    for (const [mult, level, life] of [[1, 1, 1], [2.76, 0.35, 0.45], [5.4, 0.12, 0.2]]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain * level, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * life);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + dur * life + 0.05);
    }
  }

  /** A short pluck: a bright start that settles quickly, like a harp string. */
  function pluck(ctx, out, { freq, at = 0, gain = 0.2, dur = 1.1 }) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq * 9, t);
    filter.frequency.exponentialRampToValueAtTime(freq * 1.5, t + 0.35);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(filter).connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** A water-drop glide: the pitch slides up quickly as it fades in, then rings. */
  function drop(ctx, out, { from, to, at = 0, gain = 0.22, dur = 0.7 }) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  const SOUNDS = [
    { id: 'aurora', name: 'Aurora', desc: 'A soft rising arpeggio',
      play: (c, o) => [['C5', 0], ['E5', 0.11], ['G5', 0.22], ['C6', 0.33]].forEach(([n, at], i) => tone(c, o, { freq: NOTE[n], at, dur: i === 3 ? 1.5 : 0.9, gain: 0.17 })) },
    { id: 'glass', name: 'Glass', desc: 'Two clear bell notes',
      play: (c, o) => { bell(c, o, { freq: NOTE.E6, at: 0 }); bell(c, o, { freq: NOTE.B6, at: 0.17, gain: 0.13, dur: 1.9 }); } },
    { id: 'harp', name: 'Harp', desc: 'A gentle plucked run',
      play: (c, o) => ['G5', 'A5', 'C6', 'D6', 'G6'].forEach((n, i) => pluck(c, o, { freq: NOTE[n], at: i * 0.075, gain: 0.15, dur: i === 4 ? 1.4 : 0.9 })) },
    { id: 'droplet', name: 'Droplet', desc: 'Two quick water drops',
      play: (c, o) => { drop(c, o, { from: 700, to: 1500, at: 0 }); drop(c, o, { from: 900, to: 2000, at: 0.2, gain: 0.17, dur: 0.9 }); } },
    { id: 'warm', name: 'Warm', desc: 'A calm, full “connected” chord',
      play: (c, o) => { tone(c, o, { freq: NOTE.A4, at: 0, dur: 1.6, gain: 0.13 }); tone(c, o, { freq: NOTE.E5, at: 0.09, dur: 1.5, gain: 0.12 }); tone(c, o, { freq: NOTE.A5, at: 0.18, dur: 1.7, gain: 0.12 }); tone(c, o, { freq: NOTE.E6, at: 0.3, dur: 1.9, gain: 0.08, overtones: [] }); } },
  ];

  /** Play a sound by id at a gentle volume. */
  function play(id) {
    const sound = SOUNDS.find((s) => s.id === id) || SOUNDS[0];
    try {
      const ctx = new AudioContext();
      // Everything goes through a small echo and a limiter, so overlapping notes never crackle
      const master = ctx.createGain();
      master.gain.value = 0.9;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.ratio.value = 6;
      const echo = ctx.createDelay(0.5);
      echo.delayTime.value = 0.17;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.28;
      const soften = ctx.createBiquadFilter();
      soften.type = 'lowpass';
      soften.frequency.value = 3200;
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      master.connect(limiter);
      master.connect(echo);
      echo.connect(soften).connect(feedback).connect(echo);
      soften.connect(wet).connect(limiter);
      limiter.connect(ctx.destination);
      sound.play(ctx, master);
      setTimeout(() => ctx.close(), 3500);
    } catch {
      // no audio device: the popup still shows
    }
  }

  window.MoonshineSounds = { list: SOUNDS.map(({ id, name, desc }) => ({ id, name, desc })), play };
})();
