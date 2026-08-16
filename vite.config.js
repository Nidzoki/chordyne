import { defineConfig } from "vite";

// base must match the GitHub Pages repo name for project-pages deploys,
// e.g. https://<user>.github.io/chordyne/  -> base: "/chordyne/".
// Override at build time: BASE=/myrepo/ npm run build
export default defineConfig({
  base: process.env.BASE || "/chordyne/",
  build: {
    target: "es2020",
    outDir: "dist",
  },
  // chords.worker.js dynamically imports essentia.js — Vite's default worker
  // build output is IIFE, which can't do dynamic import()/code-splitting.
  // "es" format supports it. Only affects `vite build`; the dev server
  // already serves everything as native ESM regardless.
  worker: {
    format: "es",
  },
});
