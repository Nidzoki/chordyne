// Web Audio playback engine.
//
// Position tracking: an AudioBufferSourceNode has no "currentTime", so we
// remember where we started (audio offset + the AudioContext clock at start)
// and compute the current position from the context clock, scaled by the
// playback rate. Tempo is done with playbackRate.
//
// NOTE: playbackRate changes pitch as well as tempo. True independent
// pitch/tempo (slow down without going flat, transpose the audio) needs a
// time-stretch DSP such as SoundTouchJS or a phase-vocoder AudioWorklet.
// That is the planned upgrade — see analysis/README notes. For now the app
// transposes the *chart* (see state.transposeChord); the audio itself is not
// pitch-shifted.

import { getAudioContext } from "./decode.js";

export class Engine {
  constructor() {
    this.ctx = getAudioContext();
    this.buffer = null;
    this.source = null;
    this.rate = 1;
    this._offset = 0;          // audio position (s) captured at last start/pause
    this._startedAt = 0;       // ctx.currentTime when the current source began
    this.playing = false;
    this.onEnded = null;       // called when playback reaches the end naturally
  }

  load(audioBuffer) {
    this.stop();
    this.buffer = audioBuffer;
    this._offset = 0;
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }

  currentTime() {
    if (!this.playing) return this._offset;
    const elapsed = (this.ctx.currentTime - this._startedAt) * this.rate;
    return Math.min(this.duration, this._offset + elapsed);
  }

  _startSource(fromSec) {
    this._stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.ctx.destination);
    src.onended = () => {
      // fires on both natural end and manual stop; guard with a flag
      if (src._manualStop) return;
      this.playing = false;
      this._offset = this.duration;
      if (this.onEnded) this.onEnded();
    };
    src.start(0, Math.max(0, Math.min(fromSec, this.duration)));
    this._offset = fromSec;
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

  setRate(rate) {
    if (rate === this.rate) return;
    if (this.playing) {
      const now = this.currentTime();   // capture position at old rate
      this.rate = rate;
      this._startSource(now);           // restart at new rate from same spot
    } else {
      this.rate = rate;
    }
  }
}
