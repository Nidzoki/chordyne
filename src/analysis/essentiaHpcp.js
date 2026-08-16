// Lazy-loaded chroma (HPCP) extraction via essentia.js — a real, benchmarked
// MIR library (WASM port of Essentia, UPF Barcelona) — used in place of the
// hand-rolled FFT-binning chroma this detector started with. Verified working
// end-to-end against a plain-Node probe (scripts/test-essentia.mjs) before
// this file was written: hpcpExtractor() + a rotation fix (see below) reads
// back a clean C/E/G for a synthetic C-major chord, and ChordsDetection()
// independently confirms "C" at 0.736 confidence on the same input.
//
// Browser-specific risk this Node probe couldn't rule out: essentia.js's
// .es.js build is Emscripten glue, and Vite's bundling/asset pipeline could
// in principle trip up its WASM-loading path differently than plain Node
// did (see the __dirname patch in the probe script — that was a Node-only
// issue and should not recur in a browser, but hasn't been *confirmed* in
// one). If this fails to load in the browser, detection falls back to the
// original self-built extractor automatically — see chords.js.

let loadPromise = null;

export function loadEssentiaExtractor() {
  if (!loadPromise) {
    loadPromise = (async () => {
      const [{ EssentiaWASM }, { default: EssentiaExtractor }] = await Promise.all([
        import("essentia.js/dist/essentia-wasm.es.js"),
        import("essentia.js/dist/essentia.js-extractor.es.js"),
      ]);
      return new EssentiaExtractor(EssentiaWASM);
    })();
  }
  return loadPromise;
}

// essentia's HPCP has index 0 = A (per docs: "pitch classes corresponding to
// notes from A to G#"), confirmed empirically via the probe script. This
// detector's NOTE_NAMES / template system indexes from C = 0. A is 3
// semitones above C's alphabetical neighbour... concretely: C sits at A-index
// 3 (A, A#, B, C), so myChroma[i] = hpcp[(i + 3) % 12].
export function rotateAtoC(hpcp) {
  const out = new Float32Array(12);
  for (let i = 0; i < 12; i++) out[i] = hpcp[(i + 3) % 12];
  return out;
}

// frame: raw (unwindowed) Float32Array of audio samples — hpcpExtractor does
// its own windowing/spectrum/peak-picking/whitening internally.
export function extractHpcp(extractor, frame, sampleRate) {
  const hpcp = extractor.hpcpExtractor(frame, sampleRate);
  return rotateAtoC(hpcp);
}
