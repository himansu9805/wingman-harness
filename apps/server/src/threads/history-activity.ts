import type { getThreadMessages } from "@wingman/core/turns";

type Message = Awaited<ReturnType<typeof getThreadMessages>>["messages"][number];

/** Identify the occurrences of legacy reply text belonging to a checkpoint page. */
export function historyReplyWindows(page: Message[], newer: Message[]) {
  const windows = new Map<string, { reply: string; take: number; skip: number }>();
  for (const message of page) {
    if (message.role !== "assistant" || !message.text || message.toolCalls?.length) continue;
    const window = windows.get(message.text) ?? { reply: message.text, take: 0, skip: 0 };
    window.take++;
    windows.set(message.text, window);
  }
  for (const message of newer) {
    if (message.role !== "assistant" || message.toolCalls?.length) continue;
    const window = windows.get(message.text);
    if (window) window.skip++;
  }
  return [...windows.values()];
}
