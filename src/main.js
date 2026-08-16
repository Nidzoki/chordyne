import "./styles.css";
import { state, set, transposeChord } from "./state.js";
import { decodeFile } from "./audio/decode.js";
import { Engine } from "./audio/engine.js";
import { initSheet, buildSheet, applyTranspose as sheetTranspose, applyLoopMarks, frameSheet } from "./ui/sheet.js";
import { initKaraoke, buildKaraoke, applyTranspose as karaokeTranspose, frameKaraoke } from "./ui/karaoke.js";
import { initTransport, setPlayIcon, renderPitch, renderTempo, renderLoopButton, renderLoopband, frameTransport } from "./ui/transport.js";
import { initTheme } from "./ui/theme.js";

const el = {
  dropzone: document.getElementById("dropzone"),
  processing: document.getElementById("processing"),
  procFill: document.getElementById("procFill"),
  procLabel: document.getElementById("procLabel"),
  sheet: document.getElementById("sheet"),
  karaoke: document.getElementById("karaoke"),
  viewToggle: document.getElementById("viewToggle"),
  uploadBtn: document.getElementById("uploadBtn"),
  fileInput: document.getElementById("fileInput"),
  npLabel: document.getElementById("npLabel"),
  npTitle: document.getElementById("npTitle"),
  npMeta: document.getElementById("npMeta"),
};

const engine = new Engine();
// brief visual cue while a tempo/pitch change is being recomputed (WSOLA
// pass can take a couple of seconds on a full song) — playback keeps
// running on the old buffer throughout, this is purely so the controls
// don't look unresponsive
const pitchValEl = document.getElementById("pitchVal");
const tempoValEl = document.getElementById("tempoVal");
engine.onRebuildStart = () => {
  pitchValEl.style.opacity = tempoValEl.style.opacity = "0.5";
  pitchValEl.dataset.real = pitchValEl.textContent;
  tempoValEl.dataset.real = tempoValEl.textContent;
};
engine.onRebuildProgress = (p) => {
  const pct = Math.round(p * 100) + "%";
  pitchValEl.textContent = pct;
  tempoValEl.textContent = pct;
};
engine.onRebuildEnd = () => {
  pitchValEl.style.opacity = tempoValEl.style.opacity = "1";
  pitchValEl.textContent = pitchValEl.dataset.real;
  tempoValEl.textContent = tempoValEl.dataset.real;
};

// ---------- screen state ----------
function showScreen(screen) {
  set({ screen });
  el.dropzone.hidden = screen !== "empty";
  el.processing.hidden = screen !== "processing";
  const ready = screen === "ready";
  el.viewToggle.hidden = !ready;
  applyViewVisibility();
}

function applyViewVisibility() {
  const ready = state.screen === "ready";
  el.sheet.hidden = !(ready && state.view === "grid");
  el.karaoke.hidden = !(ready && state.view === "karaoke");
}

