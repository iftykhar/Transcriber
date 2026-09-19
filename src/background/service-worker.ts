import { assertNever, type Message } from "../types/messages";
import type { ExportFormat, Platform } from "../types/transcript";
import { addSegment, allSegments, clearSegments, segmentCount } from "../transcript/store";
import { formatTranscript, suggestedFilename } from "../transcript/export";

// The background service worker is the router and the only context that knows
// *which* tab is being captured. Two responsibilities worth calling out:
//
// 1. Minting the tabCapture stream id. The id has to be produced here, but the
//    resulting MediaStream can only be consumed by an offscreen document —
//    an MV3 service worker cannot hold one.
//
// 2. Targeting messages. `chrome.runtime.sendMessage` fans a message out to
//    *every* extension context, including content scripts in unrelated
//    Meet/Zoom tabs. Tab-scoped messages are therefore relayed with
//    `chrome.tabs.sendMessage` and stamped with a `tabId`, which content
//    scripts verify against their own id.

/** The tab currently being captured, if any. */
let activeTabId: number | null = null;

// --- Shipping lanes ------------------------------------------------------

/** Deliver a tab-scoped message to exactly one tab's content script. */
function relayToTab(tabId: number, message: Message): void {
  void chrome.tabs.sendMessage(tabId, message).catch(() => {
    // The tab may have navigated away or never had our content script.
  });
}

/** Deliver to the popup and any other interested extension context. */
function broadcast(message: Message): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    // No popup open is the common case; not an error.
  });
}

// --- Offscreen document --------------------------------------------------

async function ensureOffscreen(): Promise<void> {
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen/offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Capture and resample tab audio for local speech recognition.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Creating a second offscreen document is an error but not a failure:
    // one is already up, which is exactly what we wanted.
    if (/already exists|single offscreen|Only a single/i.test(message)) return;
    throw err;
  }
}

async function closeOffscreen(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Already gone.
  }
}

// --- Capture -------------------------------------------------------------

/**
 * `chrome.tabCapture.getMediaStreamId` is wrapped by hand rather than called
 * as a promise, because its `@types/chrome` signature is callback-shaped in
 * some versions and promise-shaped in others.
 */
function acquireStreamId(tabId: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const lastError = chrome.runtime.lastError;
      if (lastError || !streamId) {
        reject(new Error(lastError?.message ?? "Could not acquire a stream id for this tab"));
        return;
      }
      resolve(streamId);
    });
  });
}

async function startCapture(message: { tabId: number; platform: Platform }): Promise<Message> {
  try {
    const streamId = await acquireStreamId(message.tabId);
    await ensureOffscreen();

    activeTabId = message.tabId;

    // Hand the stream id to the offscreen document, which opens the stream.
    broadcast({
      type: "OffscreenStartCapture",
      streamId,
      tabId: message.tabId,
      platform: message.platform,
    });

    return { type: "CaptureStarted", tabId: message.tabId };
  } catch (err) {
    return {
      type: "CaptureError",
      message: err instanceof Error ? err.message : String(err),
      tabId: message.tabId,
    };
  }
}

async function stopCapture(): Promise<Message> {
  // Ask the offscreen document to stop; it replies with CaptureStopped once
  // the audio graph is actually torn down.
  broadcast({ type: "StopCapture" });
  return { type: "CaptureStopped", tabId: activeTabId ?? undefined };
}

// --- Message handling ----------------------------------------------------

async function handle(message: Message, sender: chrome.runtime.MessageSender): Promise<Message | undefined> {
  switch (message.type) {
    // --- from the popup ------------------------------------------------
    case "StartCapture": {
      const result = await startCapture({ tabId: message.tabId, platform: message.platform });
      if (result.type === "CaptureStarted") {
        // Let the captured tab mount its overlay.
        relayToTab(message.tabId, { type: "CaptureStarted", tabId: message.tabId });
      }
      return result;
    }

    case "StopCapture":
      return await stopCapture();

    case "ExportTranscript": {
      const format: ExportFormat = message.format;
      const segments = await allSegments();
      return {
        type: "ExportResult",
        format,
        filename: suggestedFilename(format),
        content: formatTranscript(segments, format),
      };
    }

    case "ClearTranscript": {
      await clearSegments();
      if (activeTabId !== null) relayToTab(activeTabId, { type: "ClearTranscript" });
      broadcast({ type: "ClearTranscript" });
      return { type: "TranscriptState", count: 0, capturing: activeTabId !== null };
    }

    case "RequestTranscriptState":
      return { type: "TranscriptState", count: await segmentCount(), capturing: activeTabId !== null };

    case "RequestTabIdentity":
      // `sender.tab` is only populated for messages from content scripts.
      return { type: "TabIdentity", tabId: sender.tab?.id ?? -1 };

    // --- from the offscreen document -----------------------------------
    case "CaptureStarted":
      activeTabId = message.tabId;
      relayToTab(message.tabId, message);
      broadcast(message);
      return undefined;

    case "CaptureStopped": {
      const tabId = activeTabId;
      activeTabId = null;
      // Free the audio thread, worklet, and Whisper worker now that capture
      // is over; the model itself stays cached in IndexedDB.
      await closeOffscreen();
      const stopped: Message = { type: "CaptureStopped", tabId: tabId ?? undefined };
      if (tabId !== null) relayToTab(tabId, stopped);
      broadcast(stopped);
      return undefined;
    }

    case "CaptureError":
      if (message.tabId !== undefined) relayToTab(message.tabId, message);
      broadcast(message);
      return undefined;

    case "TranscriptChunk": {
      // Persist first so an export after Stop still sees the last segment.
      await addSegment(message.segment);
      const stamped: Message = {
        type: "TranscriptChunk",
        segment: message.segment,
        tabId: activeTabId ?? undefined,
      };
      if (activeTabId !== null) relayToTab(activeTabId, stamped);
      broadcast(stamped);
      return undefined;
    }

    case "ModelLoading":
    case "ModelProgress":
    case "ModelReady":
    case "ModelError":
      // Pure UI state for the popup.
      broadcast(message);
      return undefined;

    case "TranscriptError":
      // Routine, per-segment noise (filtered hallucination, dropped backlog).
      console.debug("[bn-en-live-transcriber]", message.message);
      return undefined;

    // --- not addressed to the background worker ------------------------
    case "OffscreenStartCapture":
    case "AudioChunk":
    case "TranscribeChunk":
    case "LoadModel":
    case "ExportResult":
    case "TranscriptState":
    case "TabIdentity":
      return undefined;

    default:
      return assertNever(message);
  }
}

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  void handle(message, sender).then(
    (response) => sendResponse(response),
    (err: unknown) => {
      console.error("[bn-en-live-transcriber] background handler failed:", err);
      sendResponse({
        type: "CaptureError",
        message: err instanceof Error ? err.message : String(err),
      } satisfies Message);
    }
  );
  // Always keep the response channel open: several branches are async.
  return true;
});

export {};
