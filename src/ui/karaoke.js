// Karaoke lane view: chord tokens laid out on a horizontal timeline by
// their real start time, a fixed playhead dot in the centre, the lane
// scrolls under it. Current chord scales up; neighbours fade by distance.

import { state, fmtChord, transposeChord } from "../state.js";

const wrapEl = document.querySelector(".klane-wrap");
const laneEl = document.getElementById("klane");
const sectionEl = document.getElementById("ksection");
const beatEls = document.querySelectorAll(".kbeats i");

const PX_PER_SEC = 90; // lane scale — bump for a slower, more spaced-out feel

let tokens = [];
let onSeek = null;

export function initKaraoke(seekFn) { onSeek = seekFn; }

export function buildKaraoke(song) {
  laneEl.innerHTML = "";
  tokens = [];
  song.segments.forEach((seg) => {
    const cx = ((seg.start + seg.end) / 2) * PX_PER_SEC;
    const w = Math.max(40, (seg.end - seg.start) * PX_PER_SEC - 26);
    const tok = document.createElement("div");
    tok.className = "ktok";
    tok.style.left = cx + "px";
    tok.innerHTML =
      `<span class="kc">${fmtChord(seg.chord)}</span>`
      + `<span class="kbar" style="width:${w}px"></span>`
      + (seg.confident === false ? '<span class="k-uncertain-dot" title="Detector wasn\'t sure about this one"></span>' : "");
    tok.addEventListener("click", () => onSeek && onSeek(seg.start + 0.001));
    laneEl.appendChild(tok);
    tokens[seg.idx] = tok;
  });
  sectionEl.textContent = song.name || "";
}

export function applyTranspose() {
  if (!state.song) return;
  state.song.segments.forEach((seg) => {
    tokens[seg.idx].querySelector(".kc").innerHTML =
      fmtChord(transposeChord(seg.chord, state.pitch));
  });
}

export function frameKaraoke(cur, subBeat, timeSec) {
  if (!state.song) return;
  const x = timeSec * PX_PER_SEC;
  const centerX = wrapEl.clientWidth / 2;
  laneEl.style.transform = `translateX(${centerX - x}px)`;

  state.song.segments.forEach((seg) => {
    const tok = tokens[seg.idx];
    tok.classList.toggle("cur", seg.idx === cur);
    tok.classList.toggle("next", seg.idx > cur && seg.idx <= cur + 3);
    const cx = ((seg.start + seg.end) / 2) * PX_PER_SEC;
    const dist = Math.abs(cx - x);
    tok.style.opacity = String(Math.max(0.12, 1 - dist / (PX_PER_SEC * 6)));
  });

  beatEls.forEach((d, i) => d.classList.toggle("on", i <= subBeat && state.playing));
}
