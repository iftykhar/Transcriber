// Transcription accuracy measurement.
//
// Runs real, human-recorded speech — with known reference transcripts — through
// the *actual* built ASR bundle (asr/whisper-worker.js) inside Edge, then
// scores the output.
//
// Speak audio is fetched by the extension page itself (it has host permissions
// for *.huggingface.co) and decoded with the browser's own WebAudio decoder, so
// no audio codec has to be reimplemented here.
//
// Run with: npm run build && node scripts/accuracy.mjs
//
// Metrics:
//   CER  character error rate — the standard measure for Bengali, where
//        word-boundary tokenisation is less reliable. Computed on text with
//        punctuation and whitespace removed.
//   WER  word error rate — the standard measure for English.
//   Dropped  utterances the product's hallucination filter discarded. A high
//        number here means the filter is eating real speech, which is a
//        product bug rather than a model weakness.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DIST = resolve("dist");
const PROFILE = resolve(".accuracy-profile");
const PORT = 9334;

/** Samples per speech set. Override with SAMPLES=<n>. */
const SAMPLES = Number(process.env.SAMPLES ?? 8);
/** Whisper's receptive field; longer clips would be silently truncated. */
const MAX_SECONDS = 30;

const SETS = [
  {
    name: "bn-codemixed",
    dataset: "fayez94/code-mixed-bangla-english-asr",
    config: "default",
    split: "train",
    textField: "transcription",
    expectLang: "bn",
  },
  {
    name: "bn-pure",
    dataset: "shunyalabs/bengali-speech-dataset",
    config: "default",
    split: "train",
    textField: "transcript",
    expectLang: "bn",
  },
  {
    name: "en",
    dataset: "hf-internal-testing/librispeech_asr_dummy",
    config: "clean",
    split: "validation",
    textField: "text",
    expectLang: "en",
  },
];

// --- text metrics ---------------------------------------------------------

const PUNCT = /[\p{P}\p{S}]/gu;

