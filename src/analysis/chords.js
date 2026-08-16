// Chord detection: AudioBuffer -> timeline of chord segments.
//
// Pipeline:
//   1. mono mix
//   2. chroma per frame — essentia.js (real MIR-grade HPCP) when it loads,
//      else a hand-rolled FFT-binning fallback (bass-weighted, sqrt-
//      compressed); either way also tracks spectral flatness per frame —
//      near 0 for tonal content, near 1 for noise/percussion (drum hits,
//      crowd noise, live-room bleed), used to down-weight a noisy frame's
//      influence on the decode rather than trusting it at face value
//   3. estimate the song's key in a sliding local window (Krumhansl-Schmuckler
//      correlation) so it tracks real modulations — used as a small prior,
//      not a hard rule
//   4. adaptive (ratio-to-median) silence gate splits the song into runs of
//      "usable" audio; within each run, Viterbi decodes the single best
//      chord *path* against 84 zero-sum chord templates (7 qualities x 12
//      roots, biased slightly toward the local key) — see the note on
//      viterbiRun below for why a whole-sequence decode instead of a
//      frame-by-frame decision
//   5. median-smooth, merge into segments, drop blips
//
// v2 note: the first version used plain positive-only templates (1 on chord
// tones, 0 elsewhere). On real mixed audio (drums/vocals/reverb spread a
// little energy into every pitch class) that scheme has a structural bias:
// a 4-note template's cosine score can only ever gain from an extra bin,
// never lose, so bigger templates (7th chords) almost always out-score the
// plain triad they contain — the song comes back drowned in maj7/dominant7.
// Fix: zero-sum templates (+1/N on chord tones, -1/(12-N) elsewhere) so a
// template's score is ~0 against broadband noise regardless of its size,
// and only genuinely rises when the *extra* note actually has energy.
//
// This is still a frame-level detector, not beat-synchronous — it doesn't
// know where the beat/bar lines are, so it can't average "one chroma per
// bar" the way a strong detector (Chordino, madmom) would. That's the next
// real accuracy jump; see README "Known gaps".

import { fft } from "./fft.js";
import { loadEssentiaExtractor, extractHpcp } from "./essentiaHpcp.js";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const FRAME = 16384;             // FFT size (~2.7 Hz bins at 44.1 kHz)
const HOP = 4096;                // 75% overlap — smoother frame-to-frame chroma
const F_MIN = 65;                // ~C2
const F_MAX = 2000;               // ~B6
const BASS_MAX = 300;             // ~D4 — below this, bins get extra weight (root cue)
const BASS_BOOST = 2.2;
const ROOT_BIAS = 0.12;           // bonus for templates whose root matches this
                                   // frame's dominant bass note (see bassChroma in
                                   // frameChroma) — applies regardless of chroma
                                   // source, so essentia's chroma still gets a root
                                   // cue even though its own weighting doesn't have
                                   // one built in the way the hand-rolled path did
const ROOT_MIN_DOMINANCE = 1.3;   // bass pitch class must beat the runner-up by at
                                   // least this ratio to count as "clear" — an
                                   // ambiguous/flat bass register shouldn't bias
                                   // anything
const FLATNESS_THRESHOLD = 0.4;   // spectral flatness (geometric/arithmetic mean of
                                   // the usable bins) above this -> frame excluded
                                   // from the key-estimation window (below). Live
                                   // recordings especially (crowd noise, room
                                   // ambience, drum hits, stage bleed) spread energy
                                   // near-evenly across all pitch classes instead of
                                   // concentrating it in the actual chord tones, which
                                   // would otherwise skew what key nearby chords get
                                   // judged against. Classification itself uses raw
                                   // flatness as a continuous confidence weight
                                   // instead of this hard cutoff — see viterbiRun.
const MIN_SEG = 0.6;              // seconds; shorter segments get merged away
const SILENCE_RATIO = 0.12;       // frames quieter than this fraction of the
                                   // song's own MEDIAN energy -> "N.C.". Ratio-
                                   // to-median, not a fixed percentile: a fixed
                                   // percentile always carves out that fraction
                                   // of frames as "silent" even when a track has
                                   // no real silence (constant loudness, heavily
                                   // compressed pop mixes, or — worse — plain
                                   // uniform-amplitude test audio), which
                                   // scatters false gaps across otherwise normal
                                   // frames and fragments real chord blocks into
                                   // pieces too short to survive MIN_SEG.
const SILENCE_FLOOR = 1e-5;       // absolute floor so a fully silent file doesn't
                                   // pick a threshold of 0 and call noise "chords"
const KEY_BIAS = 0.10;            // how strongly the estimated song key nudges
                                   // ambiguous frames toward diatonic chords
