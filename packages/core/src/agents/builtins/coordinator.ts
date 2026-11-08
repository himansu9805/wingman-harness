import type { AgentDefinition } from "../definition";

/** Explicit baseline selections for the interactive agent; MCP access is opt-in. */
export function createDefaultAgentDefinition(schedulerEnabled = false): AgentDefinition {
  return {
    id: "default",
    description: "General-purpose Wingman assistant",
    instructions: "Help the user complete their request using the available capabilities.",
    model: "routed",
    delegation: {
      agents: ["analyst", "operator"],
      timeoutMs: 120000,
      maxModelCalls: 12,
      maxTasks: 8,
      maxConcurrency: 2,
    },
    capabilities: {
      useGlobalTools: [
        "load_skill",
        "remember",
        "recall_memory",
        "log_conversation",
        "exec_bash_command",
        ...(schedulerEnabled
          ? [
              "schedule_task",
              "schedule_recurring_task",
              "list_scheduled_tasks",
              "cancel_scheduled_task",
              "show_scheduled_task_runs",
            ]
          : []),
      ],
      tools: ["delegate_task"],
      useGlobalMcpServers: [],
      mcp: [],
      skills: "all",
      memory: "read-write",
    },
  };
}
