import type { TranscriptSegment } from "../types/transcript";

// Rendering the overlay list.
//
// Segments arrive roughly in order and are append-only, so this keeps a
// reference to the list and appends rather than re-rendering the whole thing —
// important because a long meeting can accumulate thousands of nodes.
//
// Per the build spec, `lang` is used only as a subtle internal marker here and
// is never shown as a loud UI badge.

export interface Renderer {
  append(segment: TranscriptSegment): void;
  clear(): void;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Keep the view pinned to the newest line unless the user has scrolled up. */
function isNearBottom(list: HTMLElement): boolean {
  return list.scrollHeight - list.scrollTop - list.clientHeight < 48;
}

export function renderTranscript(list: HTMLElement): Renderer {
  return {
    append(segment: TranscriptSegment): void {
      if (!segment.text.trim()) return;

      const pinned = isNearBottom(list);

      const item = document.createElement("li");
      item.className = "segment";
      // Used as a subtle marker, not a badge.
      item.dataset["lang"] = segment.lang;

      const time = document.createElement("span");
      time.className = "segment-time";
      time.textContent = formatClock(segment.timestampMs);

      const text = document.createElement("span");
      text.className = "segment-text";
      text.textContent = segment.text;

      item.append(time, text);
      list.append(item);

      if (pinned) {
        list.scrollTop = list.scrollHeight;
      }
    },

    clear(): void {
      list.replaceChildren();
    },
  };
}
