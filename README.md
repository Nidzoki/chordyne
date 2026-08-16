# Cadence

Offline chord-karaoke practice tool. Drop in a song, get a chord chart —
either a scannable grid ("Sheet") or a scrolling karaoke lane with a
playhead dot — and practice with independent pitch transpose and tempo
control. Everything runs in the browser; nothing is uploaded anywhere.

## Run it

```
npm install
npm run dev
```

Open the printed localhost URL, drop an MP3/WAV on the page.

Sanity-check the detector on its own (no browser, synthetic audio, plain
Node) with `npm run test:chords`. Probe the essentia.js API surface
directly with `npm run test:essentia` — useful if chord detection ever
silently falls back to the built-in extractor (check the browser console
for "essentia.js failed to load").

## Build + deploy to GitHub Pages

```
BASE=/cadence/ npm run build   # match your repo name
```

Push the contents of `dist/` to a `gh-pages` branch (or point Pages at
`dist/` via a GitHub Action) and enable Pages on that repo.

## How it works

```
File → decode.js (Web Audio decodeAudioData)
     → analysis/chords.worker.js (off the main thread — see below)
         → analysis/chords.js (chroma → beat sync → chord template match → segments)
     → state.song = { name, duration, segments: [{ idx, chord, start, end }] }
     → ui/sheet.js + ui/karaoke.js render the two views from the same segments
     → audio/engine.js drives real playback + tempo (playbackRate)
```

Chord detection runs in a Web Worker (`analysis/chords.worker.js`), not the
main thread. essentia's beat tracker is a synchronous WASM call that can take
several seconds on a long song with no way to yield mid-call — on the main
thread that means the whole tab visibly freezes for that stretch; in a
worker only that worker's own thread blocks, so the page (and the "Analysing
chords… X%" label) stays responsive. Verified end-to-end under plain Node
(worker semantics don't apply there, but the underlying `detectChords()` call
it wraps is the same one covered by `npm run test:chords`) — **not yet
confirmed working in an actual browser+Vite worker bundle**, same caveat as
essentia.js itself (see Known Gaps): dynamic `import()` inside a Vite-built
worker needs `worker: { format: "es" }` in `vite.config.js` (set), but the
real proof is loading a song and watching the tab stay interactive during
"Detecting rhythm…".

No backend — chord detection runs entirely client-side. Chroma extraction
uses [essentia.js](https://mtg.github.io/essentia.js/) (WASM port of
Essentia, a real benchmarked MIR library from UPF Barcelona), with the
hand-rolled FFT-based extractor in `src/analysis/chords.js` as an automatic
fallback if essentia fails to load. essentia also provides beat tracking
(`RhythmExtractor2013`) — when it finds a usable beat grid, chroma is
averaged per-beat instead of per-frame (chords overwhelmingly change on the
beat, and the averaging is a strong noise reducer too) and segment
boundaries snap to real beat times; otherwise detection falls back to raw
analysis frames. On top of that chroma, an 84-template (7 qualities x 12
roots, zero-sum weighted) matcher with a sliding local key estimate (tracks
modulations), a bass-note root cue, and spectral-flatness-weighted Viterbi
decoding (finds the best chord *path* through a run at once, instead of
deciding frame-by-frame) picks the chord sequence. Expect solid results on
a clean studio mix; live recordings, dense mixes, and jazz voicings are
still harder.

The detector doesn't just guess and hide it — every segment carries a
confidence flag, and low-confidence ones get a small dot in the Sheet view
(and a matching dot in karaoke) plus a click-to-edit pencil. Confidence
comes from two independent signals: how close the runner-up chord's score
was to the one that won (a real 50/50 call, not manufactured certainty),
and whether that chord is suspiciously rare across the song (real songs
reuse a small chord vocabulary — a one-off 2-second chord surrounded by
dozens of repeats of a handful of others is usually a misdetection, not a
deliberate one-off choice). Click the pencil to type a fix, or accept the
suggested alternative when there is one.

## Known gaps / next steps

These are deliberately left as the next build steps, not oversights:

- ~~essentia.js has not been confirmed working in an actual browser yet.~~
  **Resolved** — confirmed working live via the Vite dev server (browser
  console logs "using essentia.js for chroma extraction", real songs
  processed successfully). If the console ever shows "essentia.js failed to
  load" on some other machine/browser, detection still works via the
  automatic fallback to the built-in extractor.
