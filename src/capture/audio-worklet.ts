import { createResampler } from "./resample";

// Runs in AudioWorkletGlobalScope, NOT Window and NOT a Web Worker.
// No `window`, `document`, or chrome.* APIs exist here — see
// src/types/audioworklet-globals.d.ts for the minimal ambient types
// this file is allowed to assume, and tsconfig.worklet.json for the
// compiler config (no DOM/WebWorker lib) that enforces it at
// typecheck time rather than only failing at runtime.
//
// Job: mix down to mono, resample the AudioContext's rate (usually 48 kHz)
// to the 16 kHz Whisper wants, and emit *fixed-size* frames rather than one
// message per 128-sample render quantum. The render quantum is far too small
// to hand across a thread boundary ~375 times a second; batching to 2048
// samples (128 ms at 16 kHz) cuts that to ~8 messages a second while still
// being fine-grained enough for the VAD to find silence.

/** What the offscreen document receives on the port. */
interface FrameMessage {
  chunkId: string;
  timestampMs: number;
  samples: Float32Array;
}

const TARGET_RATE = 16000;
/** 2048 / 16000 = 128 ms per frame. */
const FRAME_SAMPLES = 2048;

class PcmForwarderProcessor extends AudioWorkletProcessor {
  // `sampleRate` is the *context* rate, supplied by the worklet global scope.
  private readonly resampler = createResampler(sampleRate, TARGET_RATE);
  private buffer = new Float32Array(FRAME_SAMPLES);
  private buffered = 0;
  /** Frames emitted so far, used to derive each frame's wall-clock offset. */
  private emittedFrames = 0;
  private seq = 0;

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    const first = channels?.[0];
    if (!channels || !first || first.length === 0) {
      // Nothing connected yet (or a silent tail); stay alive either way.
      return true;
    }

    const mono = channels.length === 1 ? first : mixToMono(channels);
    const resampled = this.resampler.push(mono);

    let offset = 0;
    while (offset < resampled.length) {
      const room = FRAME_SAMPLES - this.buffered;
      const take = Math.min(room, resampled.length - offset);
      this.buffer.set(resampled.subarray(offset, offset + take), this.buffered);
      this.buffered += take;
      offset += take;

      if (this.buffered === FRAME_SAMPLES) {
        const frame = this.buffer;
        const message: FrameMessage = {
          chunkId: `f${this.seq++}`,
          timestampMs: (this.emittedFrames * FRAME_SAMPLES * 1000) / TARGET_RATE,
          samples: frame,
        };
        // Transfer the backing buffer instead of copying it: this runs on the
        // audio thread, so allocation and copying are what cause glitches.
        this.port.postMessage(message, [frame.buffer]);

        this.buffer = new Float32Array(FRAME_SAMPLES);
        this.buffered = 0;
        this.emittedFrames++;
      }
    }

    return true; // keep the processor alive
  }
}

/** Average N channels down to one. Meeting tab audio is usually already mono. */
function mixToMono(channels: Float32Array[]): Float32Array {
  const length = channels[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) {
      mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0);
    }
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i++) {
    mono[i] = (mono[i] ?? 0) * scale;
  }
  return mono;
}

registerProcessor("pcm-forwarder", PcmForwarderProcessor);