const LOCAL_KEY_WINDOW_SEC = 20;  // half-window either side used per key estimate
                                   // (~40s of context) — narrow enough to track a
                                   // real modulation, wide enough to stay stable
const KEY_BLOCK_SEC = 2;          // how often the key estimate refreshes
const COMPLEXITY_PENALTY = 0.02;  // per extra note beyond a triad — a light
                                   // Occam's-razor tiebreaker for near-ties at the
                                   // per-frame emission level. Resisting a stray
                                   // false 7th/sus4 across *time* is now Viterbi's
                                   // SWITCH_PENALTY's job (below), not this — a
                                   // single noisy frame favouring Fsus4 shouldn't
                                   // flip the whole run's decoded path just because
                                   // this constant was tuned harshly against it.
const CONFIDENCE_MARGIN = 0.08;   // if the chosen chord beats the best alternative
                                   // by less than this, the segment is flagged
                                   // "uncertain" in the UI instead of the algorithm
                                   // silently committing to a close call. First-pass
                                   // heuristic threshold, not validated against real
                                   // audio — the goal isn't to eliminate ambiguity
                                   // (some calls genuinely are 50/50 without hearing
                                   // it), it's to surface it instead of hiding it.
const RARE_MAX_OCCURRENCES = 1;   // a chord occurring this many times or fewer across
                                   // the whole song also gets flagged unconfident —
                                   // real songs repeat a small chord vocabulary; a
                                   // single 2-second outlier surrounded by dozens of
                                   // repeats of a handful of other chords is usually
                                   // a misdetection, not a real one-off choice.

const CHORD_QUALITIES = [
  { suffix: "", intervals: [0, 4, 7] },         // major
  { suffix: "m", intervals: [0, 3, 7] },        // minor
  { suffix: "7", intervals: [0, 4, 7, 10] },    // dominant 7
  { suffix: "m7", intervals: [0, 3, 7, 10] },   // minor 7
  { suffix: "maj7", intervals: [0, 4, 7, 11] }, // major 7
  { suffix: "sus4", intervals: [0, 5, 7] },
  { suffix: "sus2", intervals: [0, 2, 7] },
];

// zero-sum templates: +1/N on chord tones, -1/(12-N) everywhere else, then
// L2-normalised. Dot product against a flat/noisy chroma averages to ~0
// regardless of how many notes the template has — removes the "bigger
// template always wins" bias plain 0/1 templates had.
function buildTemplates() {
  const tem = [];
  for (let r = 0; r < 12; r++) {
    for (const q of CHORD_QUALITIES) {
      const members = new Set(q.intervals.map((iv) => (r + iv) % 12));
      const n = members.size;
      const posW = 1 / n, negW = -1 / (12 - n);
      const v = new Float32Array(12);
      for (let i = 0; i < 12; i++) v[i] = members.has(i) ? posW : negW;
      let norm = 0; for (const x of v) norm += x * x; norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < 12; i++) v[i] /= norm;
      const penalty = COMPLEXITY_PENALTY * Math.max(0, n - 3);
      tem.push({ name: NOTE_NAMES[r] + q.suffix, vec: v, members, penalty, root: r });
    }
  }
  return tem;
}
const TEMPLATES = buildTemplates();

// ---------- Krumhansl-Schmuckler key estimation ----------
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

function rotate(profile, root) {
  const out = new Array(12);
  for (let i = 0; i < 12; i++) out[(i + root) % 12] = profile[i];
  return out;
}
function correlate(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  return num / (Math.sqrt(da * db) || 1);
}
function estimateKey(globalChroma) {
  let bestRoot = 0, bestMinor = false, bestScore = -Infinity;
  for (let r = 0; r < 12; r++) {
    const sMaj = correlate(globalChroma, rotate(KK_MAJOR, r));
    if (sMaj > bestScore) { bestScore = sMaj; bestRoot = r; bestMinor = false; }
    const sMin = correlate(globalChroma, rotate(KK_MINOR, r));
    if (sMin > bestScore) { bestScore = sMin; bestRoot = r; bestMinor = true; }
  }
  return { root: bestRoot, isMinor: bestMinor, name: NOTE_NAMES[bestRoot] + (bestMinor ? "m" : "") };
}

// per-template bonus: fraction of the template's own chord tones that fall
// within the estimated key's diatonic scale (minor keys use their relative
// major's scale, which is the same 7 pitch classes)
function buildKeyBonus(key) {
  const scaleRoot = key.isMinor ? (key.root + 3) % 12 : key.root;
  const scale = new Set(MAJOR_SCALE.map((iv) => (scaleRoot + iv) % 12));
  return TEMPLATES.map((t) => {
    let inScale = 0;
    for (const m of t.members) if (scale.has(m)) inScale++;
    return KEY_BIAS * (inScale / t.members.size);
  });
}

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

