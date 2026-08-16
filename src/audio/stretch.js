// WSOLA (Waveform-Similarity Overlap-Add) time-stretching — changes an
// audio buffer's duration by `stretchFactor` (>1 = longer/slower, <1 =
// shorter/faster) while preserving pitch. Alignment search runs once per hop
// on a mono mix (so stereo channels stay phase-coherent — picking each
// channel's own best offset independently would decorrelate L/R) and the
// chosen offset is applied identically to every channel.
//
// Composed with plain resampling (AudioBufferSourceNode.playbackRate) this
// gives independent tempo and pitch control — see engine.js: stretch by
// pitchRatio/tempoRatio, then play the result at rate=pitchRatio. Stretching
// alone (played back at rate 1) changes tempo only, pitch preserved.
// Stretching by a ratio and then playing at that same ratio changes pitch
// only — the duration change from playbackRate exactly cancels the stretch,
// only the pitch shift from the resample survives.
//
// First-pass practical implementation — frame/hop/search sizes tuned for
// "fast enough to run synchronously on a multi-minute song" over "reference-
// quality stretcher." Works well on sustained/harmonic material (most of
// what a chord-chart practice tool is used on); can smear sharp transients.
// Validated against synthetic sine tones only (scripts/test-stretch.mjs) —
// not yet against a real recording.

// FRAME=4096 (~93ms @44.1kHz) was found empirically, not guessed: at smaller
// frames (1024-2048) a sustained tone reconstructs at the *wrong* pitch —
// not from a bug in the alignment search, but because a short frame doesn't
// span enough periods for the correlation to have a clear, unambiguous peak
// (a pure/near-periodic tone's self-correlation is nearly flat across small
// shifts, so the search — and even plain fixed-hop OLA with no search at
// all — converges to the same wrong answer). Verified via
// scripts/test-stretch.mjs, which checks reconstructed pitch against an FFT,
// not just duration.
const FRAME = 4096;
const HOP_OUT = 1024;  // synthesis hop (75% overlap with FRAME)
const TOLERANCE = 192; // search window either side of the ideal analysis position
const CORR_LEN = 384;  // samples compared when scoring a candidate alignment
const PROXIMITY_BIAS = 0.05; // see the comment at its use below

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}
const WIN = hannWindow(FRAME);

const nextTick = () => new Promise((r) => setTimeout(r, 0));

// Browser: a real AudioBuffer (what AudioBufferSourceNode.buffer requires).
// Node (scripts/test-stretch.mjs): a plain fake-buffer shape — same
// convention chords.worker.js/test-chords.mjs already use for AudioBuffer-
// shaped test fixtures, so the same stretch code runs unmodified in both.
function makeBuffer(nCh, length, sampleRate, channelData) {
  if (typeof AudioBuffer !== "undefined") {
    const buf = new AudioBuffer({ numberOfChannels: nCh, length, sampleRate });
    for (let c = 0; c < nCh; c++) buf.copyToChannel(channelData[c], c);
    return buf;
  }
  return {
    numberOfChannels: nCh, length, sampleRate, duration: length / sampleRate,
    getChannelData: (i) => channelData[i],
  };
}

export async function timeStretch(audioBuffer, stretchFactor, onProgress) {
  const nCh = audioBuffer.numberOfChannels;
  const inLen = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;
  const outLen = Math.max(1, Math.round(inLen * stretchFactor));

  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(audioBuffer.getChannelData(c));

  // mono mix, used only to pick alignment offsets
  const mono = new Float32Array(inLen);
  for (let c = 0; c < nCh; c++) for (let i = 0; i < inLen; i++) mono[i] += chans[c][i] / nCh;

  const outChans = [];
  for (let c = 0; c < nCh; c++) outChans.push(new Float32Array(outLen));
  const weight = new Float32Array(outLen); // overlap-add normalization (Hann doesn't sum to a flat constant at the very edges)

  const hopIn = HOP_OUT / stretchFactor;
  const nHops = Math.ceil(outLen / HOP_OUT) + 1;

  let readPos = 0;    // ideal (float) input analysis position
  let actualPos = 0;  // input position actually used, previous hop

  for (let k = 0; k < nHops; k++) {
    const synthPos = k * HOP_OUT;
    if (synthPos >= outLen) break;
    const ideal = Math.round(readPos);

    let chosen = ideal;
    if (k > 0) {
      // best alignment: the candidate frame near `ideal` should smoothly
      // continue what's already in the output — compare candidates against
      // the input segment right after where the *previous* frame was
      // actually taken from (actualPos + HOP_OUT), i.e. what the signal
      // would naturally do next if it weren't being stretched
      const ref = actualPos + HOP_OUT;
      let nb = 0;
      if (ref >= 0 && ref + CORR_LEN <= inLen) {
        for (let i = 0; i < CORR_LEN; i++) { const y = mono[ref + i]; nb += y * y; }
      }
      nb = Math.sqrt(nb) || 1;

      let bestScore = -Infinity, bestOffset = 0;
      for (let d = -TOLERANCE; d <= TOLERANCE; d++) {
        const cand = ideal + d;
        if (cand < 0 || cand + CORR_LEN > inLen || ref < 0 || ref + CORR_LEN > inLen) continue;
        let dot = 0, na = 0;
        for (let i = 0; i < CORR_LEN; i++) {
          const x = mono[cand + i], y = mono[ref + i];
          dot += x * y; na += x * x;
        }
        // small bias toward the ideal (d=0) position: a pure/near-periodic
        // tone's correlation has multiple near-equal peaks spaced by its own
        // period, so unbiased argmax can wander a few samples off center
        // every hop and accumulate into audible pitch drift over the whole
        // track. The bias barely matters when one offset genuinely
        // correlates much better (real transient/percussive material), but
        // breaks ties toward the position that best preserves timing.
        const score = dot / ((Math.sqrt(na) || 1) * nb) - PROXIMITY_BIAS * (Math.abs(d) / TOLERANCE);
        if (score > bestScore) { bestScore = score; bestOffset = d; }
      }
      chosen = ideal + bestOffset;
    }
    chosen = Math.max(0, Math.min(chosen, Math.max(0, inLen - 1)));
    actualPos = chosen;

    for (let c = 0; c < nCh; c++) {
      const src = chans[c], out = outChans[c];
      const n = Math.min(FRAME, outLen - synthPos, inLen - chosen);
      for (let i = 0; i < n; i++) out[synthPos + i] += src[chosen + i] * WIN[i];
    }
    {
      const n = Math.min(FRAME, outLen - synthPos);
      for (let i = 0; i < n; i++) weight[synthPos + i] += WIN[i];
    }

    readPos += hopIn;

    // yield unconditionally, not just when a caller wants progress —
    // otherwise a caller that skips onProgress (as engine.js originally
    // did) runs the whole multi-second WSOLA pass as one blocking
    // synchronous call and freezes the tab for its entire duration
    if (k % 128 === 0) {
      if (onProgress) onProgress(k / nHops);
      await nextTick();
    }
  }

  for (let c = 0; c < nCh; c++) {
    const out = outChans[c];
    for (let i = 0; i < outLen; i++) if (weight[i] > 1e-6) out[i] /= weight[i];
  }
  if (onProgress) onProgress(1);

  return makeBuffer(nCh, outLen, sampleRate, outChans);
}
