import type { Message } from "../types/messages";
import type { Platform, TranscriptSegment } from "../types/transcript";
import { mountOverlayPanel, setOverlayStatus, type OverlayPanel } from "./overlay/overlay-panel";
import { assertNever } from "../types/messages";

// Content-script entry point, shared by the Meet and Zoom injectors.
//
// Content scripts are the one context that cannot learn its own tab id, so the
// first thing this does is ask the background worker. That id is then used to
// filter the tab-scoped broadcasts that `chrome.runtime.sendMessage` fans out
// to every extension context — including content scripts in *other*
// Meet/Zoom tabs, which must not render this tab's transcript.

const INJECTED_FLAG = "__bnEnLiveTranscriberInjected";

let panel: OverlayPanel | null = null;
let tabId: number | null = null;

function ensurePanel(): OverlayPanel {
  panel ??= mountOverlayPanel();
  return panel;
}

function onMessage(message: Message, _sender: chrome.runtime.MessageSender): void {
  // Ignore anything not addressed to this tab. Messages with no `tabId` were
  // broadcast for other contexts (e.g. popup-only model progress).
  const target = "tabId" in message ? message.tabId : undefined;
  if (target === undefined || tabId === null || target !== tabId) {
    return;
  }

  switch (message.type) {
    case "CaptureStarted":
      ensurePanel().show();
      setOverlayStatus("Listening\u2026");
      break;

    case "CaptureStopped":
      setOverlayStatus("Stopped");
      break;

    case "CaptureError":
      ensurePanel().show();
      setOverlayStatus(`Error: ${message.message}`);
      break;

    case "TranscriptChunk":
      ensurePanel().show();
      ensurePanel().append(message.segment as TranscriptSegment);
      break;

    case "ClearTranscript":
      panel?.clear();
      break;

    case "ToggleOverlay":
      ensurePanel().toggle();
      break;

    // Everything else is addressed to another context.
    case "StartCapture":
    case "StopCapture":
    case "OffscreenStartCapture":
    case "AudioChunk":
    case "TranscribeChunk":
    case "TranscriptError":
    case "LoadModel":
    case "ModelLoading":
    case "ModelProgress":
    case "ModelReady":
    case "ModelError":
    case "ExportTranscript":
    case "ExportResult":
    case "RequestTranscriptState":
    case "TranscriptState":
    case "RequestTabIdentity":
    case "TabIdentity":
      break;

    default:
      assertNever(message);
  }
}

export function bootstrap(platform: Platform): void {
  const w = window as unknown as Record<string, boolean>;
  if (w[INJECTED_FLAG]) {
    return;
  }
  w[INJECTED_FLAG] = true;

  chrome.runtime.onMessage.addListener(onMessage);

  // Resolve our own tab id, then keep the overlay ready. Failure just means we
  // never match a tab-scoped message, which is the safe direction to fail.
  void chrome.runtime
    .sendMessage({ type: "RequestTabIdentity" } satisfies Message)
    .then((response: unknown) => {
      if (response && typeof response === "object") {
        const identity = response as { type?: string; tabId?: number };
        if (identity.type === "TabIdentity" && typeof identity.tabId === "number" && identity.tabId >= 0) {
          tabId = identity.tabId;
        }
      }
      console.debug(`[bn-en-live-transcriber] ready on platform=${platform} tab=${tabId}`);
    })
    .catch(() => {
      console.debug(`[bn-en-live-transcriber] bootstrapped on platform=${platform} (no tab id)`);
    });
}