function toMono(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  for (let i = 0; i < len; i++) out[i] /= ch;
  return out;
}

// Precompute per-bin: pitch class (-1 if outside musical range) and whether
// it falls in the bass register (gets extra weight — the bass note is the
// strongest single cue for chord root).
function analyzeBins(sampleRate) {
  const pc = new Int8Array(FRAME / 2).fill(-1);
  const bass = new Uint8Array(FRAME / 2);
  for (let k = 1; k < FRAME / 2; k++) {
    const f = (k * sampleRate) / FRAME;
    if (f < F_MIN || f > F_MAX) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    pc[k] = ((Math.round(midi) % 12) + 12) % 12;
    bass[k] = f < BASS_MAX ? 1 : 0;
  }
  return { pc, bass };
}

function frameChroma(samples, start, win, bins, re, im, essentiaExtractor, sampleRate) {
  for (let i = 0; i < FRAME; i++) {
    const s = samples[start + i] || 0;
    re[i] = s * win[i];
    im[i] = 0;
  }
  fft(re, im);
  // energy and spectral flatness always come from our own FFT pass below —
  // needed for silence/noise gating regardless of which chroma source is
  // used. When essentia.js loaded successfully, its HPCP (proper spectral
  // whitening + harmonic-weighted peak picking, a real MIR-grade chroma
  // extractor) replaces the hand-rolled chroma[] built from raw FFT bins
  // further down; the bass-boost/sqrt-compression heuristics below were
  // specifically compensating for weaknesses in that hand-rolled approach,
  // so they're skipped when essentia's already-good chroma is in use.
  const chroma = new Float32Array(12);
  // dedicated bass-register chroma (< BASS_MAX Hz only) — computed
  // unconditionally, independent of which chroma source (essentia or the
  // hand-rolled path below) ends up used for the main template match. The
  // bass note is the strongest single cue for chord root, and root is what
  // disambiguates relative-chord confusion (F/Am, C/Am — Am shares 2 of 3
  // notes with both). The old BASS_BOOST weighting achieved this by blending
  // extra bass weight *into* the main chroma, but that only works when the
  // hand-rolled chroma is actually in use; essentia's HPCP has its own
  // weighting and bypasses it entirely, silently losing the root cue. This
  // stays separate so it applies as a bonus regardless of chroma source.
  const bassChroma = new Float32Array(12);
  let energy = 0;
  // spectral flatness (geometric mean / arithmetic mean of magnitude) over the
  // same usable bins as chroma: near 0 for tonal content (energy concentrated
  // in a few harmonic peaks), near 1 for noise/percussion (energy spread flat
  // across the spectrum). Computed in the log domain to avoid underflow.
  let logSum = 0, linSum = 0, count = 0;
  const { pc, bass } = bins;
  for (let k = 1; k < FRAME / 2; k++) {
    const cls = pc[k];
    if (cls < 0) continue;
    const mag = Math.hypot(re[k], im[k]);
    energy += mag;
    logSum += Math.log(mag + 1e-9);
    linSum += mag;
    count++;
    if (bass[k]) bassChroma[cls] += Math.sqrt(mag);
    // raw magnitude, not log-compressed: with zero-sum templates (below) the
    // negative weights already stop broadband noise from favouring bigger
    // templates structurally, so compression here was only actively harmful —
    // it crushed the true peak-vs-floor contrast (a real ~200:1 ratio becomes
    // ~4:1 under log1p), which flattened chroma vectors enough that hysteresis
    // started freezing through genuine chord changes ("stuck on one chord for
    // 16s" bug). sqrt is a much gentler compromise: still tames one wildly
    // loud harmonic without destroying the real signal-to-floor gap.
    const weight = bass[k] ? BASS_BOOST : 1;
    chroma[cls] += Math.sqrt(mag) * weight;
  }
  const geoMean = Math.exp(logSum / count);
  const arithMean = linSum / count;
  const flatness = arithMean > 0 ? geoMean / arithMean : 0;

  if (essentiaExtractor) {
    try {
      const rawFrame = samples.subarray(start, start + FRAME);
      return { chroma: extractHpcp(essentiaExtractor, rawFrame, sampleRate), energy, flatness, bassChroma };
    } catch {
      // fall through to the hand-rolled chroma computed above — a single
      // frame failing shouldn't take down the whole detection run
    }
  }
  return { chroma, energy, flatness, bassChroma };
}

