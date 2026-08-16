import path from "node:path";
import { fileURLToPath } from "node:url";

// Same Node/ESM-vs-Emscripten-glue polyfill as scripts/test-essentia.mjs —
// without it detectChords() silently falls back to the built-in chroma
// extractor instead of exercising the real essentia.js path under Node.
globalThis.__dirname = path.dirname(
  fileURLToPath(await import.meta.resolve("essentia.js/dist/essentia-wasm.es.js"))
);

import { detectChords } from "../src/analysis/chords.js";

const SR = 44100;
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

// Real instruments aren't pure sine tones — a plucked/struck string carries a
// natural harmonic series (2nd, 3rd, 4th harmonic... at decreasing amplitude)
// which spreads real energy into pitch classes the player never actually
// played. A pure-sine test chord can't expose "false extra note" bugs at all;
// this is what a guitar/piano F major chord's spectrum roughly resembles.
function synthChordHarmonic(freqs, seconds, sr, nHarmonics = 4) {
  const n = Math.floor(seconds * sr);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const f of freqs) {
      for (let h = 1; h <= nHarmonics; h++) {
        s += (Math.sin((2 * Math.PI * f * h * i) / sr) / h) * (1 / freqs.length);
      }
    }
    buf[i] = s * 0.7;
  }
  return buf;
}

async function run(name, chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const full = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { full.set(c, off); off += c.length; }
  const fakeBuffer = {
    numberOfChannels: 1, length: full.length, sampleRate: SR,
    duration: full.length / SR, getChannelData: () => full,
  };
  console.log(`\n== ${name} ==`);
  const result = await detectChords(fakeBuffer, (p) => {
    if (Math.round(p * 100) % 25 === 0) process.stdout.write(".");
  });
  console.log("\nsegments:");
  for (const s of result.segments) {
    console.log(`  ${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s : ${s.chord}`);
  }
  if (result.keys.length > 1) {
    console.log("keys:");
    for (const k of result.keys) console.log(`  ${k.start.toFixed(2)}s - ${k.end.toFixed(2)}s : ${k.name}`);
  }
  return result;
}

function chordAt(result, t) {
  const s = result.segments.find((s) => t >= s.start && t < s.end);
  return s ? s.chord : "(none)";
}

// C major (C4 E4 G4) -> A minor (A3 C4 E4). Different root, same-ish register.
await run("C major -> A minor", [
  synthChord([261.63, 329.63, 392.0], 3, SR),
  synthChord([220.0, 261.63, 329.63], 3, SR),
]);

// The harder case this round's fix targets: relative major/minor that share
// two of three notes (E-G-B vs G-B-D) — only the bass register tells them
// apart. Root note is doubled an octave down, like a real bass guitar would.
await run("E minor (bass-rooted) -> G major (bass-rooted)", [
  synthChord([82.41, 164.81, 196.0, 246.94], 3, SR),  // E2 bass + E3 G3 B3
  synthChord([98.0, 196.0, 246.94, 293.66], 3, SR),   // G2 bass + G3 B3 D4
]);

// silence should stay N.C., not get classified as some chord
await run("silence", [new Float32Array(Math.floor(2 * SR))]);

// The exact real-world bug this round's fix targets: a mid-song key
// modulation (F major -> Eb major, a classic gospel/soul step change), then
// a Bb7 (A#7) probe chord. Bb7's 4th note (Ab/G#) is diatonic to Eb major;
// Bbmaj7's 4th note (A natural) is not. A single global key estimate averages
// both halves together and gets this wrong; a local/sliding key estimate
// should track the modulation and correctly prefer A#7 over A#maj7.
const F3 = 174.61, A3 = 220.0, C4 = 261.63, E4 = 329.63, G4 = 392.0;
const Eb4 = 311.13, Bb4 = 466.16;
const Ab3 = 207.65, Eb4b = 311.13;
const Bb3 = 233.08, D4 = 293.66, F4 = 349.23, Ab4 = 415.3;

const fMajorSection = [];
for (let i = 0; i < 5; i++) {
  fMajorSection.push(synthChord([F3, A3, C4], 2, SR));   // F
  fMajorSection.push(synthChord([C4, E4, G4], 2, SR));   // C (V of F)
}
const ebMajorSection = [];
for (let i = 0; i < 3; i++) {
  ebMajorSection.push(synthChord([Eb4, G4, Bb4], 2, SR));      // Eb
  ebMajorSection.push(synthChord([Ab3, C4, Eb4b], 2, SR));     // Ab (IV of Eb)
}
const probe = synthChord([Bb3, D4, F4, Ab4], 4, SR);           // Bb7 (V7 of Eb)
const tail = synthChord([Eb4, G4, Bb4], 2, SR);

const modResult = await run("F major -> Eb major modulation, Bb7 probe", [
  ...fMajorSection, ...ebMajorSection, probe, tail,
]);
const probeStart = 5 * 4 + 3 * 4;      // seconds where the probe chord begins
const probeChord = chordAt(modResult, probeStart + 2);
console.log(`probe chord at ${probeStart + 2}s: ${probeChord}  (want "A#7", not "A#maj7")`);
console.log(probeChord === "A#7" ? "PASS" : `FAIL (got ${probeChord})`);

