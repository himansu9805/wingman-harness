import type { TurnEvent } from "@wingman/core";

/** Formats the selected model and classifier probabilities for the terminal. */
export function formatRoute(event: Extract<TurnEvent, { type: "route" }>): string {
  const probabilities = Object.entries(event.probabilities ?? {});
  if (probabilities.length === 0) {
    return `${event.choice} — probabilities unavailable`;
  }
  const scores = probabilities.map(([name, probability]) => {
    const percentage = probability > 0 && probability < 0.0001
      ? "<0.01"
      : (probability * 100).toFixed(2);
    return `${name}: ${percentage}%`;
  });
  return `${event.choice} — ${scores.join(", ")}`;
}
