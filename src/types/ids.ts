// Prefix helpers so ids stay readable in logs/exports across contexts.
let counter = 0;

/**
 * Locally-generated unique id.
 *
 * `crypto.randomUUID` is not guaranteed by every lib target this project
 * compiles under (the ASR worker builds against `lib.webworker` only), so
 * this avoids the global entirely.
 */
export function makeId(prefix = "seg"): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${rand}`;
}
