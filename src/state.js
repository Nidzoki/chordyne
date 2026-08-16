// Central app state + a tiny pub/sub store. UI modules subscribe; nobody
// mutates `state` directly except through set().

export const state = {
  screen: "empty",     // "empty" | "processing" | "ready"
  view: "grid",        // "grid" | "karaoke"
  song: null,          // { name, duration, segments: [...], sections: [...] }
  playing: false,
  time: 0,             // playback position in seconds (real audio time)
  pitch: 0,            // semitone transpose applied to the chart
  tempoPct: 100,       // playback speed %
  loopOn: false,
  loopStart: 0,        // segment index
  loopEnd: 0,          // segment index
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function set(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

// ---------- music helpers ----------
const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_TO_SHARP = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B", Fb: "E" };

export function transposeChord(name, semis) {
  if (!name || name === "N.C.") return name;
  const m = name.match(/^([A-G][#b]?)(.*)$/);
  if (!m) return name;
  let root = FLAT_TO_SHARP[m[1]] || m[1];
  let i = SHARP.indexOf(root);
  if (i < 0) return name;
  i = ((i + semis) % 12 + 12) % 12;
  return SHARP[i] + m[2];
}

// wrap the chord quality (m, 7, maj7…) in <sup> for a cleaner chart look
export function fmtChord(name) {
  if (!name || name === "N.C.") return name || "";
  const m = name.match(/^([A-G][#b]?)(.*)$/);
  if (!m) return name;
  return m[1] + (m[2] ? `<sup>${m[2]}</sup>` : "");
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