// Confidence check: F and C each repeat 5 times in the first 20s of this
// same test — neither the margin signal nor the rarity signal (a chord
// occurring <= RARE_MAX_OCCURRENCES times) should fire on chords this
// common and this cleanly synthesized. The very first segment is excluded
// deliberately: a song's opening moment has no prior audio context and
// genuinely reads differently (attack transient, no settled tone yet) —
// that's a real edge condition, not the false-positive flood this test
// exists to catch (a bug once had EVERY segment flagged, not just the
// first). A close call getting flagged elsewhere is checked by inspection,
// not a fixed assertion, since that depends on audio content by design.
const fcSegs = modResult.segments.filter((s) => s.start > 3 && s.start < 20 && (s.chord === "F" || s.chord === "C"));
const wronglyFlagged = fcSegs.filter((s) => s.confident === false);
console.log(`confidence check: ${fcSegs.length} common F/C segments (after the first), ${wronglyFlagged.length} wrongly flagged unconfident`);
console.log(wronglyFlagged.length === 0 ? "PASS" : `FAIL (${wronglyFlagged.map((s) => s.chord + "@" + s.start.toFixed(1)).join(", ")})`);

// Live-recording proxy: a sustained F chord with a loud broadband noise burst
// injected mid-chord (stand-in for a drum hit / crowd cheer / room bleed —
// exactly what a clean synthetic sine-wave chord never exercises). Spectral
// flatness gating should hold "F" through the noise instead of reclassifying
// into whatever the noise + chord mixture happens to resemble.
function noiseBurst(seconds, sr, amp = 1.2) {
  const n = Math.floor(seconds * sr);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = (Math.random() * 2 - 1) * amp;
  return buf;
}
function mix(a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] || 0);
  return out;
}
const fChord = synthChord([174.61, 220.0, 261.63], 5, SR); // F3 A3 C4, 5s sustained
const burst = noiseBurst(1, SR);
const burstStart = Math.floor(2 * SR); // noise hits at the 2s mark
const fWithNoise = fChord.slice();
for (let i = 0; i < burst.length; i++) fWithNoise[burstStart + i] += burst[i];

const noiseResult = await run("F chord with mid-sustain noise burst (live-recording proxy)", [fWithNoise]);
const duringNoise = chordAt(noiseResult, 2.5);
console.log(`chord during noise burst (t=2.5s): ${duringNoise}  (want "F", held through the noise)`);
console.log(duringNoise === "F" ? "PASS" : `FAIL (got ${duringNoise})`);

// The exact bug found in real-song data: essentia's cleaner chroma means a
// real instrument's natural harmonic bleed can look like enough "extra note"
// evidence to tip the scorer into a false sus4/7/maj7 — a plain F major chord
// coming back as "Fmaj7" or "Fsus4" when nobody played a 7th or a 4th.
const fHarmonic = synthChordHarmonic([174.61, 220.0, 261.63], 4, SR); // F3 A3 C4, real harmonic series
const harmonicResult = await run("Plain F major, harmonic-rich (real-instrument proxy)", [fHarmonic]);
const harmonicChord = chordAt(harmonicResult, 2);
console.log(`chord at t=2s: ${harmonicChord}  (want plain "F", not Fmaj7/Fsus4/F7)`);
console.log(harmonicChord === "F" ? "PASS" : `FAIL (got ${harmonicChord})`);

// The residual bug from real-song data: Am shares 2 of 3 notes with F
// (F-A-C vs A-C-E) — only the bass note tells them apart. Genuinely
// ambiguous chroma (F and Am tones present together, e.g. a vocal/backing
// note adding E) but a clear, strong F bass note underneath should still
// resolve to F, not Am — this is what ROOT_BIAS exists to fix, now that
// essentia's chroma bypasses the old BASS_BOOST blend.
function synthAmbiguousFvsAm(seconds, sr) {
  const n = Math.floor(seconds * sr);
  const buf = new Float32Array(n);
  const bassF = 87.31;    // F2, strong clear bass note
  const shared = [220.0, 261.63]; // A3 C4 — shared by both F major and A minor
  const e = 329.63;       // E4 — Am's distinguishing tone, present but faint
                           // (trace amount, not full-strength — full strength
                           // literally spells Fmaj7, a different test)
  for (let i = 0; i < n; i++) {
    let s = Math.sin((2 * Math.PI * bassF * i) / sr) * 1.4; // bass emphasised
    for (const f of shared) s += Math.sin((2 * Math.PI * f * i) / sr);
    s += Math.sin((2 * Math.PI * e * i) / sr) * 0.3;
    buf[i] = (s / (shared.length + 1.4 + 0.3)) * 0.8;
  }
  return buf;
}
const ambiguousResult = await run("F vs Am ambiguous chroma, clear F bass (root-bias test)", [synthAmbiguousFvsAm(4, SR)]);
const ambiguousChord = chordAt(ambiguousResult, 2);
console.log(`chord at t=2s: ${ambiguousChord}  (want "F" — bass note should break the F/Am tie)`);
console.log(ambiguousChord === "F" ? "PASS" : `FAIL (got ${ambiguousChord})`);

// User-reported bug on a real song: a chord change (F -> C) briefly reads as
// some other chord right at the strum transition — often a sus4 sharing a
// root with one side, since that's what the chroma mid-strum actually looks
// like. That in-between chord isn't in the song and shouldn't survive as its
// own segment; it should be absorbed into F or C.
const fSus4Result = await run("F -> brief Fsus4 blend -> C (transient sandwich merge)", [
  synthChord([174.61, 220.0, 261.63], 2, SR),     // F
  synthChord([174.61, 233.08, 261.63], 0.7, SR),  // Fsus4 (F Bb C) — shares root with F
  synthChord([261.63, 329.63, 392.0], 2, SR),     // C
]);
const hasSus4 = fSus4Result.segments.some((s) => s.chord.includes("sus4"));
console.log(`sandwiched Fsus4 segment present: ${hasSus4}  (want false — absorbed into F)`);
console.log(!hasSus4 ? "PASS" : "FAIL (Fsus4 segment survived)");