function templateScore(chroma, norm, keyBonus, t, rootPc) {
  const vec = TEMPLATES[t].vec;
  let dot = 0;
  for (let i = 0; i < 12; i++) dot += (chroma[i] / norm) * vec[i];
  const rootBonus = TEMPLATES[t].root === rootPc ? ROOT_BIAS : 0;
  return dot + keyBonus[t] + rootBonus - TEMPLATES[t].penalty;
}

// How close was the single best *different-root* chord to the one actually
// chosen at this unit? Independent of Viterbi's path — this asks "was the
// raw evidence here ambiguous," not "did the sequence decode land here,"
// since a spot the audio itself doesn't clearly resolve is exactly what
// should be flagged for the user, regardless of which way the path-level
// decode happened to break.
//
// Restricted to *different roots* deliberately: an extended-chord template
// (F7/Fmaj7/Fsus4...) structurally overlaps with its own base triad more
// than any unrelated chord does, so it's mathematically always the closest
// competitor to a plain F — that's a quality nuance (Fmaj7 vs F), not the
// kind of ambiguity worth surfacing (Am7 shown instead of C, a genuinely
// different chord). Comparing against same-root variants made nearly every
// segment "uncertain" regardless of how clean the audio was — useless.
function topAlternative(chroma, norm, keyBonus, rootPc, chosenIdx) {
  const chosenRoot = TEMPLATES[chosenIdx].root;
  const chosenScore = templateScore(chroma, norm, keyBonus, chosenIdx, rootPc);
  let altIdx = -1, altScore = -Infinity;
  for (let t = 0; t < TEMPLATES.length; t++) {
    if (t === chosenIdx || TEMPLATES[t].root === chosenRoot) continue;
    const s = templateScore(chroma, norm, keyBonus, t, rootPc);
    if (s > altScore) { altScore = s; altIdx = t; }
  }
  return { altIdx, margin: chosenScore - altScore };
}

// Dominant pitch class in the bass register, or -1 if the bass isn't clearly
// pointing at one note (see ROOT_MIN_DOMINANCE) — an ambiguous bass register
// shouldn't bias the chord decision either way.
function dominantBassPc(bassChroma) {
  let best = -1, bestVal = 0, second = 0;
  for (let i = 0; i < 12; i++) {
    const v = bassChroma[i];
    if (v > bestVal) { second = bestVal; bestVal = v; best = i; }
    else if (v > second) { second = v; }
  }
  if (best < 0 || bestVal < second * ROOT_MIN_DOMINANCE) return -1;
  return best;
}

const SWITCH_PENALTY = 0.35;      // Viterbi transition cost when the unit is a raw
                                   // analysis frame (~10/sec)
const BEAT_SWITCH_PENALTY = 0.12; // same, but for beat-synchronous mode (~1.5-2
                                   // units/sec). The same absolute cost that works
                                   // for frequent, fine-grained frames is far
                                   // stickier when there are 5-10x fewer, coarser
                                   // units to begin with — left uncorrected this
                                   // produced 12-18s single-chord blocks on a real
                                   // recording. Not yet independently tuned against
                                   // real audio (only frame-mode has that); revisit
                                   // this constant first if beat-mode still runs
                                   // segments suspiciously long.
//
// Both replace the old frame-by-frame hysteresis heuristic ("is the previous
// chord still competitive this frame?") with a proper sequence decode:
// instead of a local decision at each unit, Viterbi finds the single chord
// *path* through the whole run that best explains all the evidence at once —
// a short-lived false quality (a stray Fsus4/Fmaj7 from real-instrument
// harmonic bleed) has to keep paying for itself every unit it's active, not
// just win one instant's threshold. Ported the *idea* from chordy
// (github.com/arulandu/chordy), a native chord-detector that uses
// Viterbi/Markov-chain smoothing on the same kind of chroma+template
// pipeline — not its code (C++/desktop, not usable here directly).

