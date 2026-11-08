import { closeRuntime } from "./runtime/runtime";

/**
 * Releases shared services after the caller has drained interactive turns.
 * Safe to call repeatedly; cleanup failures are reported by the shared promise.
 */
export function shutdown(): Promise<void> {
  return closeRuntime();
}
