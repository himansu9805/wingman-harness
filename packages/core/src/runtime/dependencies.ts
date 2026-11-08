import type { McpConnections } from "../integrations/mcp/client";
import type { CheckpointStore } from "../integrations/postgres/checkpointer";
import type { SkillMeta } from "../skills/catalogue";
import type { AgentConfiguration } from "./configuration";
import type { DelegationStore } from "../delegation/storage/store";

/** Infrastructure operations supplied by production adapters or test fixtures. */
export interface RuntimeDependencies {
  openMcp(): Promise<McpConnections>;
  loadSkills(): Promise<readonly SkillMeta[]>;
  loadConfiguration(skills: readonly SkillMeta[], mcp: McpConnections): Promise<AgentConfiguration>;
  readSkill(skill: SkillMeta): Promise<string>;
  openCheckpointer(): Promise<CheckpointStore>;
  openDelegations(): Promise<DelegationStore>;
  getMemoryIndex(): Promise<string>;
  stopScheduler(): Promise<void>;
  closeResults(): Promise<void>;
  closeMemory(): Promise<void>;
}

export const defaultDependencies: RuntimeDependencies = {
  async openMcp() {
    const { openMcpConnections } = await import("../integrations/mcp/client");
    const { settings } = await import("../settings");
    return openMcpConnections(settings.MCP_CONFIG_PATH);
  },
  async loadSkills() {
    const { listSkills } = await import("../skills/catalogue");
    return listSkills();
  },
  async loadConfiguration(skills, mcp) {
    const { loadAgentConfiguration } = await import("./configuration");
    return loadAgentConfiguration(skills, mcp);
  },
  async readSkill(skill) {
    const { loadSkillContent } = await import("../skills/catalogue");
    return loadSkillContent(skill);
  },
  async openCheckpointer() {
    const { createCheckpointer } = await import("../integrations/postgres/checkpointer");
    return createCheckpointer();
  },
  async openDelegations() {
    const { settings } = await import("../settings");
    if (settings.POSTGRES_CONNECTION_STRING) {
      const { PostgresDelegationStore } = await import("../delegation/storage/postgres");
      return new PostgresDelegationStore(settings.POSTGRES_CONNECTION_STRING);
    }
    const { MemoryDelegationStore } = await import("../delegation/storage/store");
    return new MemoryDelegationStore();
  },
  async getMemoryIndex() {
    const { GraphMemory } = await import("../memory/graph");
    return GraphMemory.getInstance().getMemoryIndex();
  },
  async stopScheduler() {
    const { closeScheduler } = await import("../scheduler/scheduler");
    await closeScheduler();
  },
  async closeResults() {
    const { closeResults } = await import("../scheduler/results");
    await closeResults();
  },
  async closeMemory() {
    const { GraphMemory } = await import("../memory/graph");
    await GraphMemory.closeInstance();
  },
};
