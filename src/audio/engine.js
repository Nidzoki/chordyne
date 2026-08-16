// Web Audio playback engine.
//
// Position tracking: an AudioBufferSourceNode has no "currentTime", so we
// remember where we started (audio offset + the AudioContext clock at start)
// and compute the current position from the context clock. currentTime()
// always reports position on the *original song's* timeline (seconds that
// match chord segment start/end), regardless of which internal buffer is
// actually loaded.
//
// Independent tempo/pitch: playbackRate (and detune) on an
// AudioBufferSourceNode only resample — they can't change speed without
// changing pitch, or vice versa, because both drive the same underlying
// "how fast is the buffer consumed" knob. Real independent control needs
// actual time-stretching (see audio/stretch.js, WSOLA) composed with
// resampling:
//   - tempo only:  stretch the buffer by 1/tempoRatio, play at rate 1
//   - pitch only:  stretch the buffer by pitchRatio, play at rate pitchRatio
//                  (the stretch's duration change and the resample's
//                  duration change exactly cancel; only the resample's
//                  pitch shift survives)
//   - both:        stretch by pitchRatio/tempoRatio, play at rate pitchRatio
// setTempoRatio/setPitchRatio both funnel into one debounced rebuild since
// the buffer that actually needs producing depends on their ratio, not
// either alone — see _rebuild.

import { getAudioContext } from "./decode.js";
import { timeStretch } from "./stretch.js";

const REBUILD_DEBOUNCE_MS = 350; // wait for the user to stop dragging the
                                  // slider before paying for a WSOLA pass —
                                  // recomputing on every `input` tick would
                                  // be wasteful and would stutter playback

export class Engine {
  constructor() {
    this.ctx = getAudioContext();
    this.originalBuffer = null;
    this.buffer = null;             // buffer actually loaded into the source node right now
    this._activeStretchFactor = 1;  // stretch factor used to produce `this.buffer` from originalBuffer
    this.source = null;
    this.rate = 1;                  // tempo ratio actually in effect (drives currentTime() elapsed scaling)
    this.pitchRatio = 1;            // playbackRate.value actually in effect
    this._targetTempo = 1;
    this._targetPitch = 1;
    this._rebuildTimer = null;
    this._rebuildToken = 0;         // lets a newer rebuild request cancel/ignore a stale in-flight one
    this._offset = 0;               // song position (s) captured at last start/pause — always on the original timeline
    this._startedAt = 0;            // ctx.currentTime when the current source began
    this.playing = false;
    this.onEnded = null;            // called when playback reaches the end naturally
    this.onRebuildStart = null;     // optional UI hooks — tempo/pitch recompute in progress
    this.onRebuildProgress = null;  // called with 0..1
    this.onRebuildEnd = null;
  }

  load(audioBuffer) {
    this.stop();
    this.originalBuffer = audioBuffer;
    this.buffer = audioBuffer;
    this._activeStretchFactor = 1;
    this.rate = 1;
    this.pitchRatio = 1;
    this._targetTempo = 1;
    this._targetPitch = 1;
    this._offset = 0;
  }

  get duration() { return this.originalBuffer ? this.originalBuffer.duration : 0; }

  currentTime() {
    if (!this.playing) return this._offset;
    const elapsed = (this.ctx.currentTime - this._startedAt) * this.rate;
    return Math.min(this.duration, this._offset + elapsed);
  }

  _startSource(fromSongSec) {
    this._stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.pitchRatio;
    src.connect(this.ctx.destination);
    src.onended = () => {
      // fires on both natural end and manual stop; guard with a flag
      if (src._manualStop) return;
      this.playing = false;
      this._offset = this.duration;
      if (this.onEnded) this.onEnded();
    };
    const bufSec = fromSongSec * this._activeStretchFactor;
    src.start(0, Math.max(0, Math.min(bufSec, this.buffer.duration)));
    this._offset = fromSongSec;
    this._startedAt = this.ctx.currentTime;
    this.source = src;
  }

  _stopSource() {
    if (this.source) {
      this.source._manualStop = true;
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  async play() {
    if (!this.buffer || this.playing) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this._startSource(this._offset);
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this._offset = this.currentTime();
    this.playing = false;
    this._stopSource();
  }

  stop() {
    this.playing = false;
    this._stopSource();
    this._offset = 0;
  }

  seek(sec) {
    sec = Math.max(0, Math.min(sec, this.duration));
    if (this.playing) this._startSource(sec);
    else this._offset = sec;
  }

  // ---- independent tempo/pitch ----
  setTempoRatio(tempoRatio) {
    this._targetTempo = tempoRatio;
    this._scheduleRebuild();
  }

  setPitchRatio(pitchRatio) {
    this._targetPitch = pitchRatio;
    this._scheduleRebuild();
  }

  _scheduleRebuild() {
    if (!this.originalBuffer) return;
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => this._rebuild(), REBUILD_DEBOUNCE_MS);
  }

  async _rebuild() {
    const token = ++this._rebuildToken;
    const tempoRatio = this._targetTempo, pitchRatio = this._targetPitch;
    const stretchFactor = pitchRatio / tempoRatio;

    if (this.onRebuildStart) this.onRebuildStart();
    const newBuffer = Math.abs(stretchFactor - 1) < 1e-6
      ? this.originalBuffer
      : await timeStretch(this.originalBuffer, stretchFactor, (p) => {
          if (token === this._rebuildToken && this.onRebuildProgress) this.onRebuildProgress(p);
        });

    // a newer tempo/pitch request came in (and is now itself in flight or
    // already applied) while this WSOLA pass was running — this result is
    // stale, drop it rather than stomping over whatever's current
    if (token !== this._rebuildToken) return;
    if (this.onRebuildEnd) this.onRebuildEnd();

    const wasPlaying = this.playing;
    const songPos = this.currentTime();  // capture on the *old* buffer/rate before swapping
    this.buffer = newBuffer;
    this._activeStretchFactor = stretchFactor;
    this.rate = tempoRatio;
    this.pitchRatio = pitchRatio;
    if (wasPlaying) this._startSource(songPos);
    else this._offset = songPos;
  }
}
