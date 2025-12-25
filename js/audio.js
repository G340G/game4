export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.breather = null;
    this.drone = null;
    this.noise = null;
    this.filter = null;
    this.started = false;
    this.ttsEnabled = true;
    this._lastSpoke = 0;
  }

  async start() {
    if (this.started) return;
    this.started = true;

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.audioWorklet.addModule("./worklets/breather-worklet.js");

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(this.ctx.destination);

    // Breather worklet (fixes ScriptProcessor deprecation)
    this.breather = new AudioWorkletNode(this.ctx, "breather", { numberOfOutputs: 1, outputChannelCount: [2] });
    const breathGain = this.ctx.createGain();
    breathGain.gain.value = 0.65;
    this.breather.connect(breathGain).connect(this.master);

    // Ominous drone: detuned oscillators + filter
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 280;
    this.filter.Q.value = 0.8;

    const dGain = this.ctx.createGain();
    dGain.gain.value = 0.22;

    const o1 = this.ctx.createOscillator();
    const o2 = this.ctx.createOscillator();
    const o3 = this.ctx.createOscillator();
    o1.type = "sawtooth";
    o2.type = "triangle";
    o3.type = "sine";

    o1.frequency.value = 55;
    o2.frequency.value = 55 * 1.005;
    o3.frequency.value = 27.5;

    // Slow LFO warble
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.type = "sine";
    lfo.frequency.value = 0.08;
    lfoGain.gain.value = 9.0;
    lfo.connect(lfoGain);
    lfoGain.connect(this.filter.frequency);

    o1.connect(dGain);
    o2.connect(dGain);
    o3.connect(dGain);
    dGain.connect(this.filter).connect(this.master);

    // Subtle wind/noise layer (bandpass)
    const n = this.ctx.createBufferSource();
    n.buffer = this._makeNoiseBuffer(2.5);
    n.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 420;
    bp.Q.value = 0.9;
    const nGain = this.ctx.createGain();
    nGain.gain.value = 0.05;
    n.connect(bp).connect(nGain).connect(this.master);

    // Start nodes
    lfo.start();
    o1.start(); o2.start(); o3.start();
    n.start();

    this.drone = { o1, o2, o3, lfo, dGain };
    this.noise = { n, bp, nGain };

    // Slight fade-in to avoid pop
    this.master.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    this.master.gain.exponentialRampToValueAtTime(0.85, this.ctx.currentTime + 1.0);
  }

  setSanity01(s01) {
    if (!this.ctx) return;
    const fear = 1.0 - s01;

    // Breather reacts to fear
    this.breather.parameters.get("fear").setTargetAtTime(fear, this.ctx.currentTime, 0.05);
    this.breather.parameters.get("breath").setTargetAtTime(0.22 + fear * 0.55, this.ctx.currentTime, 0.06);
    this.breather.parameters.get("gain").setTargetAtTime(0.14 + fear * 0.22, this.ctx.currentTime, 0.08);

    // Drone filter closes as sanity drops
    this.filter.frequency.setTargetAtTime(260 - fear * 160, this.ctx.currentTime, 0.08);
    this.drone.dGain.gain.setTargetAtTime(0.18 + fear * 0.18, this.ctx.currentTime, 0.08);

    // Wind rises
    this.noise.nGain.gain.setTargetAtTime(0.04 + fear * 0.09, this.ctx.currentTime, 0.08);
  }

  speak(text, { rate = 1.02, pitch = 0.80, volume = 0.85 } = {}) {
    if (!this.ttsEnabled) return;
    const now = performance.now();
    if (now - this._lastSpoke < 650) return; // avoid spam
    this._lastSpoke = now;

    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    u.pitch = pitch;
    u.volume = volume;
    // pick an English/Italian-ish voice if available
    const voices = speechSynthesis.getVoices();
    const v = voices.find(v => /en|it/i.test(v.lang)) || voices[0];
    if (v) u.voice = v;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  _makeNoiseBuffer(seconds) {
    const length = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let x = 0;
    for (let i = 0; i < length; i++) {
      // light “windy” noise
      x = x + 0.02 * ((Math.random() * 2 - 1) - x);
      data[i] = x;
    }
    return buf;
  }
}