// Runs Viterbi over one contiguous run of "usable" (non-silent) frames and
// returns the best chord-index path, one per frame in `frameIdxs`. Emission
// score per frame/template is the same templateScore used before, weighted
// down by spectral flatness (a noisy/percussive frame's evidence should
// influence the decode less, not be a hard "hold" special-case like before —
// Viterbi's own transition persistence already produces that behaviour
// naturally when a frame's evidence is weak). Transition is a simple
// self-vs-switch model (uniform switch cost) — Viterbi's classic O(states)
// shortcut applies since only "stay" vs "best-other" need comparing, not
// every pair.
function viterbiRun(chromas, flatnesses, bassChromas, frameIdxs, keyBonusOf, switchPenalty = SWITCH_PENALTY) {
  const T = TEMPLATES.length;
  const m = frameIdxs.length;
  if (m === 0) return [];

  const emissionAt = (f, t, norm, keyBonus, rootPc) =>
    Math.max(0.15, 1 - flatnesses[f]) * templateScore(chromas[f], norm, keyBonus, t, rootPc);
  const normOf = (f) => {
    let n = 0; for (const x of chromas[f]) n += x * x;
    return Math.sqrt(n) || 1;
  };

  let prevV = new Float64Array(T);
  const back = new Uint8Array(m * T);

  {
    const f = frameIdxs[0];
    const norm = normOf(f), keyBonus = keyBonusOf(f), rootPc = dominantBassPc(bassChromas[f]);
    for (let t = 0; t < T; t++) prevV[t] = emissionAt(f, t, norm, keyBonus, rootPc);
  }

  for (let i = 1; i < m; i++) {
    const f = frameIdxs[i];
    const norm = normOf(f), keyBonus = keyBonusOf(f), rootPc = dominantBassPc(bassChromas[f]);
    const curV = new Float64Array(T);

    // top-2 previous states, so "switch" always has a valid alternative even
    // when the best previous state equals the current one being considered
    let best1 = 0, best1Val = -Infinity, best2 = 0, best2Val = -Infinity;
    for (let t = 0; t < T; t++) {
      if (prevV[t] > best1Val) { best2 = best1; best2Val = best1Val; best1 = t; best1Val = prevV[t]; }
      else if (prevV[t] > best2Val) { best2 = t; best2Val = prevV[t]; }
    }

    for (let t = 0; t < T; t++) {
      const stay = prevV[t];
      const altIdx = t === best1 ? best2 : best1;
      const altVal = t === best1 ? best2Val : best1Val;
      const switchScore = altVal - switchPenalty;
      const emission = emissionAt(f, t, norm, keyBonus, rootPc);
      if (stay >= switchScore) {
        curV[t] = emission + stay;
        back[i * T + t] = t;
      } else {
        curV[t] = emission + switchScore;
        back[i * T + t] = altIdx;
      }
    }
    prevV = curV;
  }

  let finalIdx = 0, finalVal = -Infinity;
  for (let t = 0; t < T; t++) if (prevV[t] > finalVal) { finalVal = prevV[t]; finalIdx = t; }

  const path = new Array(m);
  path[m - 1] = finalIdx;
  for (let i = m - 1; i > 0; i--) path[i - 1] = back[i * T + path[i]];
  return path;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
}

// median filter over label indices (numeric), window must be odd
function smoothLabels(labels, win = 9) {
  const half = win >> 1;
  const out = labels.slice();
  for (let i = 0; i < labels.length; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(labels.length - 1, i + half);
    out[i] = median(labels.slice(lo, hi + 1));
  }
  return out;
}

// yield to the event loop so the progress UI can paint
const nextTick = () => new Promise((r) => setTimeout(r, 0));

