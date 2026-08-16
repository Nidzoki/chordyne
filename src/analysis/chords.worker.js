// Runs chord detection off the main thread. essentia.js's beat tracker
// (RhythmExtractor2013) is a synchronous WASM call that can take several
// seconds on a long song with no way to yield mid-call — on the main thread
// that means the tab visibly freezes (can't scroll, click, anything) for
// that whole stretch. Here it just blocks this worker's own thread, which
// the user never sees or touches.
//
// chords.js itself has no DOM/window dependency, so it runs unchanged here —
// only the transport (postMessage instead of a direct return value) differs.

import { detectChords } from "./chords.js";

self.onmessage = async (e) => {
  const { channelData, numberOfChannels, sampleRate, duration } = e.data;

  // detectChords expects an AudioBuffer-shaped object (numberOfChannels,
  // length, sampleRate, duration, getChannelData) — exactly what the
  // regression suite's fake buffers already provide, so no signature change
  // was needed here beyond building the same shape from transferred arrays.
  const fakeBuffer = {
    numberOfChannels,
    length: channelData[0]?.length ?? 0,
    sampleRate,
    duration,
    getChannelData: (i) => channelData[i],
  };

  try {
    const result = await detectChords(fakeBuffer, (p, label) => {
      self.postMessage({ type: "progress", p, label });
    });
    self.postMessage({ type: "done", result });
  } catch (err) {
    self.postMessage({ type: "error", message: err?.message || String(err), stack: err?.stack });
  }
};
