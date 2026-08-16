// Grid / "sheet" view: every chord segment is a cell, wrapping 4 per row.
// current segment is highlighted and scrolled into view during playback.
// Cells the detector wasn't confident about (close call between two chords,
// or a chord that's suspiciously rare in this song) get a small dot and can
// be edited directly — click the pencil, type a fix or accept the suggested
// alternative.

import { state, fmtChord, transposeChord } from "../state.js";

const sheetEl = document.getElementById("sheet");
let cells = [];       // cell element per segment index
let onSeek = null;    // (seconds) => void
let onEditChord = null; // (idx, newChordName) => void — newChordName is in
                         // DISPLAY (transposed) terms; the caller un-transposes

const EDIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

export function initSheet(seekFn, editFn) { onSeek = seekFn; onEditChord = editFn; }

export function buildSheet(song) {
  sheetEl.innerHTML = "";
  cells = [];

  const head = document.createElement("div");
  head.className = "section-head";
  head.innerHTML = `<span class="name">Chords</span><span class="rule"></span>`
    + `<span class="count">${song.segments.length} changes</span>`;
  sheetEl.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "measures";
  sheetEl.appendChild(grid);

  song.segments.forEach((seg) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.tabIndex = 0;
    cell.dataset.idx = seg.idx;
    cell.innerHTML =
      `<div class="chord">${fmtChord(seg.chord)}</div>`
      + `<div class="beats"><i></i><i></i><i></i><i></i></div>`
      + `<span class="loop-tag" hidden>loop</span>`
      + (seg.confident === false ? '<span class="uncertain-dot" title="Detector wasn\'t sure about this one"></span>' : "")
      + `<button class="edit-btn" type="button" aria-label="Edit chord" title="Edit chord">${EDIT_ICON}</button>`;
    const jump = () => onSeek && onSeek(seg.start + 0.001);
    cell.addEventListener("click", jump);
    cell.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(); } });
    cell.querySelector(".edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      startEdit(seg, cell);
    });
    grid.appendChild(cell);
    cells[seg.idx] = cell;
  });
}

function startEdit(seg, cell) {
  if (cell.classList.contains("editing")) return;
  cell.classList.add("editing");
  const currentDisplay = transposeChord(seg.chord, state.pitch);
  const chordDiv = cell.querySelector(".chord");
  const beatsDiv = cell.querySelector(".beats");
  chordDiv.style.display = "none";
  if (beatsDiv) beatsDiv.style.display = "none";

  const wrap = document.createElement("div");
  wrap.className = "chord-edit";
  const altDisplay = seg.alt ? transposeChord(seg.alt, state.pitch) : null;
  wrap.innerHTML =
    `<input class="chord-input" type="text" value="${currentDisplay}" autocomplete="off" spellcheck="false" />`
    + (altDisplay ? `<button type="button" class="alt-btn">Use ${fmtChord(altDisplay).replace(/<\/?sup>/g, "")}</button>` : "");
  cell.insertBefore(wrap, chordDiv);

  const input = wrap.querySelector(".chord-input");
  input.focus();
  input.select();

  const finish = (commit) => {
    cell.classList.remove("editing");
    wrap.remove();
    chordDiv.style.display = "";
    if (beatsDiv) beatsDiv.style.display = "";
    if (commit) {
      const val = input.value.trim();
      if (val && val !== currentDisplay) onEditChord && onEditChord(seg.idx, val);
    }
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());

  const altBtn = wrap.querySelector(".alt-btn");
  if (altBtn) {
    altBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      input.value = altDisplay;
      finish(true);
    });
  }
}

export function applyTranspose() {
  if (!state.song) return;
  state.song.segments.forEach((seg) => {
    cells[seg.idx].querySelector(".chord").innerHTML =
      fmtChord(transposeChord(seg.chord, state.pitch));
  });
}

export function applyLoopMarks() {
  if (!state.song) return;
  state.song.segments.forEach((seg) => {
    const inLoop = state.loopOn && seg.idx >= state.loopStart && seg.idx <= state.loopEnd;
    cells[seg.idx].classList.toggle("loopmark", inLoop);
    cells[seg.idx].querySelector(".loop-tag").hidden = !(state.loopOn && seg.idx === state.loopStart);
  });
}

// per-frame update; `cur` is the active segment index
export function frameSheet(cur, subBeat) {
  if (!state.song) return;
  state.song.segments.forEach((seg) => {
    const cell = cells[seg.idx];
    cell.classList.toggle("active", seg.idx === cur && state.playing);
    cell.classList.toggle("done", seg.idx < cur);
  });
  const active = cells[cur];
  if (active) {
    active.querySelectorAll(".beats i").forEach((d, i) =>
      d.classList.toggle("on", i <= subBeat && state.playing));
    if (state.playing) {
      const r = active.getBoundingClientRect();
      const sr = sheetEl.getBoundingClientRect();
      if (r.top < sr.top + 60 || r.bottom > sr.bottom - 20) {
        active.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }
}
