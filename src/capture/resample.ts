// Streaming linear-interpolation resampler (mono, Float32).
//
// The AudioContext runs at the device rate (typically 48 kHz); Whisper
// wants 16 kHz mono. Rather than buffering a giant block, this keeps a
// fractional read cursor and only ever holds the tiny sliver of input
// needed to interpolate the next output sample, so it is safe to call
// from the AudioWorklet's `process()` on every 128-sample render quantum.
//
// Kept dependency-free (no imports) on purpose: it is pure math, so it can
// be exercised directly by the test runner via Node's type stripping.

export interface Resampler {
  /** Resample `input` (mono, at `inputRate`) and return newly produced output samples. */
  push(input: Float32Array): Float32Array;
  readonly inputRate: number;
  readonly outputRate: number;
  /** Output samples still buffered because one more input sample is needed to interpolate them. */
  readonly pending: number;
}

export function createResampler(inputRate: number, outputRate: number): Resampler {
  if (!(inputRate > 0) || !(outputRate > 0)) {
    throw new RangeError(`createResampler: rates must be > 0 (got ${inputRate} -> ${outputRate})`);
  }

  const ratio = inputRate / outputRate;

  // Unconsumed input. Bounded: after each push we drop everything the read
  // cursor has already passed, so this never grows with stream length.
  let buf = new Float32Array(0);
  // Fractional read position, relative to the start of `buf`.
  let readPos = 0;

  return {
    inputRate,
    outputRate,

    get pending(): number {
      return Math.max(0, buf.length - readPos);
    },

    push(input: Float32Array): Float32Array {
      if (input.length === 0) return new Float32Array(0);

      const merged = new Float32Array(buf.length + input.length);
      merged.set(buf, 0);
      merged.set(input, buf.length);
      buf = merged;

      // Interpolation needs a sample *after* the cursor, so stop one short
      // of the end and carry those samples into the next push.
      const capacity = Math.ceil(Math.max(0, buf.length - 1 - readPos) / ratio);
      const out = new Float32Array(Math.max(0, capacity));
      let n = 0;

      while (readPos + 1 < buf.length) {
        const i = Math.floor(readPos);
        const a = buf[i] ?? 0;
        const b = buf[i + 1] ?? a;
        out[n++] = a + (b - a) * (readPos - i);
        readPos += ratio;
      }

      const consumed = Math.floor(readPos);
      if (consumed > 0) {
        buf = buf.slice(consumed);
        readPos -= consumed;
      }

      return n === out.length ? out : out.slice(0, n);
    },
  };
}
