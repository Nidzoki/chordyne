// Transport bar: play/pause/rewind/forward/loop, scrubber, pitch stepper,
// tempo slider. Pure DOM wiring — all actual behaviour lives in the
// controller passed in from main.js.

import { state, fmtTime } from "../state.js";

const els = {
  transport: document.getElementById("transport"),
  hint: document.getElementById("hint"),
  scrub: document.getElementById("scrub"),
  fill: document.getElementById("fill"),
  head: document.getElementById("scrubHead"),
  loopband: document.getElementById("loopband"),
  curTime: document.getElementById("curTime"),
  totTime: document.getElementById("totTime"),
  playBtn: document.getElementById("playBtn"),
  playIcon: document.getElementById("playIcon"),
  rewBtn: document.getElementById("rewBtn"),
  fwdBtn: document.getElementById("fwdBtn"),
  loopBtn: document.getElementById("loopBtn"),
  pitchUp: document.getElementById("pitchUp"),
  pitchDown: document.getElementById("pitchDown"),
  pitchVal: document.getElementById("pitchVal"),
  tempo: document.getElementById("tempo"),
  tempoVal: document.getElementById("tempoVal"),
};

const PLAY_ICON = '<path d="M8 5v14l11-7L8 5z"/>';
const PAUSE_ICON = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';

export function initTransport(ctrl) {
  els.transport.hidden = false;
  els.hint.hidden = false;

  els.playBtn.addEventListener("click", () => ctrl.toggle());
  els.rewBtn.addEventListener("click", () => ctrl.rewind());
  els.fwdBtn.addEventListener("click", () => ctrl.forward());
  els.loopBtn.addEventListener("click", () => ctrl.toggleLoop());
  els.pitchUp.addEventListener("click", () => ctrl.setPitch(state.pitch + 1));
  els.pitchDown.addEventListener("click", () => ctrl.setPitch(state.pitch - 1));
  els.tempo.addEventListener("input", () => ctrl.setTempo(+els.tempo.value));

  let dragging = false;
  const seekFromEvent = (e) => {
    const r = els.scrub.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    ctrl.seek(pct * (state.song ? state.song.duration : 0));
  };
  els.scrub.addEventListener("mousedown", (e) => { dragging = true; seekFromEvent(e); });
  window.addEventListener("mousemove", (e) => { if (dragging) seekFromEvent(e); });
  window.addEventListener("mouseup", () => { dragging = false; });
  els.scrub.addEventListener("touchstart", seekFromEvent, { passive: true });
  els.scrub.addEventListener("touchmove", seekFromEvent, { passive: true });

  window.addEventListener("keydown", (e) => {
    if (!state.song) return;
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space") { e.preventDefault(); ctrl.toggle(); }
    else if (e.key.toLowerCase() === "l") ctrl.toggleLoop();
    else if (e.key === "ArrowLeft") ctrl.seek(state.time - 2);
    else if (e.key === "ArrowRight") ctrl.seek(state.time + 2);
  });
}

export function setPlayIcon(playing) {
  els.playIcon.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
}

export function renderPitch() {
  els.pitchVal.textContent = (state.pitch > 0 ? "+" : "") + state.pitch;
  els.pitchVal.classList.toggle("zero", state.pitch === 0);
}

export function renderTempo() {
  els.tempoVal.textContent = state.tempoPct + "%";
}

export function renderLoopButton() {
  els.loopBtn.classList.toggle("on", state.loopOn);
}

// loopStartSec/loopEndSec are seconds (already resolved from segment indices)
export function renderLoopband(loopStartSec, loopEndSec) {
  if (!state.song || !state.loopOn) { els.loopband.style.display = "none"; return; }
  const dur = state.song.duration || 1;
  els.loopband.style.display = "block";
  els.loopband.style.left = (loopStartSec / dur) * 100 + "%";
  els.loopband.style.width = ((loopEndSec - loopStartSec) / dur) * 100 + "%";
}

export function frameTransport(timeSec, duration) {
  const pct = duration ? (timeSec / duration) * 100 : 0;
  els.fill.style.width = pct + "%";
  els.head.style.left = pct + "%";
  els.curTime.textContent = fmtTime(timeSec);
  els.totTime.textContent = fmtTime(duration);
}
