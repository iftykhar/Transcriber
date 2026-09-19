// Tests for the pure, side-effect-free parts of the pipeline.
//
// These modules are deliberately dependency-free (type-only imports at most),
// so they run directly under Node's TypeScript type stripping — no build step
// and no test framework dependency. `npm test`.
//
// The parts that genuinely cannot be tested here are the ones that need a real
// browser: tabCapture, the AudioWorklet scope, and ONNX inference.

import test from "node:test";
import assert from "node:assert/strict";

import { createResampler } from "../src/capture/resample.ts";
import { createEnergyVad, rms, DEFAULT_VAD_OPTIONS } from "../src/capture/vad.ts";
import { detectLang, normaliseWhisperLang } from "../src/asr/lang-detect.ts";
import { formatSrt, formatTxt, formatTranscript } from "../src/transcript/export.ts";
import type { TranscriptSegment } from "../src/types/transcript.ts";

const FRAME = DEFAULT_VAD_OPTIONS.frameSamples; // 2048 @ 16 kHz = 128 ms

function silenceFrames(count: number): Float32Array[] {
  return Array.from({ length: count }, () => new Float32Array(FRAME));
}

function toneFrames(count: number, amplitude = 0.5): Float32Array[] {
  return Array.from({ length: count }, () => {
    const frame = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      frame[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / 16000);
    }
    return frame;
  });
}

// --- resampler -----------------------------------------------------------