- ~~7th-chord quality can be slightly off with essentia's chroma.~~
  **Resolved** — the flat-dot-product template score structurally punished
  extension tones (a real 7th at essentia's-observed ~50% relative
  magnitude scored *worse* than not having it at all). Fixed with a second
  scoring pass, `refineQuality`/`fitResidual` in `chords.js`, based on
  Oudre/Fuentes/Grenier's least-squares chroma-to-template fit (IEEE TASLP
  2011): after Viterbi picks a chord's root, a same-root quality upgrade
  (triad -> 7th/maj7/etc.) is only applied if it fits the chroma's actual
  energy distribution meaningfully better, not just "have any energy there
  at all." Root selection itself is untouched — still the zero-sum dot
  product, which needs to stay broadband-noise-robust in a way this
  refinement doesn't have to be.
- **Beat sync snaps to the beat, not the bar.** Chords can still change on
  any beat, not just downbeats — real, but coarser, progress over unaligned
  frame boundaries. True downbeat/bar detection (essentia has algorithms
  for it) would be the next step if per-beat isn't tight enough. Also:
  `_trace` (the debug dump used during development) only covers the
  frame-level fallback path right now, not beat-sync — extend it there
  first if beat-sync ever needs the same kind of frame-by-frame diagnosis
  the earlier bugs needed.
- ~~Pitch shift of the audio itself.~~ **Resolved** — `src/audio/stretch.js`
  implements WSOLA time-stretching from scratch (no new dependency), composed
  with `AudioBufferSourceNode.playbackRate` resampling in `engine.js` to give
  independent tempo and pitch: tempo change re-renders the buffer at the new
  duration and plays it back at rate 1 (pitch untouched); pitch change
  stretches by the pitch ratio and plays at that same rate (duration change
  cancels out, only the pitch shift survives). Validated against synthetic
  sine/harmonic tones via FFT in `scripts/test-stretch.mjs` (`npm run
  test:stretch`), not yet against a real recording. Recompute is debounced
  (350ms after the last slider move) and takes a few seconds on a full song —
  playback keeps running on the old buffer throughout, no dropout, just a
  brief dimming of the Pitch/Tempo readouts while it catches up.
- **Chord editing exists only in the Sheet view, not karaoke.** Click the
  pencil on any cell to fix it. Karaoke tokens show the same uncertainty dot
  but aren't editable yet — edit in Sheet, it updates both views.
- **Edits don't persist across a reload.** Re-uploading the same song
  re-runs detection from scratch and any manual fixes are gone — same root
  cause as "No persistence" below, would be solved together.
- **No section labels** (Intro/Verse/Chorus). Real section detection
  (self-similarity / novelty on the chromagram) is a reasonable v2; for
  now the grid is one flat list of chord changes.
- **Loop region is fixed** to the first few chord segments when you hit
  loop — there's no drag-to-select on the scrubber yet.
- **No persistence.** Re-uploading the same song re-runs detection from
  scratch; nothing is saved to IndexedDB/localStorage yet.
- **Lyrics** are out of scope for this scaffold (see project plan) —
  the karaoke lane is structured so a lyric line can slot in under the
  chord line later without a redesign.
- **`FLATNESS_THRESHOLD` (0.4) is an untuned default.** It decides how much
  spectral noise a frame can have before it's treated as percussion/crowd
  noise rather than a chord tone. Validated against synthetic tests (clean
  chord + injected white-noise burst); not yet tuned against a real live
  recording's actual noise floor. If a live recording still misfires during
  loud sections, this is the first constant to try adjusting.
- **No harmonic/percussive source separation.** Flatness gating is a cheap
  proxy for "is this frame noisy," not true HPSS (median-filtering a full
  spectrogram, like Chordino/librosa do). It catches the obvious cases
  (drum hits, noise bursts) but won't cleanly separate, say, a sustained
  cymbal wash from a quiet sustained chord underneath it.

## Project layout

```
src/
  state.js            central store + music/format helpers
  audio/
    decode.js          File -> AudioBuffer
    engine.js          playback, seek, tempo (playbackRate)
  analysis/
    fft.js              radix-2 FFT (built-in chroma fallback path only)
    essentiaHpcp.js      lazy-loaded essentia.js chroma extraction
    chords.js           template match + key estimate + segmentation
    chords.worker.js     runs the above off the main thread
  ui/
    sheet.js            grid view
    karaoke.js           scrolling lane view
    transport.js         play/seek/pitch/tempo/loop controls
    theme.js             light/dark toggle
  main.js               wiring: file load, controller, render loop
scripts/
  test-chords.mjs        detector regression suite (plain Node)
  test-essentia.mjs       essentia.js API probe (plain Node)
```
