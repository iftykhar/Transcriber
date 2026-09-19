// Minimal ambient declarations for AudioWorkletGlobalScope.
//
// This scope is NOT Window and NOT a generic Web Worker — lib.dom and
// lib.webworker both assume the wrong global, so audio-worklet.ts is
// compiled (tsconfig.worklet.json) with no DOM/WebWorker lib at all,
// and only the pieces actually used here declared by hand.
// Keep this file minimal and dependency-free on purpose (see SKILL note
// in capture/audio-worklet.ts): only add a declaration when the worklet
// code actually needs it.

declare class AudioWorkletProcessor {
  constructor();
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (
    options?: { processorOptions?: unknown }
  ) => AudioWorkletProcessor
): void;

declare const sampleRate: number;

interface MessagePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((this: MessagePort, ev: MessageEvent) => unknown) | null;
}

interface MessageEvent<T = unknown> {
  readonly data: T;
}
