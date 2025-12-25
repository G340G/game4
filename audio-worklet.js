// audio-worklet.js
// A small ominous engine: drone + breathing + intermittent sub pulses + noise.
// Intentionally “PS2-ish”: bandlimited, unstable, slightly crushed.

class OminousProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "gain", defaultValue: 0.18, minValue: 0.0, maxValue: 1.0 },
      { name: "fear", defaultValue: 0.0, minValue: 0.0, maxValue: 1.0 } // sanity inverse
    ];
  }

  constructor() {
    super();
    this.t = 0;
    this.lp = 0;
    this.bp = 0;
    this.breathPhase = 0;
    this.pulsePhase = 0;
    this.rng = 1234567;
  }

  rand() {
    // xorshift-ish
    let x = this.rng | 0;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    this.rng = x;
    return ((x >>> 0) / 4294967295);
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    const ch0 = out[0];
    const ch1 = out[1] || out[0];

    const gainArr = parameters.gain;
    const fearArr = parameters.fear;

    for (let i = 0; i < ch0.length; i++) {
      const gain = gainArr.length > 1 ? gainArr[i] : gainArr[0];
      const fear = fearArr.length > 1 ? fearArr[i] : fearArr[0];

      // Drone base: two detuned sines + slight warble
      const warble = Math.sin(this.t * (0.25 + fear * 0.6)) * (0.002 + fear * 0.01);
      const f1 = 48 + fear * 12;
      const f2 = 55 + fear * 15;

      const s1 = Math.sin(2 * Math.PI * (f1 + warble * 200) * (this.t / sampleRate));
      const s2 = Math.sin(2 * Math.PI * (f2 - warble * 180) * (this.t / sampleRate));

      // Breathing: amplitude envelope + filtered noise
      this.breathPhase += (0.18 + fear * 0.28) / sampleRate;
      if (this.breathPhase > 1) this.breathPhase -= 1;

      const breathEnv = Math.pow(Math.sin(this.breathPhase * Math.PI), 2) * (0.35 + fear * 0.45);
      let n = (this.rand() * 2 - 1);

      // simple lowpass on noise for “air”
      this.lp += (n - this.lp) * (0.02 + fear * 0.04);
      const breath = this.lp * breathEnv;

      // Pulse: sub hit that becomes more frequent with fear
      this.pulsePhase += (0.04 + fear * 0.12) / sampleRate;
      if (this.pulsePhase > 1) this.pulsePhase -= 1;
      const pulseTrig = this.pulsePhase < 0.0005 ? 1 : 0;

      if (pulseTrig) this.bp = 1.0;
      this.bp *= (0.9992 - fear * 0.0005);
      const pulse = Math.sin(2 * Math.PI * (32 + fear * 10) * (this.t / sampleRate)) * this.bp * (0.22 + fear * 0.25);

      // gentle bitcrush feel (quantize)
      let sig = (s1 * 0.32 + s2 * 0.26) + breath * 0.55 + pulse;
      const crush = 1 / (64 + Math.floor(fear * 120));
      sig = Math.round(sig / crush) * crush;

      // mild saturation
      sig = Math.tanh(sig * (1.2 + fear * 1.2));

      const final = sig * gain;

      // stereo smear
      const pan = (Math.sin(this.t * 0.0007) * 0.35);
      ch0[i] = final * (0.92 - pan);
      ch1[i] = final * (0.92 + pan);

      this.t++;
    }
    return true;
  }
}

registerProcessor("ominous-processor", OminousProcessor);
