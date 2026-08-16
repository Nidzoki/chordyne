// Decode a user-picked audio File into an AudioBuffer we can analyse + play.
// Uses a shared AudioContext so sample rates line up with playback.

let sharedCtx = null;
export function getAudioContext() {
  if (!sharedCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    sharedCtx = new Ctx();
  }
  return sharedCtx;
}

export async function decodeFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = getAudioContext();
  // decodeAudioData returns a Promise in modern browsers
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  return audioBuffer;
}