// ---------- controller (wired into UI modules) ----------
const ctrl = {
  async play() {
    if (!state.song) return;
    await engine.play();
    set({ playing: true });
    setPlayIcon(true);
  },
  pause() {
    engine.pause();
    set({ playing: false });
    setPlayIcon(false);
  },
  toggle() { state.playing ? ctrl.pause() : ctrl.play(); },
  seek(sec) {
    if (!state.song) return;
    sec = Math.max(0, Math.min(sec, state.song.duration));
    engine.seek(sec);
    set({ time: sec });
    renderFrame();
  },
  rewind() { ctrl.seek(state.time - 8); },
  forward() { ctrl.seek(state.time + 8); },
  setPitch(v) {
    const semis = Math.max(-6, Math.min(6, v));
    set({ pitch: semis });
    engine.setPitchRatio(2 ** (semis / 12));
    sheetTranspose();
    karaokeTranspose();
    renderPitch();
    renderMeta();
  },
  setTempo(pct) {
    engine.setTempoRatio(pct / 100);
    set({ tempoPct: pct });
    renderTempo();
    renderMeta();
  },
  toggleLoop() {
    set({ loopOn: !state.loopOn });
    renderLoopButton();
    applyLoopMarks();
    renderLoopbandSeconds();
  },
  setLoopRange(startIdx, endIdx) {
    if (!state.song) return;
    set({ loopStart: startIdx, loopEnd: endIdx, loopOn: true });
    renderLoopButton();
    applyLoopMarks();
    renderLoopbandSeconds();
  },
  setView(v) {
    set({ view: v });
    el.viewToggle.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("sel", b.dataset.view === v));
    applyViewVisibility();
    renderFrame();
  },
  // newDisplayValue is what the user typed, in currently-displayed
  // (transposed) terms — store it un-transposed, matching how every other
  // segment's chord is stored, so pitch changes keep working on the edit too
  editChord(idx, newDisplayValue) {
    if (!state.song) return;
    const seg = state.song.segments[idx];
    if (!seg) return;
    seg.chord = transposeChord(newDisplayValue, -state.pitch);
    seg.confident = true;
    seg.alt = null;
    buildSheet(state.song);
    buildKaraoke(state.song);
    sheetTranspose();
    karaokeTranspose();
    applyLoopMarks();
    renderFrame();
  },
};

// dominant key = the single longest key segment, not just the first — a
// song that modulates late (e.g. a step-up final chorus) shouldn't have its
// whole-song label dominated by 4 bars at the very end. Transposed by the
// current pitch setting so it stays consistent with the chart/audio.
function renderMeta() {
  if (!state.song) { el.npMeta.textContent = ""; return; }
  const { keys, bpm } = state.song;
  const parts = [];
  if (keys && keys.length) {
    const longest = keys.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    const keyName = transposeChord(longest.name, state.pitch);
    parts.push(keys.length > 1 ? `${keyName} (+ modulations)` : keyName);
  }
  if (bpm) parts.push(`${Math.round(bpm * (state.tempoPct / 100))} BPM`);
  el.npMeta.textContent = parts.join(" · ");
}

function renderLoopbandSeconds() {
  if (!state.song) return;
  const segs = state.song.segments;
  const startSec = segs[state.loopStart] ? segs[state.loopStart].start : 0;
  const endSec = segs[state.loopEnd] ? segs[state.loopEnd].end : state.song.duration;
  renderLoopband(startSec, endSec);
}

initSheet(ctrl.seek, ctrl.editChord, ctrl.setLoopRange);
initKaraoke(ctrl.seek);
initTransport(ctrl);
initTheme();

el.viewToggle.querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => ctrl.setView(b.dataset.view)));

// ---------- chord detection, off the main thread ----------
// essentia.js's beat tracker is a synchronous WASM call that can genuinely
// take several seconds on a long song with no way to yield mid-call — run
// on the main thread that freezes the whole tab for that stretch. Running
// it in a Worker means only that worker's own thread blocks; the page stays
// responsive throughout.
function detectChordsInWorker(buffer, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./analysis/chords.worker.js", import.meta.url), { type: "module" });
    const channelData = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channelData.push(buffer.getChannelData(c).slice());

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "progress") onProgress(msg.p, msg.label);
      else if (msg.type === "done") { worker.terminate(); resolve(msg.result); }
      else if (msg.type === "error") { worker.terminate(); reject(new Error(msg.message)); }
    };
    worker.onerror = (err) => { worker.terminate(); reject(err); };

    worker.postMessage(
      { channelData, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate, duration: buffer.duration },
      channelData.map((a) => a.buffer)   // transfer, not copy, across the postMessage boundary
    );
  });
}