test("resampler converts 48 kHz to 16 kHz at the expected ratio", () => {
  const resampler = createResampler(48000, 16000);
  const input = new Float32Array(4800);
  for (let i = 0; i < input.length; i++) {
    input[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
  }

  const output = resampler.push(input);
  // 4800 in at 3:1 is 1600 out; one or two samples may still be pending
  // because interpolation needs a following sample.
  assert.ok(
    output.length >= 1596 && output.length <= 1600,
    `expected ~1600 samples, got ${output.length}`
  );
});

test("resampler is stateful across pushes", () => {
  const resampler = createResampler(48000, 16000);
  let total = 0;
  for (let i = 0; i < 10; i++) {
    total += resampler.push(new Float32Array(480)).length;
  }
  assert.ok(total >= 1596 && total <= 1600, `expected ~1600 across pushes, got ${total}`);
});

test("resampler rejects invalid rates", () => {
  assert.throws(() => createResampler(0, 16000), RangeError);
  assert.throws(() => createResampler(48000, -1), RangeError);
});

// --- VAD -----------------------------------------------------------------

test("rms distinguishes silence from a tone", () => {
  assert.equal(rms(new Float32Array(FRAME)), 0);
  assert.ok(rms(toneFrames(1)[0]!) > DEFAULT_VAD_OPTIONS.speechThreshold);
});

test("VAD emits exactly one segment for speech between silences", () => {
  const vad = createEnergyVad();
  const frameMs = (FRAME / 16000) * 1000;
  const segments: ReturnType<typeof vad.flush> = [];

  const frames = [...silenceFrames(5), ...toneFrames(10), ...silenceFrames(20)];
  frames.forEach((frame, i) => {
    segments.push(...vad.push(frame, i * frameMs));
  });

  assert.equal(segments.length, 1, "expected a single utterance");

  const segment = segments[0]!;
  // Pre-roll means the segment starts a few frames *before* the trigger.
  assert.ok(segment.startMs > 0, "segment should not start at t=0");
  assert.ok(
    segment.startMs <= 4 * frameMs,
    `segment start ${segment.startMs} should be within the pre-roll window`
  );
  // All ten tone frames, plus pre-roll and trailing silence.
  assert.ok(
    segment.samples.length >= 10 * FRAME,
    `expected at least ${10 * FRAME} samples, got ${segment.samples.length}`
  );
});

test("VAD discards blips shorter than minSegmentMs", () => {
  const vad = createEnergyVad({ minSegmentMs: 2000 });
  const frameMs = (FRAME / 16000) * 1000;
  const segments = [...toneFrames(3), ...silenceFrames(20)].flatMap((frame, i) =>
    vad.push(frame, i * frameMs)
  );
  assert.equal(segments.length, 0, "a 384 ms blip should not become a transcript");
});

test("VAD splits a very long utterance on maxSegmentMs", () => {
  const vad = createEnergyVad({ maxSegmentMs: 1000 });
  const frameMs = (FRAME / 16000) * 1000;
  // ~5 s of continuous speech at a 1 s cap should yield several segments.
  const segments = toneFrames(40).flatMap((frame, i) => vad.push(frame, i * frameMs));
  assert.ok(segments.length >= 3, `expected several forced splits, got ${segments.length}`);
});

test("VAD flush returns an in-flight utterance", () => {
  const vad = createEnergyVad();
  const frameMs = (FRAME / 16000) * 1000;
  toneFrames(10).forEach((frame, i) => vad.push(frame, i * frameMs));
  const flushed = vad.flush();
  assert.equal(flushed.length, 1, "stopping mid-sentence should still transcribe it");
});

test("VAD reset clears in-flight state", () => {
  const vad = createEnergyVad();
  toneFrames(10).forEach((frame, i) => vad.push(frame, i * 128));
  vad.reset();
  assert.equal(vad.flush().length, 0);
});

// --- language detection --------------------------------------------------

test("normaliseWhisperLang maps model language names", () => {
  assert.equal(normaliseWhisperLang("Bengali"), "bn");
  assert.equal(normaliseWhisperLang("bn"), "bn");
  assert.equal(normaliseWhisperLang("english"), "en");
  assert.equal(normaliseWhisperLang("fr"), "unknown");
  assert.equal(normaliseWhisperLang(null), "unknown");
});

test("detectLang identifies Bengali and English from script", () => {
  const bn = detectLang("আমি ভালো আছি");
  assert.equal(bn.lang, "bn");
  assert.equal(bn.confidence, 1);

  const en = detectLang("hello there, how are you");
  assert.equal(en.lang, "en");
  assert.equal(en.confidence, 1);
});

test("detectLang handles code-switched text with reduced confidence", () => {
  const mixed = detectLang("the API কল দিও");
  assert.ok(mixed.lang === "bn" || mixed.lang === "en");
  assert.ok(mixed.confidence > 0.4 && mixed.confidence < 1, `confidence was ${mixed.confidence}`);
});

test("detectLang falls back to the Whisper hint when there is no text", () => {
  const result = detectLang("", "bengali");
  assert.equal(result.lang, "bn");
  assert.equal(result.confidence, 0.3);

  const none = detectLang("", null);
  assert.equal(none.lang, "unknown");
});

test("detectLang treats digits only as low-confidence", () => {
  const digits = detectLang("12345");
  assert.equal(digits.lang, "unknown");
  assert.ok(digits.confidence < 0.5);
});

// --- export --------------------------------------------------------------

const SEGMENTS: TranscriptSegment[] = [
  {
    id: "a",
    timestampMs: 1500,
    text: "hello there",
    lang: "en",
    platform: "meet",
    confidence: 1,
    durationMs: 1500,
  },
  {
    id: "b",
    timestampMs: 3200,
    text: "ভালো আছি",
    lang: "bn",
    platform: "meet",
    confidence: 1,
    durationMs: 800,
  },
];

test("txt export prefixes each line with a clock", () => {
  const txt = formatTxt(SEGMENTS);
  assert.match(txt, /\[00:00:01\] hello there/);
  assert.match(txt, /\[00:00:03\] ভালো আছি/);
});

test("srt export numbers cues and uses comma milliseconds", () => {
  const srt = formatSrt(SEGMENTS);
  assert.match(srt, /^1\n00:00:01,500 --> 00:00:03,000\nhello there\n/);
  assert.match(srt, /^2\n00:00:03,200 --> 00:00:04,000\nভালো আছি\n/m);
});

test("srt derives an end time from the next segment when duration is absent", () => {
  const srt = formatSrt([
    { id: "a", timestampMs: 0, text: "first", lang: "en", platform: "meet", confidence: 1 },
    { id: "b", timestampMs: 4000, text: "second", lang: "en", platform: "meet", confidence: 1 },
  ]);
  assert.match(srt, /00:00:00,000 --> 00:00:04,000/);
});

test("json export round-trips segments", () => {
  const parsed = JSON.parse(formatTranscript(SEGMENTS, "json")) as {
    segmentCount: number;
    segments: TranscriptSegment[];
  };
  assert.equal(parsed.segmentCount, 2);
  assert.equal(parsed.segments[1]?.text, "ভালো আছি");
});

test("exporting an empty transcript is safe", () => {
  assert.equal(formatTxt([]), "");
  assert.equal(formatSrt([]), "");
  assert.equal(JSON.parse(formatTranscript([], "json")).segmentCount, 0);
});
