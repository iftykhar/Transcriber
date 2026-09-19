import type { ExportFormat, TranscriptSegment } from "../types/transcript";

// Transcript serialisation for the popup's export buttons.
//
// Only imports types, so it stays testable in isolation under Node's type
// stripping.

export type { ExportFormat };

function pad(n: number, width: number): string {
  return String(Math.floor(n)).padStart(width, "0");
}

function clockFromMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}`;
}

/** SRT wants `HH:MM:SS,mmm`. */
function srtTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/** A segment's end: explicit `durationMs` if known, otherwise the next segment's start. */
function endOf(segment: TranscriptSegment, next: TranscriptSegment | undefined): number {
  if (typeof segment.durationMs === "number" && segment.durationMs > 0) {
    return segment.timestampMs + segment.durationMs;
  }
  if (next && next.timestampMs > segment.timestampMs) return next.timestampMs;
  // Last resort: a readable minimum so SRT players do not collapse the cue.
  return segment.timestampMs + 1000;
}

export function formatTxt(segments: readonly TranscriptSegment[]): string {
  return segments.map((s) => `[${clockFromMs(s.timestampMs)}] ${s.text}`).join("\n") + (segments.length ? "\n" : "");
}

export function formatSrt(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((s, i) => {
      const end = Math.max(endOf(s, segments[i + 1]), s.timestampMs + 1);
      return `${i + 1}\n${srtTimestamp(s.timestampMs)} --> ${srtTimestamp(end)}\n${s.text}\n`;
    })
    .join("\n");
}

export function formatJson(segments: readonly TranscriptSegment[]): string {
  return JSON.stringify(
    {
      segmentCount: segments.length,
      segments: segments.map((s) => ({
        id: s.id,
        timestampMs: s.timestampMs,
        text: s.text,
        lang: s.lang,
        platform: s.platform,
        confidence: s.confidence,
        durationMs: s.durationMs,
        sourceChunkId: s.sourceChunkId,
        final: s.final,
      })),
    },
    null,
    2
  );
}

export function formatTranscript(segments: readonly TranscriptSegment[], format: ExportFormat): string {
  switch (format) {
    case "txt":
      return formatTxt(segments);
    case "srt":
      return formatSrt(segments);
    case "json":
      return formatJson(segments);
  }
}

export function extensionFor(format: ExportFormat): string {
  return format;
}

export function suggestedFilename(format: ExportFormat, at: number = Date.now()): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `transcript_${stamp}.${format}`;
}
