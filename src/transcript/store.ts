import type { TranscriptSegment } from "../types/transcript";

// The transcript store lives in the *background service worker*, not the
// offscreen document: the offscreen document is torn down when capture stops,
// but the popup must still be able to export afterwards.
//
// MV3 service workers are killed after ~30s idle. Segments normally arrive
// faster than that, but a slow speaker could still out-wait the timer, so the
// store writes through to `chrome.storage.session` (an in-memory, extension-
// only store that survives worker restarts but not a browser restart). That
// keeps a meeting's transcript alive without writing it to disk.

const STORAGE_KEY = "transcript:segments";

let cache: TranscriptSegment[] | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function load(): Promise<TranscriptSegment[]> {
  if (cache) return cache;
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    cache = Array.isArray(value) ? (value as TranscriptSegment[]) : [];
  } catch {
    // Session storage can be unavailable (e.g. extension reloaded mid-flight);
    // degrade to an in-memory-only transcript rather than losing capture.
    cache = [];
  }
  return cache;
}

function persist(segments: TranscriptSegment[]): void {
  // Serialise writes so a burst of segments cannot interleave.
  writeChain = writeChain
    .then(() => chrome.storage.session.set({ [STORAGE_KEY]: segments }))
    .catch(() => {
      // Quota or teardown; the in-memory copy is still authoritative.
    });
}

export async function addSegment(segment: TranscriptSegment): Promise<void> {
  const segments = await load();
  segments.push(segment);
  persist(segments);
}

export async function allSegments(): Promise<TranscriptSegment[]> {
  return [...(await load())];
}

export async function segmentCount(): Promise<number> {
  return (await load()).length;
}

export async function clearSegments(): Promise<void> {
  cache = [];
  persist(cache);
}
