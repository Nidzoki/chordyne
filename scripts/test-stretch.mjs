import { timeStretch } from "../src/audio/stretch.js";
import { fft } from "../src/analysis/fft.js";

const SR = 44100;

function synthSine(freq, seconds, sr) {
  const n = Math.floor(seconds * sr);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.sin((2 * Math.PI * freq * i) / sr) * 0.8;
  return buf;
}

function fakeBuffer(channelData, sr) {
  return {
    numberOfChannels: 1, length: channelData.length, sampleRate: sr,
    duration: channelData.length / sr, getChannelData: () => channelData,
  };
}

// dominant frequency via FFT on a window from the middle of the signal —
// avoids the WSOLA frame edges (first/last FRAME samples) where alignment
// search has nothing to search against
function dominantFreq(data, sr) {
  const N = 8192;
  const start = Math.max(0, Math.floor(data.length / 2 - N / 2));
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); // Hann
    re[i] = (data[start + i] || 0) * w;
  }
  fft(re, im);
  let bestBin = 1, bestMag = 0;
  for (let k = 1; k < N / 2; k++) {
    const mag = Math.hypot(re[k], im[k]);
    if (mag > bestMag) { bestMag = mag; bestBin = k; }
  }
  return (bestBin * sr) / N;
}

// simulates what AudioBufferSourceNode.playbackRate does to a buffer:
// linear-interpolation resample by `rate` (rate>1 = faster/shorter/higher-pitched)
function resample(data, rate) {
  const outLen = Math.floor(data.length / rate);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * rate;
    const i0 = Math.floor(srcPos), frac = srcPos - i0;
    const a = data[i0] || 0, b = data[i0 + 1] || 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function pct(a, b) { return (Math.abs(a - b) / b) * 100; }

let allPass = true;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  if (!ok) allPass = false;
}

// ---- test 1: tempo-only (stretch alone, no resample) — duration changes,
// pitch (frequency) must stay the same ----
{
  const freq = 440;
  const input = synthSine(freq, 6, SR);
  const stretchFactor = 1 / 1.3; // 130% tempo -> 1/1.3 duration
  const out = await timeStretch(fakeBuffer(input, SR), stretchFactor);
  const outFreq = dominantFreq(out.getChannelData(0), SR);
  const expectedDur = input.length / SR * stretchFactor;
  console.log(`\n== tempo-only: 130% speed on a 440Hz tone ==`);
  console.log(`  duration: got ${(out.length / SR).toFixed(3)}s, want ~${expectedDur.toFixed(3)}s`);
  console.log(`  frequency: got ${outFreq.toFixed(1)}Hz, want ~${freq}Hz (pitch preserved)`);
  check("duration matches target speed within 2%", pct(out.length / SR, expectedDur) < 2);
  check("pitch preserved within 2%", pct(outFreq, freq) < 2);
}

// ---- test 2: slow down (70% tempo) — duration longer, pitch still preserved ----
{
  const freq = 220;
  const input = synthSine(freq, 5, SR);
  const stretchFactor = 1 / 0.7;
  const out = await timeStretch(fakeBuffer(input, SR), stretchFactor);
  const outFreq = dominantFreq(out.getChannelData(0), SR);
  const expectedDur = input.length / SR * stretchFactor;
  console.log(`\n== tempo-only: 70% speed (slow down) on a 220Hz tone ==`);
  console.log(`  duration: got ${(out.length / SR).toFixed(3)}s, want ~${expectedDur.toFixed(3)}s`);
  console.log(`  frequency: got ${outFreq.toFixed(1)}Hz, want ~${freq}Hz (pitch preserved)`);
  check("duration matches target speed within 2%", pct(out.length / SR, expectedDur) < 2);
  check("pitch preserved within 2%", pct(outFreq, freq) < 2);
}

// ---- test 3: pitch-only (transpose +3 semitones, tempo preserved) — the
// actual composition engine.js uses: stretch by pitchRatio, then play the
// result at rate=pitchRatio ----
{
  const freq = 261.63; // C4
  const semitones = 3;
  const pitchRatio = 2 ** (semitones / 12);
  const input = synthSine(freq, 5, SR);
  const stretched = await timeStretch(fakeBuffer(input, SR), pitchRatio);
  const finalData = resample(stretched.getChannelData(0), pitchRatio);
  const outFreq = dominantFreq(finalData, SR);
  const expectedFreq = freq * pitchRatio;
  console.log(`\n== pitch-only: +3 semitones on a 261.63Hz (C4) tone ==`);
  console.log(`  duration: got ${(finalData.length / SR).toFixed(3)}s, want ~${(input.length / SR).toFixed(3)}s (tempo preserved)`);
  console.log(`  frequency: got ${outFreq.toFixed(1)}Hz, want ~${expectedFreq.toFixed(1)}Hz (D#4/Eb4)`);
  check("duration (tempo) preserved within 2%", pct(finalData.length / SR, input.length / SR) < 2);
  check("pitch shifted to target within 2%", pct(outFreq, expectedFreq) < 2);
}

// ---- test 4: pitch-only, transpose down (-5 semitones) ----
{
  const freq = 392.0; // G4
  const semitones = -5;
  const pitchRatio = 2 ** (semitones / 12);
  const input = synthSine(freq, 5, SR);
  const stretched = await timeStretch(fakeBuffer(input, SR), pitchRatio);
  const finalData = resample(stretched.getChannelData(0), pitchRatio);
  const outFreq = dominantFreq(finalData, SR);
  const expectedFreq = freq * pitchRatio;
  console.log(`\n== pitch-only: -5 semitones on a 392Hz (G4) tone ==`);
  console.log(`  duration: got ${(finalData.length / SR).toFixed(3)}s, want ~${(input.length / SR).toFixed(3)}s (tempo preserved)`);
  console.log(`  frequency: got ${outFreq.toFixed(1)}Hz, want ~${expectedFreq.toFixed(1)}Hz (D4)`);
  check("duration (tempo) preserved within 2%", pct(finalData.length / SR, input.length / SR) < 2);
  check("pitch shifted to target within 2%", pct(outFreq, expectedFreq) < 2);
}

// ---- test 5: combined tempo+pitch (the general case engine.js composes) ----
{
  const freq = 329.63; // E4
  const tempoRatio = 1.2;   // 120% speed
  const semitones = -2;
  const pitchRatio = 2 ** (semitones / 12);
  const input = synthSine(freq, 6, SR);
  const stretchFactor = pitchRatio / tempoRatio;
  const stretched = await timeStretch(fakeBuffer(input, SR), stretchFactor);
  const finalData = resample(stretched.getChannelData(0), pitchRatio);
  const outFreq = dominantFreq(finalData, SR);
  const expectedFreq = freq * pitchRatio;
  const expectedDur = (input.length / SR) / tempoRatio;
  console.log(`\n== combined: 120% tempo AND -2 semitones on a 329.63Hz (E4) tone ==`);
  console.log(`  duration: got ${(finalData.length / SR).toFixed(3)}s, want ~${expectedDur.toFixed(3)}s`);
  console.log(`  frequency: got ${outFreq.toFixed(1)}Hz, want ~${expectedFreq.toFixed(1)}Hz`);
  check("duration matches tempo target within 2.5%", pct(finalData.length / SR, expectedDur) < 2.5);
  check("pitch shifted to target within 2%", pct(outFreq, expectedFreq) < 2);
}

console.log(`\n${allPass ? "ALL PASS" : "SOME FAILED"}`);
