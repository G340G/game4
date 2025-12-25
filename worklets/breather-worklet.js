/* AudioWorkletProcessor: breathing + sub wobble + faint clicks (safe + cheap) */
class BreatherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "breath", defaultValue: 0.28, minValue: 0.0, maxValue: 1.0 },
      { name: "fear", defaultValue: 0.10, minValue: 0.0, maxValue: 1.0 },
      { name: "gain", defaultValue: 0.20, minValue: 0.0, maxValue: 1.0 }
    ];
  }

  constructor() {
    super();
    this._t = 0;
    this._seed = 1337;
    this._lp = 0;
    this._clickPhase = 0;
  }

  _rand() {
    this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
    return (this._seed / 4294967296);
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    const ch0 = out[0];
    const ch1 = out[1] || out[0];

    const breathArr = parameters.breath;
    const fearArr = parameters.fear;
    const gainArr = parameters.gain;

    for (let i = 0; i < ch0.length; i++) {
      const breath = breathArr.length > 1 ? breathArr[i] : breathArr[0];
      const fear = fearArr.length > 1 ? fearArr[i] : fearArr[0];
      const gain = gainArr.length > 1 ? gainArr[i] : gainArr[0];

      const sr = sampleRate;

      // Breath envelope (slow)
      const rate = 0.18 + fear * 0.25;
      const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * rate * (this._t / sr));
      const inhale = Math.pow(env, 2.3); // shape

      // Pink-ish noise (simple low-pass on white)
      const white = (this._rand() * 2 - 1);
      this._lp = this._lp + 0.06 * (white - this._lp);
      const noise = this._lp;

      // Sub wobble
      const sub = Math.sin(2 * Math.PI * (34 + fear * 12) * (this._t / sr)) * (0.08 + fear * 0.10);

      // Little clicks (rare)
      this._clickPhase += (0.002 + fear * 0.01);
      let click = 0;
      if (this._clickPhase > 1.0) {
        this._clickPhase = 0;
        if (this._rand() < 0.12 + fear * 0.25) click = (this._rand() * 2 - 1) * 0.15;
      }

      const sig = (noise * (0.25 + breath * 0.55) * inhale) + sub + click;

      const v = sig * gain;
      ch0[i] = v;
      ch1[i] = v * (0.98 + 0.02 * Math.sin(2 * Math.PI * 0.5 * (this._t / sr)));

      this._t++;
    }

    return true;
  }
}

registerProcessor("breather", BreatherProcessor);
