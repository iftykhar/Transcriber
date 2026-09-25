import { detectLang } from "./lang-detect";
import { ensure, type AsrPipeline } from "./model-loader";
import { makeId } from "../types/ids";
import type { Platform, TranscriptSegment } from "../types/transcript";
import { transliterateBanglish } from "./transliterate";

// Turning a block of 16 kHz mono PCM into a TranscriptSegment.

export interface TranscribeContext {
  /** Where the audio came from, stamped onto the segment. */
  platform: Platform;
  /** Wall-clock offset of the chunk's first sample, used as the segment timestamp. */
  timestampMs: number;
  /** Chunk the audio arrived in, for traceability. */
  sourceChunkId: string;
  /** Explicit language target to guide the model, or auto for auto-detect. */
  language: "auto" | "bn" | "en" | "banglish";
}

// Whisper's decoder is trained on subtitled video, so on silence/near-silence
// it happily emits stock captions. These are not speech and only pollute the
// transcript, so they are filtered before a segment is emitted.
const HALLUCINATIONS = [
  "thank you.",
  "thanks for watching!",
  "thanks for watching.",
  "thank you for watching.",
  "please subscribe.",
  "subscribe.",
  "you",
  "[music]",
  "[applause]",
  "[silence]",
  "[blank_audio]",
  "[beep]",
  "♪",
  "...",
  "।।",
];

function looksLikeHallucination(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return true;
  // Punctuation / musical symbols only.
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return HALLUCINATIONS.includes(t);
}

export interface TranscribeResult {
  segment: TranscriptSegment | null;
  /** Set when the audio produced no usable text. */
  skippedReason?: string;
}

/** Run the pipeline over one utterance. */
export async function transcribeSegment(
  samples: Float32Array,
  ctx: TranscribeContext
): Promise<TranscribeResult> {
  const pipe: AsrPipeline = await ensure();

  // Whisper needs at least a fraction of a second of audio to be meaningful;
  // feeding it a few milliseconds produces noise-shaped output.
  const minSamples = 16000 * 0.2;
  if (samples.length < minSamples) {
    return { segment: null, skippedReason: "audio too short" };
  }

  const started = Date.now();
  const options: Record<string, unknown> = {
    task: "transcribe",
    return_timestamps: false,
    // Greedy decoding: faster and less prone to hallucinated loops than
    // beam search for short clips.
    num_beams: 1,
  };

  if (ctx.language === "bn" || ctx.language === "banglish") {
    options.language = "bengali";
  } else if (ctx.language === "en") {
    options.language = "english";
  }

  const output = await pipe(samples, options);

  let text = (output?.text ?? "").trim();
  const durationMs = samples.length > 0 ? (samples.length / 16000) * 1000 : Date.now() - started;

  if (looksLikeHallucination(text)) {
    return { segment: null, skippedReason: text.length === 0 ? "empty output" : "filtered hallucination" };
  }

  const { lang, confidence } = detectLang(text, null);

  // Apply Banglish transliteration if requested
  if (ctx.language === "banglish" && lang === "bn") {
    text = transliterateBanglish(text);
  }

  return {
    segment: {
      id: makeId(),
      timestampMs: ctx.timestampMs,
      text,
      lang: ctx.language === "banglish" ? "bn" : lang,
      platform: ctx.platform,
      // There is no calibrated acoustic score from the pipeline, so the
      // script/hint agreement is used as an honest proxy rather than
      // inventing a number.
      confidence,
      durationMs,
      sourceChunkId: ctx.sourceChunkId,
      final: true,
    },
  };
}
