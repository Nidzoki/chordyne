// Probe script: validates the essentia.js API surface actually works before
// it gets wired into the real detection pipeline. Run with:
//   npm install essentia.js
//   node scripts/test-essentia.mjs
//
// This is deliberately isolated from src/ — if any of the API calls below
// are wrong (import paths, method names, return field names), this fails
// fast and cheaply instead of breaking the whole app. Paste the output back
// so the integration in src/analysis/ can be corrected before it's real.

import path from "node:path";
import { fileURLToPath } from "node:url";

// essentia.js's .es.js build is emscripten glue that still references
// __dirname (a CommonJS/Node global) to locate the .wasm binary — not
// defined in real ESM. Polyfill it to point at the package's dist folder.
globalThis.__dirname = path.dirname(
  fileURLToPath(await import.meta.resolve("essentia.js/dist/essentia-wasm.es.js"))
);

const SR = 44100;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function synthChord(freqs, seconds, sr) {
  const n = Math.floor(seconds * sr);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const f of freqs) s += Math.sin((2 * Math.PI * f * i) / sr);
    buf[i] = (s / freqs.length) * 0.8;
  }
  return buf;
}

async function main() {
  console.log("1. Importing essentia.js...");
  let Essentia, EssentiaWASM, EssentiaExtractor;
  try {
    ({ default: Essentia } = await import("essentia.js/dist/essentia.js-core.es.js"));
    ({ EssentiaWASM } = await import("essentia.js/dist/essentia-wasm.es.js"));
    console.log("   core + wasm import OK");
  } catch (e) {
    console.log("   FAILED to import core/wasm:", e.message);
    console.log("   try: import Essentia from 'essentia.js' (default export) as a fallback shape");
    return;
  }

  let extractorOk = true;
  try {
    ({ default: EssentiaExtractor } = await import("essentia.js/dist/essentia.js-extractor.es.js"));
    console.log("   extractor import OK");
  } catch (e) {
    extractorOk = false;
    console.log("   extractor import FAILED (non-fatal, will test core HPCP path instead):", e.message);
  }

  console.log("\n2. Initialising Essentia (WASM)...");
  const essentia = new Essentia(EssentiaWASM);
  console.log("   version:", essentia.version || "(no .version field)");

  console.log("\n3. Building a test frame (C major: C4 E4 G4)...");
  const frameSize = 4096;
  const cMajor = synthChord([261.63, 329.63, 392.0], 1, SR);
  const frame = cMajor.slice(0, frameSize);

  if (extractorOk) {
    console.log("\n4. Trying EssentiaExtractor.hpcpExtractor(frame, sampleRate)...");
    try {
      const extractor = new EssentiaExtractor(EssentiaWASM);
      const hpcp = extractor.hpcpExtractor(frame, SR);
      console.log("   result type:", typeof hpcp, Array.isArray(hpcp) ? `array len=${hpcp.length}` : hpcp);
      if (hpcp && hpcp.length === 12) {
        console.log("   raw HPCP (index 0 should be A per docs):");
        console.log("   ", Array.from(hpcp).map((x, i) => `${i}=${x.toFixed(3)}`).join(" "));
        // rotate A-indexed -> C-indexed: myChroma[i] = hpcp[(i+3)%12]
        const rotated = Array.from({ length: 12 }, (_, i) => hpcp[(i + 3) % 12]);
        console.log("   rotated to C-indexed:");
        console.log("   ", rotated.map((x, i) => `${NOTE_NAMES[i]}=${x.toFixed(3)}`).join(" "));
        const top3 = rotated.map((v, i) => [NOTE_NAMES[i], v]).sort((a, b) => b[1] - a[1]).slice(0, 3);
        console.log("   top 3 pitch classes:", top3.map(([n, v]) => `${n}(${v.toFixed(3)})`).join(", "));
        console.log("   EXPECT: C, E, G should be the top 3 (that's the test chord). If not, the A->C rotation is wrong.");
      } else {
        console.log("   UNEXPECTED SHAPE — not a 12-length array. Inspect manually:", hpcp);
      }
    } catch (e) {
      console.log("   FAILED:", e.message);
      console.log(e.stack);
    }
  }

  console.log("\n5. Trying core HPCP pipeline (Windowing -> Spectrum -> SpectralPeaks -> HPCP)...");
  try {
    const win = essentia.Windowing(essentia.arrayToVector(frame));
    console.log("   Windowing output keys:", Object.keys(win));
    const spec = essentia.Spectrum(win.frame);
    console.log("   Spectrum output keys:", Object.keys(spec));
    const peaks = essentia.SpectralPeaks(spec.spectrum);
    console.log("   SpectralPeaks output keys:", Object.keys(peaks));
    const hpcpResult = essentia.HPCP(peaks.frequencies, peaks.magnitudes);
    console.log("   HPCP output keys:", Object.keys(hpcpResult));
    const hpcpArr = essentia.vectorToArray(hpcpResult.hpcp);
    console.log("   HPCP array:", Array.from(hpcpArr).map((x) => x.toFixed(3)).join(" "));
  } catch (e) {
    console.log("   FAILED:", e.message);
    console.log(e.stack);
  }

  console.log("\n6. Trying ChordsDetection on a short HPCP sequence...");
  try {
    const seq = new essentia.module.VectorVectorFloat();
    const win2 = essentia.Windowing(essentia.arrayToVector(frame));
    const spec2 = essentia.Spectrum(win2.frame);
    const peaks2 = essentia.SpectralPeaks(spec2.spectrum);
    const hpcp2 = essentia.HPCP(peaks2.frequencies, peaks2.magnitudes);
    for (let i = 0; i < 10; i++) seq.push_back(hpcp2.hpcp); // repeat one frame just to exercise the call
    const chords = essentia.ChordsDetection(seq, 2048, SR, 2);
    console.log("   ChordsDetection output keys:", Object.keys(chords));
    const chordArr = [];
    for (let i = 0; i < chords.chords.size(); i++) chordArr.push(chords.chords.get(i));
    const strengthArr = [];
    for (let i = 0; i < chords.strength.size(); i++) strengthArr.push(chords.strength.get(i));
    console.log("   chords:", chordArr);
    console.log("   strength:", strengthArr.map((x) => x.toFixed(3)));
  } catch (e) {
    console.log("   FAILED:", e.message);
    console.log(e.stack);
  }

  console.log("\nDone. Paste this whole output back.");
}

main().catch((e) => {
  console.log("FATAL:", e.message);
  console.log(e.stack);
});
