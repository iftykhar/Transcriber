import type { Message } from "../types/messages";
import type { ExportFormat, Platform } from "../types/transcript";

// Popup wiring. The popup is the only place the user starts and stops capture,
// so it also owns the "this tab is not supported" messaging.

const statusEl = document.querySelector<HTMLParagraphElement>("#status");
const startBtn = document.querySelector<HTMLButtonElement>("#start");
const stopBtn = document.querySelector<HTMLButtonElement>("#stop");
const clearBtn = document.querySelector<HTMLButtonElement>("#clear");
const exportTxt = document.querySelector<HTMLButtonElement>("#export-txt");
const exportSrt = document.querySelector<HTMLButtonElement>("#export-srt");
const exportJson = document.querySelector<HTMLButtonElement>("#export-json");

let capturing = false;
let segmentCount = 0;

function platformFor(url: string | undefined): Platform {
  if (!url) return "unknown";
  if (url.startsWith("https://meet.google.com/")) return "meet";
  if (/^https:\/\/([a-z0-9-]+\.)?zoom\.us\//i.test(url)) return "zoom";
  return "unknown";
}

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function renderState(): void {
  if (startBtn) startBtn.disabled = capturing;
  if (stopBtn) stopBtn.disabled = !capturing;
  if (clearBtn) clearBtn.disabled = segmentCount === 0;
  for (const btn of [exportTxt, exportSrt, exportJson]) {
    if (btn) btn.disabled = segmentCount === 0;
  }
  if (capturing) {
    setStatus(`Listening\u2026 (${segmentCount} segment${segmentCount === 1 ? "" : "s"})`);
  }
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Ask for a formatted transcript and save it via a blob URL. */
async function exportAs(format: ExportFormat): Promise<void> {
  const result = await chrome.runtime.sendMessage({
    type: "ExportTranscript",
    format,
  } satisfies Message);

  const payload = result as
    | { type?: string; filename?: string; content?: string; error?: string }
    | undefined;

  if (!payload || payload.type !== "ExportResult" || typeof payload.content !== "string") {
    setStatus("Export failed");
    return;
  }

  const blob = new Blob([payload.content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = payload.filename ?? `transcript.${format}`;
  anchor.click();
  // Give the download a tick to start before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus(`Exported ${payload.filename ?? format}`);
}

startBtn?.addEventListener("click", () => {
  void (async () => {
    const tab = await activeTab();
    if (!tab?.id) {
      setStatus("No active tab");
      return;
    }

    const platform = platformFor(tab.url);
    if (platform === "unknown") {
      setStatus("Open a Google Meet or Zoom tab first");
      return;
    }

    setStatus("Starting\u2026");
    const response = await chrome.runtime.sendMessage({
      type: "StartCapture",
      tabId: tab.id,
      platform,
    } satisfies Message);

    const result = response as { type?: string; message?: string } | undefined;
    if (result?.type === "CaptureError") {
      setStatus(`Error: ${result.message ?? "capture failed"}`);
      return;
    }
    capturing = true;
    renderState();
  })().catch((err: unknown) => {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  });
});

stopBtn?.addEventListener("click", () => {
  void chrome.runtime
    .sendMessage({ type: "StopCapture" } satisfies Message)
    .finally(() => {
      capturing = false;
      renderState();
      setStatus("Stopped");
    });
});

clearBtn?.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "ClearTranscript" } satisfies Message).then(() => {
    segmentCount = 0;
    renderState();
    setStatus("Cleared");
  });
});

exportTxt?.addEventListener("click", () => void exportAs("txt"));
exportSrt?.addEventListener("click", () => void exportAs("srt"));
exportJson?.addEventListener("click", () => void exportAs("json"));

// Live updates from the pipeline. Model progress and transcript segments are
// broadcast by the background worker; tab-scoped messages carry a `tabId`
// which the popup ignores (it is not a tab).
chrome.runtime.onMessage.addListener((message: Message) => {
  switch (message.type) {
    case "ModelLoading":
      setStatus("Loading model\u2026");
      break;

    case "ModelProgress": {
      // Show which file is in flight: downloading ~76 MB with no feedback
      // looks like a hang, and the byte total is not knowable up front.
      const name = message.detail ? message.detail.split("/").pop() : undefined;
      setStatus(
        `Downloading model\u2026 ${Math.round(message.progress * 100)}%${name ? ` \u2014 ${name}` : ""}`
      );
      break;
    }

    case "ModelReady":
      setStatus(capturing ? `Listening\u2026 (${segmentCount})` : "Model ready");
      break;

    case "ModelError":
      setStatus(`Model error: ${message.message}`);
      break;

    case "CaptureStarted":
      capturing = true;
      renderState();
      break;

    case "CaptureStopped":
      capturing = false;
      renderState();
      setStatus("Stopped");
      break;

    case "CaptureError":
      setStatus(`Error: ${message.message}`);
      break;

    case "TranscriptChunk":
      segmentCount += 1;
      renderState();
      break;

    case "TranscriptState":
      segmentCount = message.count;
      capturing = message.capturing;
      renderState();
      if (!capturing && segmentCount === 0) setStatus("Idle");
      break;

    case "ClearTranscript":
      segmentCount = 0;
      renderState();
      break;

    // Addressed to other contexts.
    case "StartCapture":
    case "StopCapture":
    case "OffscreenStartCapture":
    case "AudioChunk":
    case "TranscribeChunk":
    case "TranscriptError":
    case "LoadModel":
    case "ExportTranscript":
    case "ExportResult":
    case "RequestTranscriptState":
    case "RequestTabIdentity":
    case "TabIdentity":
      break;

    default:
      break;
  }
});

// Initial paint: reflect anything already captured in this browsing session.
void chrome.runtime
  .sendMessage({ type: "RequestTranscriptState" } satisfies Message)
  .then((response: unknown) => {
    const state = response as { type?: string; count?: number; capturing?: boolean } | undefined;
    if (state?.type === "TranscriptState") {
      segmentCount = state.count ?? 0;
      capturing = state.capturing ?? false;
    }
    renderState();
    if (!capturing) setStatus(segmentCount > 0 ? `${segmentCount} segments captured` : "Idle");
  })
  .catch(() => {
    setStatus("Idle");
    renderState();
  });