export async function detectChords(audioBuffer, onProgress, _trace) {
  const samples = toMono(audioBuffer);
  const sampleRate = audioBuffer.sampleRate;
  const win = hann(FRAME);
  const bins = analyzeBins(sampleRate);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);

  // essentia.js gives real MIR-grade chroma (proper spectral whitening —
  // meaningfully more robust on live/noisy recordings than the hand-rolled
  // FFT-binning below). Optional: if it fails to load (network, browser
  // WASM quirk), detection proceeds with the original built-in extractor —
  // never a hard failure, just a quieter accuracy fallback.
  if (onProgress) onProgress(0, "Loading audio engine…");
  await nextTick();
  let essentiaExtractor = null;
  try {
    essentiaExtractor = await loadEssentiaExtractor();
    console.log("Cadence: using essentia.js for chroma extraction");
  } catch (err) {
    console.warn("Cadence: essentia.js failed to load, using built-in chroma extraction instead.", err);
  }

  // Beat tracking: chords overwhelmingly change on the beat, not at whatever
  // instant a fixed-hop analysis frame happens to cross a threshold. essentia's
  // RhythmExtractor2013 gives real tick positions; if it finds a usable beat
  // grid, classification runs per-beat (chroma averaged across each beat —
  // also a strong noise reducer) instead of per-frame, and segment boundaries
  // snap to actual beat times. Falls back to the frame-level path below on
  // any failure, or on audio with no clear beat (e.g. rubato, no percussion,
  // or — this matters — every sustained-tone synthetic test in this file's
  // regression suite, which is exactly why those tests exercise the fallback
  // path and can't validate beat-sync directly; that needs a real recording).
  let beatTicks = null;
  if (essentiaExtractor) {
    if (onProgress) onProgress(0.02, "Detecting rhythm…");
    await nextTick();
    try {
      // synchronous WASM call — for a long song this can genuinely take a
      // few seconds with no way to yield mid-call. The onProgress call just
      // above at least gets the "Detecting rhythm…" label on screen before
      // it blocks, so it reads as "working" rather than "frozen"; a fully
      // non-blocking UI during this step would need moving essentia calls
      // into a Web Worker, which is a bigger change than this one.
      const vec = essentiaExtractor.arrayToVector(samples);
      const rhythm = essentiaExtractor.RhythmExtractor2013(vec);
      const ticks = [];
      for (let i = 0; i < rhythm.ticks.size(); i++) ticks.push(rhythm.ticks.get(i));
      if (ticks.length >= 4) {
        beatTicks = ticks;
        console.log(`Cadence: beat-synchronous mode, ${rhythm.bpm.toFixed(1)} BPM, ${ticks.length} beats`);
      } else {
        console.log("Cadence: too few beats detected, using frame-level chord boundaries");
      }
    } catch (err) {
      console.warn("Cadence: beat tracking failed, using frame-level chord boundaries instead.", err);
    }
  }
  if (onProgress) onProgress(0.05, "Extracting chroma…");
  await nextTick();

  const nFrames = Math.max(1, Math.floor((samples.length - FRAME) / HOP));
  const nameByIndex = TEMPLATES.map((t) => t.name);

  // pass 1: chroma + energy + flatness + bass-register chroma per frame
  const chromas = new Array(nFrames);
  const energies = new Float32Array(nFrames);
  const flatnesses = new Float32Array(nFrames);
  const bassChromas = new Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const { chroma, energy, flatness, bassChroma } = frameChroma(samples, f * HOP, win, bins, re, im, essentiaExtractor, sampleRate);
    chromas[f] = chroma;
    energies[f] = energy;
    flatnesses[f] = flatness;
    bassChromas[f] = bassChroma;
    if (f % 64 === 0) {
      if (onProgress) onProgress((f / nFrames) * 0.7, "Extracting chroma…");
      await nextTick();
    }
  }

  const silenceThresh = Math.max(SILENCE_FLOOR, median(energies) * SILENCE_RATIO);

  // ---- local (sliding-window) key estimate, not one global key ----
  // A single song-wide key breaks on any song that modulates (very common —
  // step-up key changes in the last chorus, verse/chorus in relative keys,
  // etc). Re-estimate the key every KEY_BLOCK_SEC from a LOCAL_KEY_WINDOW_SEC
  // -wide window of chroma around that point, via prefix sums so it's O(1)
  // per block instead of re-summing the whole song each time.
  const frameDur = HOP / sampleRate;
  const blockFrames = Math.max(1, Math.round(KEY_BLOCK_SEC / frameDur));
  const winFrames = Math.round(LOCAL_KEY_WINDOW_SEC / frameDur);

  const prefix = new Float64Array((nFrames + 1) * 12);
  for (let f = 0; f < nFrames; f++) {
    const base = f * 12, next = base + 12;
    // noisy/percussive frames don't carry reliable tonal evidence — exclude
    // them from the key estimate the same as silence, so a drum-heavy or
    // crowd-noisy stretch doesn't skew what key the surrounding chords get
    // judged against
    const use = energies[f] >= silenceThresh && flatnesses[f] <= FLATNESS_THRESHOLD;
    for (let i = 0; i < 12; i++) prefix[next + i] = prefix[base + i] + (use ? chromas[f][i] : 0);
  }
  function windowedChroma(center) {
    const lo = Math.max(0, center - winFrames);
    const hi = Math.min(nFrames, center + winFrames);
    const out = new Array(12);
    for (let i = 0; i < 12; i++) out[i] = prefix[hi * 12 + i] - prefix[lo * 12 + i];
    return out;
  }

  const nBlocks = Math.max(1, Math.ceil(nFrames / blockFrames));
  const blockKeyBonus = new Array(nBlocks);
  const blockKeyName = new Array(nBlocks);
  const keyTimeline = [];
  let lastKeyName = null;
  for (let b = 0; b < nBlocks; b++) {
    const center = Math.min(nFrames - 1, b * blockFrames + (blockFrames >> 1));
    const key = estimateKey(windowedChroma(center));
    blockKeyBonus[b] = buildKeyBonus(key);
    blockKeyName[b] = key.name;
    const t0 = b * blockFrames * frameDur;
    const t1 = Math.min(audioBuffer.duration, t0 + blockFrames * frameDur);
    if (key.name === lastKeyName && keyTimeline.length) {
      keyTimeline[keyTimeline.length - 1].end = t1;
    } else {
      keyTimeline.push({ start: t0, end: t1, name: key.name });
      lastKeyName = key.name;
    }
  }
  if (onProgress) onProgress(0.75, "Matching chords…");
  await nextTick();

  // pass 2: classify via Viterbi decoding over each contiguous run of
  // "usable" units (silence still hard-gates to N.C. and breaks runs). Within
  // a run, Viterbi finds the single best chord *path* for the whole run at
  // once, rather than deciding frame-by-frame. The unit is a beat when a
  // usable beat grid was found above, otherwise a raw analysis frame — either
  // way viterbiRun doesn't care, it just needs chroma/flatness/bass-chroma
  // arrays indexed consistently, so the same function serves both.
  const keyBonusOf = (f) => blockKeyBonus[Math.min(nBlocks - 1, Math.floor(f / blockFrames))];

  let labels, boundaryTime, smoothWin, margins, altIdxArr;
  if (beatTicks) {
    // aggregate frame-level chroma/energy/flatness into one observation per
    // beat — averaging across a whole beat is also a strong noise reducer on
    // top of the alignment benefit
    const nBeats = beatTicks.length - 1;
    const beatChromas = new Array(nBeats), beatBass = new Array(nBeats);
    const beatEnergies = new Float32Array(nBeats), beatFlatness = new Float32Array(nBeats);
    const beatCenterFrame = new Int32Array(nBeats);
    for (let b = 0; b < nBeats; b++) {
      const f0 = Math.max(0, Math.floor(beatTicks[b] / frameDur));
      const f1 = Math.min(nFrames - 1, Math.ceil(beatTicks[b + 1] / frameDur));
      const chroma = new Float32Array(12), bass = new Float32Array(12);
      let energy = 0, flat = 0, count = 0;
      for (let f = f0; f <= f1; f++) {
        for (let i = 0; i < 12; i++) { chroma[i] += chromas[f][i]; bass[i] += bassChromas[f][i]; }
        energy += energies[f]; flat += flatnesses[f]; count++;
      }
      if (count > 0) {
        for (let i = 0; i < 12; i++) { chroma[i] /= count; bass[i] /= count; }
        energy /= count; flat /= count;
      }
      beatChromas[b] = chroma; beatBass[b] = bass;
      beatEnergies[b] = energy; beatFlatness[b] = flat;
      beatCenterFrame[b] = Math.min(nFrames - 1, Math.round(((beatTicks[b] + beatTicks[b + 1]) / 2) / frameDur));
    }
    const keyBonusOfBeat = (b) => keyBonusOf(beatCenterFrame[b]);

    labels = new Array(nBeats).fill(-1);
    let runStart = -1;
    for (let b = 0; b <= nBeats; b++) {
      const usable = b < nBeats && beatEnergies[b] >= silenceThresh;
      if (usable && runStart < 0) {
        runStart = b;
      } else if (!usable && runStart >= 0) {
        const idxs = [];
        for (let g = runStart; g < b; g++) idxs.push(g);
        const path = viterbiRun(beatChromas, beatFlatness, beatBass, idxs, keyBonusOfBeat, BEAT_SWITCH_PENALTY);
        for (let i = 0; i < idxs.length; i++) labels[idxs[i]] = path[i];
        runStart = -1;
      }
    }

    margins = new Float32Array(nBeats).fill(Infinity);
    altIdxArr = new Int16Array(nBeats).fill(-1);
    for (let b = 0; b < nBeats; b++) {
      if (labels[b] < 0) continue;
      let norm = 0; for (const x of beatChromas[b]) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      const rootPc = dominantBassPc(beatBass[b]);
      const alt = topAlternative(beatChromas[b], norm, keyBonusOfBeat(b), rootPc, labels[b]);
      margins[b] = alt.margin; altIdxArr[b] = alt.altIdx;
    }
    boundaryTime = (i) => beatTicks[Math.min(i, beatTicks.length - 1)];
    smoothWin = 3; // beats are already a coarse, well-smoothed unit — a heavy
                    // median window here would smear real beat-to-beat changes
  } else {
    labels = new Array(nFrames).fill(-1);
    let runStart = -1;
    for (let f = 0; f <= nFrames; f++) {
      const usable = f < nFrames && energies[f] >= silenceThresh;
      if (usable && runStart < 0) {
        runStart = f;
      } else if (!usable && runStart >= 0) {
        const frameIdxs = [];
        for (let g = runStart; g < f; g++) frameIdxs.push(g);
        const path = viterbiRun(chromas, flatnesses, bassChromas, frameIdxs, keyBonusOf);
        for (let i = 0; i < frameIdxs.length; i++) labels[frameIdxs[i]] = path[i];
        runStart = -1;
      }
      if (f % 512 === 0) {
        if (onProgress) onProgress(0.75 + (f / nFrames) * 0.25, "Matching chords…");
        await nextTick();
      }
    }

    margins = new Float32Array(nFrames).fill(Infinity);
    altIdxArr = new Int16Array(nFrames).fill(-1);
    for (let f = 0; f < nFrames; f++) {
      if (labels[f] < 0) continue;
      let norm = 0; for (const x of chromas[f]) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      const rootPc = dominantBassPc(bassChromas[f]);
      const alt = topAlternative(chromas[f], norm, keyBonusOf(f), rootPc, labels[f]);
      margins[f] = alt.margin; altIdxArr[f] = alt.altIdx;
    }

    boundaryTime = (i) => Math.min(i, nFrames) * frameDur;
    smoothWin = 9;

    if (_trace) {
      for (let f = 0; f < nFrames; f++) {
        const blockIdx = Math.min(nBlocks - 1, Math.floor(f / blockFrames));
        _trace.push({
          f, t: +(f * frameDur).toFixed(2), energy: +energies[f].toFixed(1),
          silent: energies[f] < silenceThresh, idx: labels[f],
          name: labels[f] < 0 ? "N.C." : nameByIndex[labels[f]],
          blockIdx, keyName: blockKeyName[blockIdx],
          chromaSnapshot: Array.from(chromas[f]),
        });
      }
    }
  }
  if (onProgress) onProgress(1);

  const smoothed = smoothLabels(labels, smoothWin);
  if (_trace) {
    for (const r of _trace) {
      r.rawLabel = labels[r.f]; r.rawName = labels[r.f] < 0 ? "N.C." : nameByIndex[labels[r.f]];
      r.smoothed = smoothed[r.f]; r.smoothedName = smoothed[r.f] < 0 ? "N.C." : nameByIndex[smoothed[r.f]];
    }
  }

  // merge consecutive equal labels into segments, carrying a confidence flag
  // sampled from the segment's *center* unit, not its worst. A boundary unit
  // is inherently ambiguous by definition — that's where the chord change
  // happens, chroma there is naturally a blend of both chords — so a min-
  // across-the-segment approach flagged nearly every segment regardless of
  // how clean the chord was at its core, just from picking up its own edges.
  const segs = [];
  let cur = smoothed[0], startI = 0;
  for (let i = 1; i <= smoothed.length; i++) {
    if (i === smoothed.length || smoothed[i] !== cur) {
      const chord = cur < 0 ? "N.C." : nameByIndex[cur];
      const centerU = startI + ((i - startI) >> 1);
      const margin = margins[centerU] ?? Infinity;
      const altIdx = altIdxArr[centerU] ?? -1;
      const confident = cur < 0 || margin >= CONFIDENCE_MARGIN;
      segs.push({
        chord, start: boundaryTime(startI), end: boundaryTime(i),
        confident, alt: !confident && altIdx >= 0 ? nameByIndex[altIdx] : null,
      });
      cur = smoothed[i];
      startI = i;
    }
  }

  // drop tiny segments by merging into the previous one. Confidence isn't
  // recomputed across the merge — the surviving segment keeps its own flag,
  // not some combination with what got absorbed into it. Simplification, not
  // a correctness issue: a dropped sliver was too short to stand as its own
  // segment either way.
  const merged = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (s.end - s.start < MIN_SEG && prev) {
      prev.end = s.end;
    } else if (prev && prev.chord === s.chord) {
      prev.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }

  // A chord that shows up once for a couple of seconds while everything else
  // in the song repeats across dozens of segments is statistically more
  // likely a misdetection than a real one-off harmony choice — real songs
  // reuse a small chord vocabulary. Flag rare chords as unconfident too, on
  // top of (not instead of) the margin-based flag above. Heuristic, not a
  // correction: nothing here changes what chord is shown, only whether it's
  // flagged for the user to confirm.
  const occurrences = new Map();
  for (const s of merged) if (s.chord !== "N.C.") occurrences.set(s.chord, (occurrences.get(s.chord) || 0) + 1);
  for (const s of merged) {
    if (s.chord !== "N.C." && (occurrences.get(s.chord) || 0) <= RARE_MAX_OCCURRENCES) s.confident = false;
  }

  // reindex + guarantee coverage to the buffer end
  merged.forEach((s, i) => (s.idx = i));
  if (merged.length) merged[merged.length - 1].end = audioBuffer.duration;

  return {
    duration: audioBuffer.duration,
    segments: merged,
    keys: keyTimeline,   // key estimate over time — watch for it tracking modulations
  };
}

// exposed for scripts/test-chords.mjs diagnostics only — not used by the app
export const _debug = { TEMPLATES, frameChroma, analyzeBins, hann, buildKeyBonus, estimateKey, viterbiRun, topAlternative, dominantBassPc, templateScore };
