// Temporary live-test harness. Drives a real Edge instance over the DevTools
// protocol against the built extension, to actually execute the parts of the
// pipeline that unit tests cannot reach:
//
//   A. boot the Whisper worker bundle (transformers.js + ONNX Runtime)
//   B. download whisper-base, persist it, and run real inference
//   C. load the AudioWorklet bundle and confirm it emits 16 kHz frames
//
// Also records CSP violations, which is the definitive answer to whether the
// bundled ONNX runtime's `eval` fallback is survivable under MV3.

// Run with: node scripts/live-test.mjs
//
// Requires a built extension (`npm run build`) and Microsoft Edge at the path
// below. Uses a throwaway profile under .live-test-profile/ (gitignored).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DIST = resolve("dist");
const PROFILE = resolve(".live-test-profile");
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;

function cleanup() {
  try {
    child?.kill();
  } catch {}
  // KEEP_PROFILE=1 lets a second run reuse the model already cached in
  // IndexedDB, which is how we prove persistence actually works.
  if (process.env.KEEP_PROFILE) {
    console.error("[harness] keeping profile");
    return;
  }
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {}
}

async function jsonHttp(path, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * An unpacked extension's id is the first 32 hex chars of sha256(absolute
 * path), with each hex digit mapped 0-f -> a-p.
 */
function extensionIdForPath(absPath) {
  const hex = createHash("sha256").update(absPath, "utf8").digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/** The id Edge actually assigned, read back from the profile it just wrote. */
function extensionIdFromProfile() {
  for (const name of ["Default/Preferences", "Default/Secure Preferences"]) {
    const file = resolve(PROFILE, name);
    if (!existsSync(file)) continue;
    try {
      const settings = JSON.parse(readFileSync(file, "utf8"))?.extensions?.settings ?? {};
      for (const [id, value] of Object.entries(settings)) {
        if (value && typeof value.path === "string" && value.path.endsWith("dist")) return id;
      }
    } catch {
      // Preferences can be mid-write; try again on the next poll.
    }
  }
  return null;
}

/** Minimal CDP client over Node's global WebSocket. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("CDP socket error")), { once: true });
  });

  return {
    events,
    send(method, params = {}) {
      return new Promise((res) => {
        const id = ++nextId;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

/** Run an expression in the page and await its result, with a hard timeout. */
async function evaluate(client, expression, timeoutMs) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  if (result.error) throw new Error(`CDP error: ${JSON.stringify(result.error)}`);
  const r = result.result ?? {};
  if (r.exceptionDetails) {
    throw new Error(`Page exception: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)}`);
  }
  if (r.result?.value === undefined) {
    return { raw: r.result ?? null };
  }
  try {
    return JSON.parse(r.result.value);
  } catch {
    return { raw: r.result.value };
  }
}

// --- Phase A: worker boot + model download --------------------------------

const MODEL_SCRIPT = `(async () => {
  const log = [];
  const errors = [];
  const worker = new Worker(chrome.runtime.getURL('asr/whisper-worker.js'));
  worker.onmessage = (e) => log.push(e.data);
  worker.onerror = (e) => errors.push(String(e.message || 'worker error'));

  const t0 = performance.now();
  worker.postMessage({ type: 'LoadModel' });

  const deadline = Date.now() + ${240000};
  while (Date.now() < deadline) {
    if (log.some(m => m.type === 'ModelReady' || m.type === 'ModelError')) break;
    await new Promise(r => setTimeout(r, 400));
  }

  window.__w = worker;
  window.__log = log;
  const events = log.filter(m => m.type === 'ModelProgress');
  const progress = events.map(m => Math.round(m.progress * 100));
  const ready = log.some(m => m.type === 'ModelReady');
  const modelError = log.find(m => m.type === 'ModelError');
  return JSON.stringify({
    ready,
    elapsedMs: Math.round(performance.now() - t0),
    progressEventCount: progress.length,
    progressFirst12: progress.slice(0, 12),
    progressMin: progress.length ? Math.min(...progress) : null,
    progressLast: progress.slice(-3),
    distinctDetails: [...new Set(events.map(m => m.detail).filter(Boolean))].slice(0, 10),
    modelError: modelError ? modelError.message : null,
    workerErrors: errors,
    sawModelLoading: log.some(m => m.type === 'ModelLoading'),
  });
})()`;

