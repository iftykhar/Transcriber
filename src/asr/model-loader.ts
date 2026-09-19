import { env, pipeline } from "@xenova/transformers";
import { createIndexedDbCache, type ModelCache } from "./idb-cache";

// Lazy, cached Whisper pipeline.
//
// Two MV3-specific hazards this file exists to defuse:
//
// 1. transformers.js points ONNX Runtime's WASM files at a jsdelivr CDN when
//    it detects a browser bundle. MV3 forbids loading remote code, so that
//    fetch would fail (and violates policy). We repoint it at the WASM we
//    copy into `asr/` at build time.
//
// 2. Its default cache is the Cache API. We want durable storage, so we swap
//    in the IndexedDB cache and disable the built-in one.
//
// Everything is lazy: no bytes move until `ensure()` is called, which only
// happens after the user starts a capture.

export const MODEL_ID = "Xenova/whisper-base";

export type LoadState = "idle" | "loading" | "ready" | "error";

export interface LoadProgress {
  /** 0..1 across all files. */
  progress: number;
  /** Whatever transformers reported, for display. */
  detail?: string;
}

/** Minimal shape of the ASR pipeline we actually call. */
export type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>
) => Promise<{ text?: string }>;

let configured = false;
let state: LoadState = "idle";
let pipelinePromise: Promise<AsrPipeline> | null = null;
let cache: ModelCache | null = null;
let lastError: string | null = null;

function wasmBaseUrl(): string {
  // NOTE: a dedicated Worker created by an extension page does NOT get the
  // `chrome.*` API — `chrome.runtime.getURL` throws "chrome is not defined"
  // here (verified against a live Edge run). Derive the extension-scoped
  // directory from this script's own URL instead: this file is served as
  // chrome-extension://<id>/asr/whisper-worker.js, so its directory IS the
  // place the build copies ort-*.wasm into.
  return new URL("./", self.location.href).href;
}

function configure(): void {
  if (configured) return;
  configured = true;

  // We ship no local model copy, so skip the pointless extension-origin
  // lookup (which 404s loudly) and go straight to the Hub.
  env.allowLocalModels = false;
  env.allowRemoteModels = true;

  // Swap the Cache API for durable IndexedDB storage.
  env.useBrowserCache = false;
  env.useCustomCache = true;
  cache = createIndexedDbCache();
  env.customCache = cache as unknown as typeof env.customCache;

  // Point ONNX Runtime at bundled WASM instead of the CDN.
  const onnx = env.backends?.onnx as unknown as { wasm?: Record<string, unknown> } | undefined;
  if (onnx?.wasm) {
    onnx.wasm.wasmPaths = wasmBaseUrl();
    // Threads need cross-origin isolation (COOP/COEP), which an extension
    // page does not have, so force single-threaded to avoid a failed
    // SharedArrayBuffer allocation.
    onnx.wasm.numThreads = 1;
    onnx.wasm.proxy = false;
  }
}

/**
 * Progress aggregation over the model files.
 *
 * transformers reports per-file byte counts with no up-front manifest, so
 * aggregating by *file count* is badly misleading: config.json finishes
 * instantly, which would report 100% while the 30 MB weight file has not
 * started. Bytes are the only honest unit, so we sum loaded/total across the
 * files seen so far and refuse to claim near-completion until a real weight
 * file (not a config) is in flight. The true 100% is reported by `ensure()`
 * resolving, not by this function.
 */
function createProgressAggregator(report: (p: LoadProgress) => void) {
  interface FileProgress {
    loaded: number;
    total: number;
    fraction: number;
  }

  const files = new Map<string, FileProgress>();
  let lastReport = 0;
  let sawWeights = false;

  return (event: {
    status?: string;
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
    name?: string;
  }) => {
    const file = event.file ?? event.name ?? "model";
    const entry: FileProgress = files.get(file) ?? { loaded: 0, total: 0, fraction: 0 };

    if (event.status === "done") {
      entry.fraction = 1;
      if (entry.total > 0) entry.loaded = entry.total;
    } else if (typeof event.progress === "number") {
      // transformers reports 0..100 here, not 0..1.
      entry.fraction = Math.max(entry.fraction, Math.min(1, event.progress / 100));
    }
    if (typeof event.loaded === "number") entry.loaded = event.loaded;
    if (typeof event.total === "number") entry.total = event.total;
    files.set(file, entry);

    // Configs, tokenizers and preprocessor settings are kilobytes; weights are
    // tens of megabytes. Only the latter justify a large percentage.
    if (entry.total > 1_000_000) sawWeights = true;

    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }

    let progress = total > 0 ? loaded / total : 0;
    progress = sawWeights ? Math.min(progress, 0.99) : Math.min(progress, 0.05);

    // Throttle: these fire very often while streaming weights.
    const now = Date.now();
    if (now - lastReport > 150) {
      lastReport = now;
      report({ progress, detail: file });
    }
  };
}

export function getLoadState(): LoadState {
  return state;
}

export function getLastError(): string | null {
  return lastError;
}

/**
 * Resolve the shared pipeline, loading it if necessary. Concurrent callers
 * share one load.
 */
export function ensure(onProgress?: (p: LoadProgress) => void): Promise<AsrPipeline> {
  configure();

  if (pipelinePromise) {
    return pipelinePromise;
  }

  state = "loading";
  lastError = null;

  const report = onProgress ? createProgressAggregator(onProgress) : undefined;

  pipelinePromise = pipeline("automatic-speech-recognition", MODEL_ID, {
    // Quantised weights: ~4x smaller download and much faster on CPU, with
    // negligible accuracy loss for 16 kHz speech.
    quantized: true,
    ...(report ? { progress_callback: report } : {}),
  })
    .then((pipe) => {
      state = "ready";
      return pipe as unknown as AsrPipeline;
    })
    .catch((err: unknown) => {
      state = "error";
      lastError = err instanceof Error ? err.message : String(err);
      // Allow a later retry rather than caching the rejection forever.
      pipelinePromise = null;
      throw err;
    });

  return pipelinePromise;
}

/** Bytes currently held in the durable model cache. */
export async function cachedBytes(): Promise<number> {
  configure();
  return cache ? cache.usedBytes() : 0;
}
