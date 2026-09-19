import { createEnergyVad, type VadSegment } from "./vad";

// Tab-audio capture, implemented for the *offscreen document*.
//
// An MV3 service worker cannot hold a MediaStream or an AudioContext, so the
// background worker only mints a stream id and this module — running in the
// offscreen document — does the actual audio work:
//
//   getUserMedia(tab stream) -> AudioContext -> AudioWorklet("pcm-forwarder")
//        |                                          |
//        +-> ctx.destination                        v
//            (keep the meeting audible)        16 kHz frames -> energy VAD
//
// That last arrow to `ctx.destination` is not optional: capturing a tab
// *removes its audio from the user's speakers*, so without looping it back the
// meeting would go silent for the person using the extension.

/** Frame shape posted by capture/audio-worklet.ts. */
interface FrameMessage {
  chunkId: string;
  timestampMs: number;
  samples: Float32Array;
}

export interface CaptureEvents {
  /** Called for each completed utterance, in order. */
  onSegment(segment: VadSegment): void;
  /** Fatal problems that should surface to the user. */
  onError(message: string): void;
}

export interface TabAudioCapture {
  stop(): Promise<void>;
}

/** Chrome's tab-capture constraints are non-standard, so they need a cast. */
function tabConstraints(streamId: string): MediaStreamConstraints {
  return {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  } as unknown as MediaStreamConstraints;
}

export async function startTabAudioCapture(
  streamId: string,
  events: CaptureEvents
): Promise<TabAudioCapture> {
  const stream = await navigator.mediaDevices.getUserMedia(tabConstraints(streamId));

  const context = new AudioContext();
  if (context.state === "suspended") {
    // Offscreen documents can be created before any user gesture reaches
    // them, which leaves the context suspended and the worklet silent.
    await context.resume();
  }

  await context.audioWorklet.addModule(chrome.runtime.getURL("capture/audio-worklet.js"));

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "pcm-forwarder");

  const vad = createEnergyVad();

  node.port.onmessage = (event: MessageEvent<FrameMessage>) => {
    const frame = event.data;
    if (!frame || !frame.samples) return;
    for (const segment of vad.push(frame.samples, frame.timestampMs)) {
      events.onSegment(segment);
    }
  };
  node.port.onmessageerror = () => {
    events.onError("Audio frame could not be deserialised");
  };

  source.connect(node);
  // Loop the tab's audio back to the speakers, or the user hears nothing.
  source.connect(context.destination);

  let stopped = false;

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;

      // Anything mid-utterance at stop-time is still worth transcribing.
      for (const segment of vad.flush()) {
        events.onSegment(segment);
      }

      try {
        node.port.onmessage = null;
        node.port.onmessageerror = null;
        node.disconnect();
        source.disconnect();
      } catch {
        // Disconnecting an already-torn-down graph is not interesting.
      }

      for (const track of stream.getTracks()) {
        track.stop();
      }

      // Releasing the AudioContext frees the audio thread + worklet promptly,
      // rather than waiting on GC (Section 26, Resource management).
      try {
        await context.close();
      } catch {
        // Already closed.
      }
    },
  };
}
