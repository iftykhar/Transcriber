import { assertNever, type Message } from "../types/messages";
import type { Platform } from "../types/transcript";
import { startTabAudioCapture, type TabAudioCapture } from "../capture/tab-audio-capture";

// This document is created on demand by the background service worker
// (chrome.offscreen.createDocument) precisely because a service worker
// cannot hold a MediaStream or AudioContext but an offscreen document
// can.
//
// It is the hub of the pipeline: it owns both the tab-audio capture and the
// Whisper worker, so audio never has to cross a serialisation boundary twice.
//
//   worklet frames -> VAD segments -> (transfer to worker) -> TranscriptChunk
//
// Everything it learns is forwarded to the background worker, which is the
// only context that knows which tab is being captured and which keeps the
// transcript store.

let capture: TabAudioCapture | null = null;
let worker: Worker | null = null;
let platform: Platform = "unknown";

/** Send to the background service worker. */
function toBackground(message: Message): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    // The service worker can be briefly unavailable; dropping a progress
    // tick is not worth surfacing.
  });
}

function ensureWorker(): Worker {
  if (worker) return worker;

  const w = new Worker(chrome.runtime.getURL("asr/whisper-worker.js"));

  w.onmessage = (event: MessageEvent<Message>) => {
    const message = event.data;
    switch (message.type) {
      case "TranscriptChunk":
        // Relay to the background worker, which stamps the tab id and files
        // the segment in the store.
        toBackground(message);
        break;

      case "ModelProgress":
      case "ModelLoading":
      case "ModelReady":
      case "ModelError":
        toBackground(message);
        break;

      case "TranscriptError":
        // Routine: filtered hallucinations, dropped backlog, too-short audio.
        console.debug("[bn-en-live-transcriber] segment skipped:", message.message);
        break;

      default:
        // Anything else the worker echoes is not addressed to us.
        break;
    }
  };

  w.onerror = (event) => {
    toBackground({ type: "ModelError", message: event.message || "Whisper worker crashed" });
  };

  worker = w;
  return w;
}

async function startCapture(message: {
  streamId: string;
  tabId: number;
  platform: Platform;
  language: "auto" | "bn" | "en" | "banglish";
}): Promise<void> {
  platform = message.platform;

  if (capture) {
    // Already capturing (e.g. the user clicked Start twice); treat as a no-op
    // rather than tearing down a working pipeline.
    toBackground({ type: "CaptureStarted", tabId: message.tabId });
    return;
  }

  const w = ensureWorker();
  // Tell the worker where the audio is coming from, then start pulling the
  // model down. The model is deliberately *not* loaded before this point.
  w.postMessage({ type: "OffscreenStartCapture", streamId: message.streamId, tabId: message.tabId, platform, language: message.language } satisfies Message);
  w.postMessage({ type: "LoadModel" } satisfies Message);

  capture = await startTabAudioCapture(message.streamId, {
    onSegment(segment) {
      // Transfer the PCM to the worker; nothing else needs it afterwards.
      const samples = segment.samples;
      const chunk = {
        type: "AudioChunk",
        chunkId: `seg_${segment.startMs.toFixed(0)}`,
        timestampMs: segment.startMs,
        samples,
      } as const;
      w.postMessage({ type: "TranscribeChunk", chunk } satisfies Message, [samples.buffer]);
    },
    onError(errorMessage) {
      toBackground({ type: "CaptureError", message: errorMessage, tabId: message.tabId });
    },
  });

  toBackground({ type: "CaptureStarted", tabId: message.tabId });
}

async function stopCapture(): Promise<void> {
  const active = capture;
  capture = null;
  if (active) {
    // Let the VAD flush its in-flight utterance before we tear the graph down.
    await active.stop();
  }
  toBackground({ type: "CaptureStopped" });
}

chrome.runtime.onMessage.addListener((message: Message) => {
  switch (message.type) {
    case "OffscreenStartCapture":
      void startCapture(message).catch((err: unknown) => {
        toBackground({
          type: "CaptureError",
          message: err instanceof Error ? err.message : String(err),
          tabId: message.tabId,
        });
      });
      return false;

    case "StopCapture":
      void stopCapture().catch((err: unknown) => {
        toBackground({
          type: "CaptureError",
          message: err instanceof Error ? err.message : String(err),
        });
      });
      return false;

    case "StartCapture":
      // StartCapture is handled by the background worker, which owns stream-id
      // minting; the offscreen document only ever reacts to the handoff.
      break;

    case "CaptureStarted":
    case "CaptureStopped":
    case "CaptureError":
    case "AudioChunk":
    case "TranscribeChunk":
    case "TranscriptChunk":
    case "TranscriptError":
    case "LoadModel":
    case "ModelLoading":
    case "ModelProgress":
    case "ModelReady":
    case "ModelError":
    case "ClearTranscript":
    case "ExportTranscript":
    case "ExportResult":
    case "RequestTranscriptState":
    case "TranscriptState":
    case "RequestTabIdentity":
    case "TabIdentity":
    case "ToggleOverlay":
      break;

    default:
      assertNever(message);
  }
  return false;
});

export {};
