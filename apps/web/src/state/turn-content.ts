import type { ToolCall } from "../api/types";
import type { DelegationPlanSnapshot } from "../api/delegation";
import { delegatedPlans } from "./delegation";
import { liveCalls, type TranscriptTurn } from "./transcript";

export type TurnContent =
  | { type: "tools"; id: string; calls: ToolCall[] }
  | { type: "delegation"; id: string; plan: DelegationPlanSnapshot }
  | { type: "text"; id: string; text: string };

/** History owns saved calls; the event journal supplies live calls and plan updates. */
export function turnContent(turn: TranscriptTurn): TurnContent[] {
  type Activity =
    | Exclude<TurnContent, { type: "tools" }>
    | { type: "tool"; id: string; call: ToolCall };
  const activity: Activity[] = [];
  const callOrder = new Map<string, number>();
  const planOrder = new Map<string, number>();
  turn.events.forEach((event, index) => {
    if (event.type === "tool_call" || event.type === "memory" || event.type === "skill") {
      const id = event.toolCallId ?? `live-${event.runId}-${index}`;
      if (!callOrder.has(id)) callOrder.set(id, index);
    } else if (event.type === "delegation_plan" && !planOrder.has(event.planId)) {
      planOrder.set(event.planId, index);
    }
  });
  const position = (item: Activity) =>
    item.type === "tool"
      ? callOrder.get(item.id)
      : item.type === "delegation"
        ? (callOrder.get(item.plan.parentToolCallId) ?? planOrder.get(item.id))
        : undefined;
  // Insert missing live activity against known call anchors, including partial history pages.
  const add = (item: Activity, live: boolean) => {
    const order = position(item);
    const before =
      live && order !== undefined
        ? activity.findIndex((known) => {
            const next = position(known);
            return next !== undefined && next > order;
          })
        : -1;
    activity.splice(before < 0 ? activity.length : before, 0, item);
  };
  const plans = delegatedPlans(turn.events);
  const byCall = new Map(plans.map((plan) => [plan.parentToolCallId, plan]));
  const byPlan = new Map(plans.map((plan) => [plan.planId, plan]));
  const shownCalls = new Set<string>();
  const shownPlans = new Set<string>();
  const addPlan = (plan: DelegationPlanSnapshot, live = false) => {
    if (shownPlans.has(plan.planId)) return;
    shownPlans.add(plan.planId);
    add({ type: "delegation", id: plan.planId, plan }, live);
  };
  const addCall = (call: ToolCall, live = false) => {
    if (shownCalls.has(call.id)) return;
    shownCalls.add(call.id);
    const plan = byCall.get(call.id);
    if (plan) return addPlan(plan, live);
    add({ type: "tool", id: call.id, call }, live);
  };
  // A final answer stays after activity that has arrived before the history refresh.
  const last = turn.messages.at(-1);
  const finalReply = last?.text && !last.toolCalls?.length ? last : undefined;
  for (const message of turn.messages) {
    for (const call of message.toolCalls ?? []) addCall(call);
    if (message.text && message !== finalReply)
      activity.push({ type: "text", id: message.id, text: message.text });
  }
  const live = new Map(liveCalls(turn).map((call) => [call.id, call]));
  turn.events.forEach((event, index) => {
    if (event.type === "tool_call" || event.type === "memory" || event.type === "skill") {
      const id = event.toolCallId ?? `live-${event.runId}-${index}`;
      const call = live.get(id);
      if (call) addCall(call, true);
    } else if (event.type === "delegation_plan") {
      // The parent tool call anchors the card; snapshots update it without moving it.
      addPlan(byPlan.get(event.planId)!, true);
    }
  });
  for (const plan of plans) addPlan(plan, true);
  if (finalReply) activity.push({ type: "text", id: finalReply.id, text: finalReply.text });
  const content: TurnContent[] = [];
  for (const item of activity) {
    if (item.type !== "tool") {
      content.push(item);
      continue;
    }
    const previous = content.at(-1);
    if (previous?.type === "tools") previous.calls.push(item.call);
    else content.push({ type: "tools", id: item.id, calls: [item.call] });
  }
  return content;
}
