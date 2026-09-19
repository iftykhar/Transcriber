import type { ExportFormat, Platform, TranscriptSegment } from "./transcript";

// The single source of truth for cross-context communication.
//
// Five runtime contexts share this union: the background service worker, the
// offscreen document, the Meet/Zoom content scripts, the popup, and the
// AudioWorklet/Whisper workers. Each one switches exhaustively over it and
// calls `assertNever` in the default branch, so adding a variant here forces
// every handler to deal with it at compile time rather than at runtime.
//
// A note on `tabId`: several messages are *tab-scoped* (they only make sense
// for the tab being captured). Those carry an explicit `tabId`, and content
// scripts ignore any tab-scoped message whose `tabId` is not their own. This
// matters because `chrome.runtime.sendMessage` broadcasts to *every* extension
// context, including content scripts in unrelated Meet/Zoom tabs.

// --- Capture lifecycle ------------------------------------------------

export interface StartCapture {
  type: "StartCapture";
  tabId: number;
  platform: Platform;
}

export interface StopCapture {
  type: "StopCapture";
}

/**
 * Background -> offscreen. The stream id must be minted by
 * `chrome.tabCapture.getMediaStreamId` and then *consumed* by the offscreen
 * document, because an MV3 service worker cannot hold the resulting stream.
 */
export interface OffscreenStartCapture {
  type: "OffscreenStartCapture";
  streamId: string;
  tabId: number;
  platform: Platform;
}

export interface CaptureStarted {
  type: "CaptureStarted";
  tabId: number;
}

export interface CaptureStopped {
  type: "CaptureStopped";
  tabId?: number;
}

export interface CaptureError {
  type: "CaptureError";
  message: string;
  tabId?: number;
}

// --- Audio chunk handoff (capture -> whisper worker) -------------------

export interface AudioChunk {
  type: "AudioChunk";
  chunkId: string;
  timestampMs: number;
  // 16kHz mono PCM, Float32. Transferred, not copied — see
  // capture/tab-audio-capture.ts for the backpressure/queueing strategy.
  samples: Float32Array;
}

export interface TranscribeChunk {
  type: "TranscribeChunk";
  chunk: AudioChunk;
}

// --- Transcription results ---------------------------------------------

export interface TranscriptChunk {
  type: "TranscriptChunk";
  segment: TranscriptSegment;
  /** Set when relayed to a specific tab's overlay. */
  tabId?: number;
}

export interface TranscriptError {
  type: "TranscriptError";
  chunkId: string;
  message: string;
}

// --- Model lifecycle -----------------------------------------------------

export interface LoadModel {
  type: "LoadModel";
}

export interface ModelLoading {
  type: "ModelLoading";
}

export interface ModelProgress {
  type: "ModelProgress";
  progress: number; // 0..1
  /** File currently being fetched, for display (basename is enough). */
  detail?: string;
}

export interface ModelReady {
  type: "ModelReady";
}

export interface ModelError {
  type: "ModelError";
  message: string;
}

// --- Transcript store control -------------------------------------------

export interface ClearTranscript {
  type: "ClearTranscript";
}

export interface ExportTranscript {
  type: "ExportTranscript";
  format: ExportFormat;
}

export interface ExportResult {
  type: "ExportResult";
  format: ExportFormat;
  filename: string;
  content: string;
  error?: string;
}

export interface RequestTranscriptState {
  type: "RequestTranscriptState";
}

export interface TranscriptState {
  type: "TranscriptState";
  count: number;
  capturing: boolean;
}

// --- Content-script identity handshake ----------------------------------

/**
 * A content script cannot learn its own tab id directly, so it asks the
 * background worker, which reads it off `sender.tab`.
 */
export interface RequestTabIdentity {
  type: "RequestTabIdentity";
}

export interface TabIdentity {
  type: "TabIdentity";
  tabId: number;
}

// --- Union + exhaustiveness helper --------------------------------------

export type Message =
  | StartCapture
  | StopCapture
  | OffscreenStartCapture
  | CaptureStarted
  | CaptureStopped
  | CaptureError
  | AudioChunk
  | TranscribeChunk
  | TranscriptChunk
  | TranscriptError
  | LoadModel
  | ModelLoading
  | ModelProgress
  | ModelReady
  | ModelError
  | ClearTranscript
  | ExportTranscript
  | ExportResult
  | RequestTranscriptState
  | TranscriptState
  | RequestTabIdentity
  | TabIdentity;

/**
 * Call in the `default` branch of an exhaustive switch over Message.
 * If a new variant is added to the union and a handler doesn't cover
 * it, TypeScript will fail to compile at the call site — not at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
