import { defineConfig } from "vite";

// This file is intentionally minimal. The real multi-entry build runs
// through scripts/build.mjs, not `vite build` directly — see that
// file's header comment for why (Rollup's IIFE-output-vs-code-
// splitting restriction across multiple entries that share imports).
// Kept around so editors/tooling that expect a vite.config.ts still
// get sane defaults (e.g. resolve aliases, if any get added later).
export default defineConfig({});
