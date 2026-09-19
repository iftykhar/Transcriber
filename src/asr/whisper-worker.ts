import { assertNever, type Message } from "../types/messages";
import type { Platform } from "../types/transcript";
import { ensure, getLoadState, getLastError, type LoadProgress } from "./model-loader";
import { transcribeSegment } from "./transcribe";

// Dedicated Worker (not the service worker, not AudioWorklet). Has
// `self`/postMessage/fetch/IndexedDB but no DOM — matches tsconfig.worker.json
// (lib: ES2022 + WebWorker, no DOM).
//
// Hosted by the offscreen document, which is also where audio is captured, so
// chunks arrive here as transferred Float32Arrays with no extra hop. Whisper
// is heavy and single-threaded-ish, so jobs run strictly in order through a
// bounded queue: if transcription falls behind live speech we drop the oldest
// pending utterance rather than growing memory without limit.

/** Post messages back to the offscreen document. */
function reply(message: Message): void {
  self.postMessage(message);
}

function postProgress(progress: LoadProgress): void {
  reply({
    type: "ModelProgress",
    progress: Math.max(0, Math.min(1, progress.progress)),
    detail: progress.detail,
  });
}

/** Current capture context, set when the offscreen document starts a capture. */
let platform: Platform = "unknown";

// --- Ordered, bounded job queue -----------------------------------------

const MAX_QUEUE = 4;
let running = false;
let queue: { samples: Float32Array; timestampMs: number; chunkId: string }[] = [];

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      try {
        const { segment, skippedReason } = await transcribeSegment(job.samples, {
          platform,
          timestampMs: job.timestampMs,
          sourceChunkId: job.chunkId,
        });
        if (segment) {
          reply({ type: "TranscriptChunk", segment });
        } else if (skippedReason) {
          // Not an error path — just nothing worth showing.
          reply({ type: "TranscriptError", chunkId: job.chunkId, message: skippedReason });
        }
      } catch (err) {
        reply({
          type: "TranscriptError",
          chunkId: job.chunkId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    running = false;
  }
}

function enqueue(samples: Float32Array, timestampMs: number, chunkId: string): void {
  if (queue.length >= MAX_QUEUE) {
    const dropped = queue.shift();
    if (dropped) {
      reply({
        type: "TranscriptError",
        chunkId: dropped.chunkId,
        message: "dropped: transcription backlog exceeded",
      });
    }
  }
  queue.push({ samples, timestampMs, chunkId });
  void drain();
}

self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;

  switch (message.type) {
    case "TranscribeChunk": {
      const { chunk } = message;
      void (async () => {
        // Lazily spin the model up if audio somehow arrives first; capture
        // start normally triggers LoadModel ahead of this.
        if (getLoadState() !== "ready") {
          try {
            await ensure(postProgress);
          } catch (err) {
            reply({
              type: "ModelError",
              message: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }
        enqueue(chunk.samples, chunk.timestampMs, chunk.chunkId);
      })();
      break;
    }

    case "LoadModel":
      void (async () => {
        if (getLoadState() === "ready") {
          reply({ type: "ModelReady" });
          return;
        }
        reply({ type: "ModelLoading" });
        try {
          await ensure(postProgress);
          reply({ type: "ModelReady" });
        } catch (err) {
          reply({
            type: "ModelError",
            message: getLastError() ?? (err instanceof Error ? err.message : String(err)),
          });
        }
      })();
      break;

    case "StartCapture":
    case "OffscreenStartCapture":
      if (message.type === "OffscreenStartCapture") platform = message.platform;
      break;

    case "StopCapture":
    case "CaptureStarted":
    case "CaptureStopped":
    case "CaptureError":
    case "AudioChunk":
    case "TranscriptChunk":
    case "TranscriptError":
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
      // Not this context's concern — ignored rather than erroring, so adding
      // a broadcast-style message elsewhere doesn't require every worker to
      // explicitly no-op it forever.
      break;

    default:
      assertNever(message);
  }
};

export {};
