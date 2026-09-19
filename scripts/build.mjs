// Rollup refuses to emit IIFE output for a build with more than one
// entry point once any two entries share a statically-imported module
// (e.g. types/messages.ts) — it treats that as "code-splitting" and
// UMD/IIFE don't support it, full stop, regardless of whether a
// shared chunk is actually required.
//
// Since content scripts (classic scripts, per Chrome's manifest
// schema), the Whisper worker, and the AudioWorklet all need
// self-contained non-module output, the fix is to give each entry its
// own isolated Vite build (single input each), so there's never a
// cross-entry chunk to split in the first place. Shared source
// (types/messages.ts etc.) is simply duplicated into each bundle —
// fine here, since these are five genuinely separate runtime contexts
// that were never going to share a loaded module at runtime anyway.

import { build } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { copyFileSync, cpSync, mkdirSync, existsSync, rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "dist");

/** @type {Array<{ name: string; entry: string }>} */
const entries = [
  { name: "background/service-worker", entry: "src/background/service-worker.ts" },
  { name: "content/meet-inject", entry: "src/content/meet-inject.ts" },
  { name: "content/zoom-inject", entry: "src/content/zoom-inject.ts" },
  { name: "capture/audio-worklet", entry: "src/capture/audio-worklet.ts" },
  { name: "asr/whisper-worker", entry: "src/asr/whisper-worker.ts" },
  { name: "popup/popup", entry: "src/popup/popup.ts" },
  { name: "offscreen/offscreen", entry: "src/offscreen/offscreen.ts" }
];

const staticFiles = [
  ["manifest.json", "manifest.json"],
  ["src/popup/popup.html", "popup/popup.html"],
  ["src/popup/popup.css", "popup/popup.css"],
  ["src/content/overlay/overlay.css", "content/overlay/overlay.css"],
  ["src/offscreen/offscreen.html", "offscreen/offscreen.html"]
];

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const { name, entry } of entries) {
    console.log(`[build] ${name}`);
    await build({
      root,
      configFile: false,
      logLevel: "warn",
      build: {
        outDir,
        emptyOutDir: false, // we clear it once, up front, ourselves
        target: "es2022",
        rollupOptions: {
          input: resolve(root, entry),
          output: {
            format: "iife",
            entryFileNames: `${name}.js`,
            // A single-input build never needs a shared chunk, so this
            // is just belt-and-suspenders against future entries that
            // might accidentally add a dynamic import().
            inlineDynamicImports: true
          }
        }
      }
    });
  }

  // ONNX Runtime's WASM has to be served from the extension itself.
  // transformers.js defaults `wasmPaths` to a jsdelivr CDN when it detects a
  // browser bundle, and MV3 forbids loading remote code — so the runtime is
  // copied in and repointed at build time (see src/asr/model-loader.ts).
  // Without these, model loading fails at the first inference.
  const ortDist = resolve(root, "node_modules/onnxruntime-web/dist");
  // Only the single-threaded variants: the loader forces
  // `wasm.numThreads = 1` because threads need cross-origin isolation
  // (COOP/COEP), which extension pages do not have. Skipping the two
  // threaded builds keeps ~19 MB out of the package.
  const ortWasm = ["ort-wasm.wasm", "ort-wasm-simd.wasm"];
  if (existsSync(ortDist)) {
    mkdirSync(resolve(outDir, "asr"), { recursive: true });
    for (const file of ortWasm) {
      const from = resolve(ortDist, file);
      if (!existsSync(from)) {
        console.warn(`[build] ort wasm missing, skipped: ${file}`);
        continue;
      }
      copyFileSync(from, resolve(outDir, "asr", file));
    }
  } else {
    console.warn("[build] onnxruntime-web is not installed; ONNX WASM not bundled");
  }

  for (const [from, to] of staticFiles) {
    const src = resolve(root, from);
    const dest = resolve(outDir, to);
    if (!existsSync(src)) {
      console.warn(`[build] static file missing, skipped: ${from}`);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }

  const publicDir = resolve(root, "public");
  if (existsSync(publicDir)) {
    cpSync(publicDir, outDir, { recursive: true });
  }

  console.log("[build] done ->", outDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
