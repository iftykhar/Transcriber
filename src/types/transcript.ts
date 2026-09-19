export type Lang = "bn" | "en" | "unknown";
export type Platform = "meet" | "zoom" | "unknown";
export type ExportFormat = "txt" | "srt" | "json";

export interface TranscriptSegment {
  id: string;
  timestampMs: number;
  text: string;
  lang: Lang;
  platform: Platform;
  confidence: number;
  // Internal-only extras (never surfaced as UI badges — see Section 6/17
  // of the build spec). Optional because early pipeline stages may not
  // have them yet.
  durationMs?: number;
  sourceChunkId?: string;
  final?: boolean;
}
