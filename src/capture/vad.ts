// Energy-based voice activity detection.
//
// Fixed-size frames come in from the AudioWorklet; this groups them into
// *utterances* so Whisper is asked to transcribe whole phrases instead of
// arbitrary time slices. Silence closes a segment; a hard cap keeps a
// segment from growing without bound (Whisper's window is 30s and long
// inputs get slow and lossy).
//
// A short pre-roll is kept before the trigger frame so the onset of a word
// is not clipped, and the trailing silence is left in place because
// removing it tends to hurt Whisper's punctuation.
//
// Kept dependency-free (no imports) on purpose: pure logic, directly
// testable via Node's type stripping.

export interface VadOptions {
  /** Sample rate of the incoming frames (always 16 kHz in this pipeline). */
  sampleRate: number;
  /** Samples per frame. */
  frameSamples: number;
  /** RMS amplitude above which a frame counts as speech. */
  speechThreshold: number;
  /** Consecutive speech frames required before a segment is opened (debounce). */
  startFrames: number;
  /** Trailing silence that closes a segment. */
  endSilenceMs: number;
  /** Segments shorter than this are discarded as noise. */
  minSegmentMs: number;
  /** Force-close a segment once it reaches this length. */
  maxSegmentMs: number;
  /** Frames of pre-roll retained before the trigger frame. */
  preRollFrames: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  sampleRate: 16000,
  // 2048 samples @16k = 128 ms, a comfortable granularity for energy gating.
  frameSamples: 2048,
  // Deliberately low: meeting audio is often quiet and this gate is meant to
  // separate "someone is talking" from "room tone", not to judge loudness.
  speechThreshold: 0.005,
  startFrames: 2,
  endSilenceMs: 700,
  minSegmentMs: 300,
  // Whisper's receptive window is 30s; stay well under it.
  maxSegmentMs: 12000,
  preRollFrames: 4,
};

export interface VadSegment {
  /** 16 kHz mono PCM for the whole utterance. */
  samples: Float32Array;
  /** Offset of the first sample from the start of the stream. */
  startMs: number;
  /** Offset just past the last sample. */
  endMs: number;
}

export interface EnergyVad {
  /** Feed one frame. Returns any segments completed by this frame (0 or 1). */
  push(frame: Float32Array, frameStartMs: number): VadSegment[];
  /** Close and return an in-progress segment, e.g. when capture stops. */
  flush(): VadSegment[];
  reset(): void;
}

/** Root-mean-square amplitude of a frame. */
export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

export function createEnergyVad(options: Partial<VadOptions> = {}): EnergyVad {
  const o: VadOptions = { ...DEFAULT_VAD_OPTIONS, ...options };
  const frameMs = (o.frameSamples / o.sampleRate) * 1000;

  let inSegment = false;
  let speechRun = 0;
  let silenceMs = 0;
  let frames: Float32Array[] = [];
  let samples = 0;
  let startMs = 0;
  let preRoll: { frame: Float32Array; startMs: number }[] = [];

  function take(): VadSegment | null {
    if (!inSegment || samples === 0) return null;
    const merged = new Float32Array(samples);
    let offset = 0;
    for (const f of frames) {
      merged.set(f, offset);
      offset += f.length;
    }
    const segment: VadSegment = {
      samples: merged,
      startMs,
      endMs: startMs + (samples / o.sampleRate) * 1000,
    };
    inSegment = false;
    frames = [];
    samples = 0;
    silenceMs = 0;
    speechRun = 0;
    return segment;
  }

  function open(): void {
    const first = preRoll[0];
    inSegment = true;
    startMs = first ? first.startMs : 0;
    frames = preRoll.map((p) => p.frame);
    samples = frames.reduce((n, f) => n + f.length, 0);
    silenceMs = 0;
    speechRun = 0;
    preRoll = [];
  }

  return {
    push(frame: Float32Array, frameStartMs: number): VadSegment[] {
      const out: VadSegment[] = [];
      const isSpeech = rms(frame) >= o.speechThreshold;

      if (!inSegment) {
        // Always retain the frame as potential pre-roll, bounded to a window
        // ending at (and including) the current frame.
        preRoll.push({ frame: frame.slice(), startMs: frameStartMs });
        if (preRoll.length > o.preRollFrames) preRoll.shift();

        if (isSpeech) {
          speechRun++;
          if (speechRun >= o.startFrames) open();
        } else {
          speechRun = 0;
        }
        return out;
      }

      // Inside a segment every frame is kept, including the quiet ones that
      // will ultimately close it.
      frames.push(frame.slice());
      samples += frame.length;

      if (isSpeech) {
        silenceMs = 0;
      } else {
        silenceMs += frameMs;
      }

      const durationMs = (samples / o.sampleRate) * 1000;
      if (silenceMs >= o.endSilenceMs || durationMs >= o.maxSegmentMs) {
        const segment = take();
        if (segment && durationMs >= o.minSegmentMs) out.push(segment);
      }
      return out;
    },

    flush(): VadSegment[] {
      const segment = take();
      // An open segment only ever exists because speech was detected, so
      // whatever is in flight at stop-time is worth transcribing.
      return segment ? [segment] : [];
    },

    reset(): void {
      inSegment = false;
      speechRun = 0;
      silenceMs = 0;
      frames = [];
      samples = 0;
      startMs = 0;
      preRoll = [];
    },
  };
}