function normaliseWords(text) {
  return text
    .toLowerCase()
    .replace(PUNCT, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Strip punctuation and whitespace: CER for Bengali is computed on this. */
function normaliseChars(text) {
  return text.replace(PUNCT, "").replace(/\s+/g, "");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function cer(ref, hyp) {
  const r = normaliseChars(ref);
  const h = normaliseChars(hyp);
  if (r.length === 0) return null;
  return levenshtein(r, h) / r.length;
}

function wer(ref, hyp) {
  const r = normaliseWords(ref);
  const h = normaliseWords(hyp);
  if (r.length === 0) return null;
  return levenshtein(r, h) / r.length;
}

function stats(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return {
    n: nums.length,
    mean: Math.round(mean * 1000) / 1000,
    median: Math.round(sorted[Math.floor(sorted.length / 2)] * 1000) / 1000,
    best: Math.round(sorted[0] * 1000) / 1000,
    worst: Math.round(sorted[sorted.length - 1] * 1000) / 1000,
  };
}

// --- CDP plumbing ---------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;

function cleanup() {
  try {
    child?.kill();
  } catch {}
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {}
}

async function jsonHttp(path, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  try {
    return JSON.parse(await res.text());
  } catch {
    return {};
  }
}

function extensionIdForPath(absPath) {
  const hex = createHash("sha256").update(absPath, "utf8").digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function extensionIdFromProfile() {
  for (const name of ["Default/Preferences", "Default/Secure Preferences"]) {
    const file = resolve(PROFILE, name);
    if (!existsSync(file)) continue;
    try {
      const settings = JSON.parse(readFileSync(file, "utf8"))?.extensions?.settings ?? {};
      for (const [id, value] of Object.entries(settings)) {
        if (value && typeof value.path === "string" && value.path.endsWith("dist")) return id;
      }
    } catch {}
  }
  return null;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("CDP socket error")), { once: true });
  });
  return {
    send: (method, params = {}) =>
      new Promise((res) => {
        const id = ++nextId;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function evaluate(client, expression, timeoutMs) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  const r = result.result ?? {};
  if (r.exceptionDetails) {
    throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  }
  const value = r.result?.value;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

// --- dataset access -------------------------------------------------------

async function fetchRows(set) {
  const url =
    `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(set.dataset)}` +
    `&config=${encodeURIComponent(set.config)}&split=${encodeURIComponent(set.split)}` +
    `&offset=0&length=${SAMPLES}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`rows fetch failed: ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`rows error: ${json.error}`);

  return (json.rows ?? []).map((r, i) => {
    const audio = Object.values(r.row).find((v) => Array.isArray(v) && v[0]?.src)?.[0];
    return {
      index: i,
      url: audio?.src,
      reference: String(r.row[set.textField] ?? "").trim(),
    };
  });
}

// --- in-page transcription ------------------------------------------------

const LOAD_MODEL = `(async () => {
  const log = [];
  const w = new Worker(chrome.runtime.getURL('asr/whisper-worker.js'));
  w.onmessage = (e) => log.push(e.data);
  w.onerror = (e) => log.push({ type: 'ModelError', message: String(e.message || 'worker error') });
  window.__log = log;
  window.__w = w;
  const t0 = performance.now();
  w.postMessage({ type: 'LoadModel' });
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (log.some(m => m.type === 'ModelReady' || m.type === 'ModelError')) break;
    await new Promise(r => setTimeout(r, 300));
  }
  return JSON.stringify({
    ready: log.some(m => m.type === 'ModelReady'),
    loadMs: Math.round(performance.now() - t0),
    error: log.find(m => m.type === 'ModelError')?.message ?? null,
  });
})()`;

function transcribeExpr(url, chunkId) {
  return `(async () => {
  const url = ${JSON.stringify(url)};
  const chunkId = ${JSON.stringify(chunkId)};
  const t0 = performance.now();
  try {
    const res = await fetch(url);
    if (!res.ok) return JSON.stringify({ chunkId, error: 'fetch ' + res.status });

    // Decoding into a 16 kHz context resamples for us, so the samples handed to
    // Whisper are exactly the rate it expects.
    const probe = new OfflineAudioContext(1, 1, 16000);
    const decoded = await probe.decodeAudioData(await res.arrayBuffer());
    const samples = new Float32Array(decoded.getChannelData(0));

    const before = window.__log.length;
    window.__w.postMessage(
      { type: 'TranscribeChunk', chunk: { type: 'AudioChunk', chunkId, timestampMs: 0, samples } },
      [samples.buffer]
    );

    const deadline = Date.now() + 150000;
    let hit = null;
    while (Date.now() < deadline) {
      hit = window.__log.slice(before).find(m =>
        (m.type === 'TranscriptChunk' && m.segment && m.segment.sourceChunkId === chunkId) ||
        (m.type === 'TranscriptError' && m.chunkId === chunkId)
      );
      if (hit) break;
      await new Promise(r => setTimeout(r, 150));
    }

    return JSON.stringify({
      chunkId,
      durationSec: Math.round(decoded.duration * 100) / 100,
      sampleRate: decoded.sampleRate,
      elapsedMs: Math.round(performance.now() - t0),
      text: hit && hit.type === 'TranscriptChunk' ? hit.segment.text : null,
      lang: hit && hit.type === 'TranscriptChunk' ? hit.segment.lang : null,
      dropped: hit && hit.type === 'TranscriptError' ? hit.message : null,
      timedOut: !hit,
    });
  } catch (e) {
    return JSON.stringify({ chunkId, error: String(e && e.message || e) });
  }
})()`;
}

// --- main -----------------------------------------------------------------

async function main() {
  const report = { config: { samplesPerSet: SAMPLES, maxSeconds: MAX_SECONDS }, sets: {}, overall: {} };

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
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] }
  );

  let list = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const l = await jsonHttp("/json/list");
    if (Array.isArray(l) && l.length) {
      list = l;
      break;
    }
  }

  let id = list.find((t) => t.url?.includes("service-worker.js"))?.url.split("/")[2] ?? null;
  if (!id) {
    for (let i = 0; i < 20 && !id; i++) {
      id = extensionIdFromProfile();
      if (!id) await sleep(500);
    }
  }
  id ??= extensionIdForPath(DIST);
  report.extensionId = id;

  const targetUrl = `chrome-extension://${id}/offscreen/offscreen.html`;
  let created = await jsonHttp(`/json/new?${encodeURIComponent(targetUrl)}`, "PUT");
  created = created?.webSocketDebuggerUrl ? created : await jsonHttp(`/json/new?${encodeURIComponent(targetUrl)}`, "GET");
  if (!created?.webSocketDebuggerUrl) throw new Error("could not open offscreen page");

  const client = await connect(created.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await sleep(1500);

  console.error("[accuracy] loading whisper-base (first run downloads ~76 MB)…");
  const load = await evaluate(client, LOAD_MODEL, 300000);
  report.model = load;
  console.error(`[accuracy] model ready=${load.ready} in ${load.loadMs} ms`);
  if (!load.ready) throw new Error(`model failed to load: ${load.error}`);

  const allCer = [];
  const allWer = [];
  let langAgree = 0;
  let langTotal = 0;
  let dropped = 0;
  let scored = 0;
  let exact = 0;

  for (const set of SETS) {
    const rows = await fetchRows(set);
    const detail = [];
    const cers = [];
    const wers = [];

    for (const row of rows) {
      if (!row.url) continue;
      const chunkId = `${set.name}-${row.index}`;
      const result = await evaluate(client, transcribeExpr(row.url, chunkId), 200000);

      const entry = {
        chunkId,
        reference: row.reference.slice(0, 140),
        hypothesis: (result.text ?? "").slice(0, 140),
        durationSec: result.durationSec,
        elapsedMs: result.elapsedMs,
        predictedLang: result.lang,
        dropped: result.dropped ?? null,
        error: result.error ?? null,
        timedOut: result.timedOut ?? false,
      };

      if (entry.dropped) dropped++;
      if (result.text) {
        const c = cer(row.reference, result.text);
        const w = wer(row.reference, result.text);
        if (c !== null) {
          cers.push(c);
          allCer.push(c);
        }
        if (w !== null) {
          wers.push(w);
          allWer.push(w);
        }
        scored++;
        if (normaliseChars(result.text) === normaliseChars(row.reference)) exact++;

        langTotal++;
        if (result.lang === set.expectLang) langAgree++;
        entry.cer = c === null ? null : Math.round(c * 1000) / 1000;
        entry.wer = w === null ? null : Math.round(w * 1000) / 1000;
      }

      detail.push(entry);
      console.error(
        `[accuracy] ${chunkId} ${result.durationSec ?? "?"}s ` +
          (entry.dropped ? `DROPPED(${entry.dropped})` : `cer=${entry.cer ?? "-"} wer=${entry.wer ?? "-"} lang=${result.lang}`)
      );
    }

    report.sets[set.name] = {
      dataset: `${set.dataset} (${set.config}/${set.split})`,
      samples: rows.length,
      scored: cers.length,
      cer: stats(cers),
      wer: stats(wers),
      detail,
    };
    console.error(`[accuracy] ${set.name}: scored ${cers.length}/${rows.length}`);
  }

  report.overall = {
    samplesScored: scored,
    droppedByHallucinationFilter: dropped,
    exactMatches: exact,
    exactMatchRate: scored ? Math.round((exact / scored) * 1000) / 1000 : null,
    cer: stats(allCer),
    wer: stats(allWer),
    languageDetectionAgreement: langTotal ? Math.round((langAgree / langTotal) * 1000) / 1000 : null,
  };

  client.close();
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => {
    console.log(JSON.stringify({ fatal: String(err?.stack ?? err) }, null, 2));
    process.exitCode = 1;
  })
  .finally(cleanup);
