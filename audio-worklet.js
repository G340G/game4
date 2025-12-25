/* audio-worklet.js
   Replaces ScriptProcessorNode (deprecated) with an AudioWorkletProcessor.
   Provides: ominous drone + breathing + intermittent “teeth” noise + simple TTS “ducking” hook.
*/

class OminousProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "gain", defaultValue: 0.22, minValue: 0, maxValue: 1 },
      { name: "fear", defaultValue: 0.0, minValue: 0, maxValue: 1 }, // driven by sanity
      { name: "breath", defaultValue: 0.6, minValue: 0, maxValue: 1 }
    ];
  }

  constructor() {
    super();
    this.t = 0;
    this.sr = sampleRate;
    this.lp = 0;
    this.hp = 0;
    this.noiseSeed = 1337;
    this.phaseA = 0;
    this.phaseB = 0;
    this.phaseC = 0;
    this.breathPhase = 0;
    this.gate = 0;
    this.gateVel = 0;
  }

  rnd() {
    // xorshift-ish
    let x = this.noiseSeed | 0;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    this.noiseSeed = x;
    return ((x >>> 0) / 4294967295);
  }

  softclip(x) {
    // gentle saturation
    const a = 1.25;
    return Math.tanh(a * x);
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    const ch0 = out[0];
    const ch1 = out[1] || out[0];

    const gainArr = parameters.gain;
    const fearArr = parameters.fear;
    const breathArr = parameters.breath;

    for (let i = 0; i < ch0.length; i++) {
      const gain = gainArr.length > 1 ? gainArr[i] : gainArr[0];
      const fear = fearArr.length > 1 ? fearArr[i] : fearArr[0];
      const breath = breathArr.length > 1 ? breathArr[i] : breathArr[0];

      // slow breathing envelope (0..1)
      this.breathPhase += (0.06 + 0.12 * fear) / this.sr * 2 * Math.PI;
      const breathEnv = 0.5 + 0.5 * Math.sin(this.breathPhase);
      const breathAmp = (0.12 + 0.28 * breath) * (0.35 + 0.65 * breathEnv);

      // drone oscillators (detuned) — becomes “sicker” with fear
      const base = 34 + 28 * fear; // Hz
      const det = 0.65 + 0.9 * fear;

      this.phaseA += (base) / this.sr * 2 * Math.PI;
      this.phaseB += (base * (1 + 0.01 * det)) / this.sr * 2 * Math.PI;
      this.phaseC += (base * (2 + 0.02 * det)) / this.sr * 2 * Math.PI;

      const a = Math.sin(this.phaseA);
      const b = Math.sin(this.phaseB + 0.2);
      const c = Math.sin(this.phaseC);

      let drone = 0.55 * a + 0.32 * b + 0.18 * c;

      // add “teeth” noise bursts (rare, more frequent with fear)
      const burstChance = 0.0004 + 0.0018 * fear;
      if (this.rnd() < burstChance) {
        this.gateVel = 0.6 + 0.7 * fear;
      }
      this.gateVel *= 0.9992;
      this.gate = Math.min(1, Math.max(0, this.gate + this.gateVel - 0.008));

      // raw noise
      let n = (this.rnd() * 2 - 1);

      // simple filters:
      // lowpass for “wind”
      const lpCut = 0.02 + 0.06 * fear;
      this.lp = this.lp + lpCut * (n - this.lp);
      // highpass-ish from drone (remove DC-ish)
      const hpCut = 0.001 + 0.01 * fear;
      this.hp = this.hp + hpCut * (drone - this.hp);

      const wind = this.lp;
      const breathNoise = (wind * breathAmp);

      const teeth = (n * n * n) * (0.10 + 0.45 * fear) * this.gate;

      let sig = 0.55 * this.hp + breathNoise + teeth;

      // subtle ring-mod for “wrongness”
      const rm = Math.sin((2 + 6 * fear) * this.t);
      sig *= (0.82 + 0.18 * rm);

      sig = this.softclip(sig);

      // final gain
      const s = sig * gain;

      ch0[i] = s;
      ch1[i] = s;

      this.t += 2 * Math.PI / this.sr;
    }

    return true;
  }
}

registerProcessor("ominous-processor", OminousProcessor);