// ---------- loading a file ----------
async function loadFile(file) {
  showScreen("processing");
  el.procFill.style.width = "0%";
  el.procLabel.textContent = "Decoding audio…";

  let buffer;
  try {
    buffer = await decodeFile(file);
  } catch (err) {
    el.procLabel.textContent = "Could not decode that file. Try an MP3 or WAV.";
    console.error(err);
    setTimeout(() => showScreen("empty"), 2000);
    return;
  }

  engine.load(buffer);

  el.procLabel.textContent = "Analysing chords… 0%";
  let result;
  try {
    result = await detectChordsInWorker(buffer, (p, label) => {
      const pct = Math.round(p * 100);
      el.procFill.style.width = pct + "%";
      el.procLabel.textContent = `${label || "Analysing chords…"} ${pct}%`;
    });
  } catch (err) {
    el.procLabel.textContent = "Chord detection failed. Try a different file.";
    console.error(err);
    setTimeout(() => showScreen("empty"), 2000);
    return;
  }

  const song = {
    name: file.name.replace(/\.[^.]+$/, ""),
    duration: result.duration,
    segments: result.segments,
    keys: result.keys,
    bpm: result.bpm,
  };
  set({
    song, time: 0, playing: false, pitch: 0, tempoPct: 100,
    loopOn: false, loopStart: 0, loopEnd: Math.min(3, song.segments.length - 1),
  });

  buildSheet(song);
  buildKaraoke(song);
  renderPitch();
  renderTempo();
  renderLoopButton();

  el.npLabel.textContent = "Now practicing";
  el.npTitle.textContent = song.name;
  renderMeta();

  showScreen("ready");
  renderFrame();

  // debug aid: dump the detected timeline to the console so it can be
  // copy-pasted for diagnosis instead of describing it by hand
  console.log(`Chordyne: detected ${song.segments.length} chord segments for "${song.name}"`);
  console.table(song.segments.map((s) => ({
    idx: s.idx, start: s.start.toFixed(2), end: s.end.toFixed(2),
    dur: (s.end - s.start).toFixed(2), chord: s.chord,
  })));
  console.log(`Chordyne: key timeline (${result.keys.length} segment(s) — more than one means a modulation was detected)`);
  console.table(result.keys.map((k) => ({
    start: k.start.toFixed(2), end: k.end.toFixed(2), key: k.name,
  })));
  console.log("Run copy(JSON.stringify(window.__chordyne.state.song.segments)) to copy the full chord list.");
}

// exposed for debugging in the browser console
window.__chordyne = { state, engine };

engine.onEnded = () => { set({ playing: false }); setPlayIcon(false); };

// ---------- file input / drag+drop ----------
el.uploadBtn.addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", () => {
  const f = el.fileInput.files[0];
  if (f) loadFile(f);
});
for (const stage of [el.dropzone, document.body]) {
  stage.addEventListener("dragover", (e) => { e.preventDefault(); el.dropzone.classList.add("dragover"); });
  stage.addEventListener("dragleave", () => el.dropzone.classList.remove("dragover"));
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    el.dropzone.classList.remove("dragover");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
}

// ---------- per-frame render ----------
function findSegmentIndex(t) {
  const segs = state.song.segments;
  for (let i = 0; i < segs.length; i++) {
    if (t < segs[i].end || i === segs.length - 1) return i;
  }
  return segs.length - 1;
}

function renderFrame() {
  if (!state.song) return;
  const cur = findSegmentIndex(state.time);
  const seg = state.song.segments[cur];
  const span = Math.max(0.001, seg.end - seg.start);
  const subBeat = Math.min(3, Math.floor(((state.time - seg.start) / span) * 4));

  if (state.view === "grid") frameSheet(cur, subBeat);
  else frameKaraoke(cur, subBeat, state.time);

  frameTransport(state.time, state.song.duration);
}

function tick() {
  if (state.playing && state.song) {
    let t = engine.currentTime();

    if (state.loopOn) {
      const segs = state.song.segments;
      const loopEndSec = segs[state.loopEnd] ? segs[state.loopEnd].end : state.song.duration;
      const loopStartSec = segs[state.loopStart] ? segs[state.loopStart].start : 0;
      if (t >= loopEndSec) {
        engine.seek(loopStartSec);
        t = loopStartSec;
      }
    }
    set({ time: t });
    renderFrame();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