// --- Phase B: real inference ---------------------------------------------

const INFER_SCRIPT = `(async () => {
  const worker = window.__w;
  const before = window.__log.length;

  // 6 s of 16 kHz "speech": amplitude-modulated tone (not intelligible, but it
  // exercises the full ONNX encode/decode path and returns real model output).
  const seconds = 6, rate = 16000, n = seconds * rate;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
    samples[i] = 0.35 * env * Math.sin(2 * Math.PI * 140 * t);
  }

  worker.postMessage(
    { type: 'TranscribeChunk', chunk: { type: 'AudioChunk', chunkId: 'live1', timestampMs: 1000, samples } },
    [samples.buffer]
  );

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const fresh = window.__log.slice(before);
    if (fresh.some(m => m.type === 'TranscriptChunk' || m.type === 'TranscriptError')) break;
    await new Promise(r => setTimeout(r, 400));
  }

  const fresh = window.__log.slice(before);
  const chunk = fresh.find(m => m.type === 'TranscriptChunk');
  const err = fresh.find(m => m.type === 'TranscriptError');
  return JSON.stringify({
    gotTranscript: Boolean(chunk),
    text: chunk ? chunk.segment.text : null,
    lang: chunk ? chunk.segment.lang : null,
    segmentId: chunk ? chunk.segment.id : null,
    durationMs: chunk ? Math.round(chunk.segment.durationMs) : null,
    transcriptError: err ? err.message : null,
  });
})()`;

// --- Phase C: AudioWorklet ------------------------------------------------

const WORKLET_SCRIPT = `(async () => {
  const ctx = new OfflineAudioContext(1, 48000, 48000);
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('capture/audio-worklet.js'));

  const osc = ctx.createOscillator();
  osc.frequency.value = 200;
  const node = new AudioWorkletNode(ctx, 'pcm-forwarder');

  const frames = [];
  node.port.onmessage = (e) => frames.push({ chunkId: e.data.chunkId, timestampMs: e.data.timestampMs, length: e.data.samples.length });
  node.port.onmessageerror = () => frames.push({ error: true });

  osc.connect(node);
  node.connect(ctx.destination);
  osc.start();
  await ctx.startRendering();
  osc.stop();

  await new Promise(r => setTimeout(r, 600));

  const lengths = [...new Set(frames.map(f => f.length))];
  return JSON.stringify({
    frameCount: frames.length,
    allFrameLengths: lengths,
    firstTimestamp: frames[0]?.timestampMs ?? null,
    lastTimestamp: frames[frames.length - 1]?.timestampMs ?? null,
    // 1 s at 48 kHz resampled to 16 kHz = 16000 samples = 7.8 frames of 2048.
    expectedApprox: 7,
  });
})()`;

// --- Phase E: warm-cache reload -------------------------------------------
// The first load only proves the cache *write* path. Loading a second worker
// in the same session proves the *read* path (our match/put contract), which
// is the part that makes "persisted for next time" actually true.

const RELOAD_SCRIPT = `(async () => {
  const t0 = performance.now();
  const log = [];
  const w = new Worker(chrome.runtime.getURL('asr/whisper-worker.js'));
  w.onmessage = (e) => log.push(e.data);
  w.onerror = (e) => log.push({ type: 'ModelError', message: String(e.message || 'worker error') });
  w.postMessage({ type: 'LoadModel' });

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (log.some(m => m.type === 'ModelReady' || m.type === 'ModelError')) break;
    await new Promise(r => setTimeout(r, 200));
  }

  const onnxEvents = log.filter(m => m.type === 'ModelProgress' && String(m.detail || '').includes('onnx'));
  return JSON.stringify({
    ready: log.some(m => m.type === 'ModelReady'),
    elapsedMs: Math.round(performance.now() - t0),
    onnxDownloadEvents: onnxEvents.length,
    modelError: log.find(m => m.type === 'ModelError')?.message ?? null,
  });
})()`;

// --- Phase D: IndexedDB persistence --------------------------------------

const CACHE_SCRIPT = `(async () => {
  const open = indexedDB.open('bn-en-asr-model-cache');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
  if (!db.objectStoreNames.contains('files')) return JSON.stringify({ storeExists: false, files: [] });
  const tx = db.transaction('files', 'readonly');
  const all = await new Promise((res, rej) => { const r = tx.objectStore('files').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return JSON.stringify({
    storeExists: true,
    fileCount: all.length,
    totalMB: Math.round(all.reduce((s, f) => s + (f.body?.byteLength ?? 0), 0) / 1048576 * 10) / 10,
    keys: all.map(f => String(f.key).split('/').slice(-1)[0]).slice(0, 12),
  });
})()`;

// --- Driver ---------------------------------------------------------------

async function main() {
  const report = { phases: {}, csp: [], consoleErrors: [] };

  child = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${DIST}`,
      `--remote-debugging-port=${PORT}`,
      "--enable-logging=stderr",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));

  // Wait for the DevTools endpoint.
  let list = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      list = await jsonHttp("/json/list");
      if (Array.isArray(list)) break;
    } catch {}
  }
  if (!Array.isArray(list)) throw new Error("DevTools endpoint never came up");

  // The MV3 service worker is lazy, so it may not be a CDP target at all.
  let extensionId = null;
  const swTarget = list.find((t) => typeof t.url === "string" && t.url.includes("service-worker.js"));
  if (swTarget) extensionId = swTarget.url.split("/")[2];

  if (!extensionId) {
    for (let i = 0; i < 20 && !extensionId; i++) {
      extensionId = extensionIdFromProfile();
      if (!extensionId) await sleep(500);
    }
  }
  if (!extensionId) extensionId = extensionIdForPath(DIST);
  report.extensionId = extensionId;
  report.idSource = swTarget ? "target" : extensionIdFromProfile() === extensionId ? "profile" : "computed";

  const targetUrl = `chrome-extension://${extensionId}/offscreen/offscreen.html`;
  let created = await jsonHttp(`/json/new?${encodeURIComponent(targetUrl)}`, "PUT");
  if (!created?.webSocketDebuggerUrl) {
    created = await jsonHttp(`/json/new?${encodeURIComponent(targetUrl)}`, "GET");
  }
  if (!created?.webSocketDebuggerUrl) throw new Error(`could not open offscreen page: ${JSON.stringify(created)}`);

  const client = await connect(created.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Log.enable");

  // Wait for the page's own script to run.
  await sleep(1500);

  // Guard: the evaluated context must really be the extension page, or every
  // chrome.* call below fails confusingly.
  const ctx = await evaluate(client, "JSON.stringify({ url: location.href, hasChrome: typeof chrome !== 'undefined', hasRuntime: typeof chrome !== 'undefined' && !!chrome.runtime })", 15000);
  report.context = ctx;
  if (!ctx.hasRuntime) throw new Error(`not an extension context: ${JSON.stringify(ctx)}`);

  report.phases.workerAndModel = await evaluate(client, MODEL_SCRIPT, 300000);

  if (report.phases.workerAndModel.ready) {
    report.phases.inference = await evaluate(client, INFER_SCRIPT, 220000);
    report.phases.cache = await evaluate(client, CACHE_SCRIPT, 20000);
    report.phases.warmReload = await evaluate(client, RELOAD_SCRIPT, 200000);
  }

  report.phases.audioWorklet = await evaluate(client, WORKLET_SCRIPT, 60000);

  for (const ev of client.events) {
    if (ev.method === "Log.entryAdded") {
      const e = ev.params.entry;
      const text = `${e.level}: ${e.text}`;
      if (/content security policy|csp|refused to|wasm|eval/i.test(text)) report.csp.push(text);
      else if (e.level === "error") report.consoleErrors.push(text);
    }
    if (ev.method === "Runtime.exceptionThrown") {
      report.consoleErrors.push(
        String(ev.params.exceptionDetails?.exception?.description ?? ev.params.exceptionDetails?.text ?? "").slice(0, 300)
      );
    }
  }

  client.close();

  // Browser-level stderr is where CSP violations are most reliably reported.
  const allStderr = stderr.join("");
  report.browserCsp = allStderr
    .split(/\r?\n/)
    .filter((l) => /content security policy|refused to (evaluate|compile|execute)|wasm-unsafe-eval/i.test(l))
    .slice(0, 10);

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => {
    console.log(JSON.stringify({ fatal: String(err?.stack ?? err) }, null, 2));
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
