import { DelegationCoordinator } from "./delegation/coordinator";
import type { McpConnections } from "../mcp/mcp";
import type { CheckpointStore } from "./checkpointer";
import type { SkillMeta } from "../skills/skills";
import type { AgentConfiguration, AgentModels } from "./agents/configuration";
import { AgentToolCatalogue } from "./agents/catalogue";
import { AgentRegistry } from "./agents/registry";
import { DelegationRunner } from "./delegation/runner";
import { createDelegationTool } from "./delegation/tool";
import type { DelegationStore } from "./delegation/store";

/** Infrastructure operations supplied by production adapters or test fixtures. */
export interface RuntimeDependencies {
  openMcp(): Promise<McpConnections>;
  loadSkills(): Promise<readonly SkillMeta[]>;
  loadConfiguration(skills: readonly SkillMeta[]): Promise<AgentConfiguration>;
  readSkill(skill: SkillMeta): Promise<string>;
  openCheckpointer(): Promise<CheckpointStore>;
  openDelegations(): Promise<DelegationStore>;
  getMemoryIndex(): Promise<string>;
  stopScheduler(): Promise<void>;
  closeResults(): Promise<void>;
  closeMemory(): Promise<void>;
}

const defaultDependencies: RuntimeDependencies = {
  async openMcp() {
    const { openMcpConnections } = await import("../mcp/mcp");
    const { settings } = await import("../settings");
    return openMcpConnections(settings.MCP_CONFIG_PATH);
  },
  async loadSkills() {
    const { listSkills } = await import("../skills/skills");
    return listSkills();
  },
  async loadConfiguration(skills) {
    const { loadAgentConfiguration } = await import("./agents/configuration");
    return loadAgentConfiguration(skills);
  },
  async readSkill(skill) {
    const { loadSkillContent } = await import("../skills/skills");
    return loadSkillContent(skill);
  },
  async openCheckpointer() {
    const { createCheckpointer } = await import("./checkpointer");
    return createCheckpointer();
  },
  async openDelegations() {
    const { settings } = await import("../settings");
    if (settings.POSTGRES_CONNECTION_STRING) {
      const { PostgresDelegationStore } = await import("./delegation/postgres-store");
      return new PostgresDelegationStore(settings.POSTGRES_CONNECTION_STRING);
    }
    const { MemoryDelegationStore } = await import("./delegation/store");
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

/**
 * Owns the services shared by all agent graphs in one application lifecycle.
 * Agents borrow these resources and must not close them independently.
 * The scheduler remains process-wide and is drained before other cleanup.
 */
export class CoreRuntime {
  private closing?: Promise<void>;
  private closed = false;
  readonly agents: AgentRegistry;
  readonly toolCatalogue: AgentToolCatalogue;
  readonly models: AgentModels;
  readonly delegations: DelegationRunner;
  readonly plans: DelegationCoordinator;

  private constructor(
    private readonly dependencies: RuntimeDependencies,
    readonly mcp: McpConnections,
    readonly skills: readonly SkillMeta[],
    private readonly checkpoints: CheckpointStore,
    configuration: AgentConfiguration,
    private readonly delegationStore: DelegationStore,
  ) {
    const ids = new Set<string>();
    for (const definition of configuration.definitions) {
      if (ids.has(definition.id)) throw new Error(`Agent "${definition.id}" is already registered`);
      ids.add(definition.id);
    }
    const agentTools = { ...configuration.agentTools };
    for (const definition of configuration.definitions) {
      if (!definition.delegation?.agents.length) continue;
      const targets = configuration.definitions.filter((target) =>
        definition.delegation.agents.includes(target.id),
      );
      agentTools[definition.id] = [
        ...(agentTools[definition.id] ?? []),
        createDelegationTool(
          (request, identity, invocation) =>
            this.plans.run(definition.id, request, identity, invocation),
          (taskId, answers, invocation) =>
            this.plans.resume(definition.id, taskId, answers, invocation),
          targets,
        ),
      ];
    }
    this.toolCatalogue = new AgentToolCatalogue(configuration.globalTools, agentTools);
    this.models = Object.freeze({ ...configuration.models });
    this.agents = new AgentRegistry({
      localTools: this.toolCatalogue.globalNames(),
      mcpServers: mcp.serverIds,
      skills: skills.map((skill) => skill.name),
      agents: Object.fromEntries(
        configuration.definitions.map((definition) => [
          definition.id,
          {
            tools: this.toolCatalogue.privateNames(definition.id),
            mcpServers: mcp.privateServerIds(definition.id),
          },
        ]),
      ),
    });
    for (const definition of configuration.definitions) this.agents.register(definition);
    // Every existing CLI/server entry point uses this agent unless given an ID.
    this.agents.get("default");
    this.delegations = new DelegationRunner(
      this.agents,
      delegationStore,
      async (id, middleware) => {
        const { Agent } = await import("./agent");
        return Agent.create(this, id, [middleware]);
      },
      async (id) => {
        if (!checkpoints.saver.deleteThread)
          throw new Error("Checkpointer cannot delete delegated state");
        await checkpoints.saver.deleteThread(id);
      },
    );
    this.delegations.validateTargets();
    this.plans = new DelegationCoordinator(
      this.agents,
      delegationStore,
      this.delegations,
      configuration.delegationConcurrency ?? 4,
    );
  }

  /**
   * Acquires infrastructure and releases acquired resources if startup fails.
   * Application entry points should use initializeRuntime() to share startup.
   *
   * @param dependencies Infrastructure adapters; custom adapters must have safe
   * cleanup methods even when their corresponding resource was never opened.
   * @throws The startup error, or an AggregateError if cleanup also fails.
   */
  static async create(
    dependencies: RuntimeDependencies = defaultDependencies,
  ): Promise<CoreRuntime> {
    let checkpoints: CheckpointStore | undefined;
    let mcp: McpConnections | undefined;
    let delegations: DelegationStore | undefined;

    try {
      // Acquire sequentially so cleanup cannot race pending initialization.
      mcp = await dependencies.openMcp();
      const skills = Object.freeze(
        (await dependencies.loadSkills()).map((skill) => Object.freeze({ ...skill })),
      );
      const configuration = await dependencies.loadConfiguration(skills);
      checkpoints = await dependencies.openCheckpointer();
      delegations = await dependencies.openDelegations();
      await delegations.init();

      return new CoreRuntime(dependencies, mcp, skills, checkpoints, configuration, delegations);
    } catch (error) {
      try {
        await releaseResources(dependencies, checkpoints, mcp, delegations);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Runtime initialization and cleanup failed",
        );
      }

      throw error;
    }
  }

  /** Rejects new graph construction once runtime shutdown has started. */
  assertOpen(): void {
    if (this.closing) {
      throw new Error("Agent runtime is closed");
    }
  }

  /** Shared conversation saver; callers must use distinct IDs for isolation. */
  get checkpointer() {
    this.assertOpen();
    return this.checkpoints.saver;
  }

  /**
   * Reads current memory, including during scheduler draining.
   * Access is rejected after cleanup settles, even if cleanup failed.
   */
  getMemoryIndex(): Promise<string> {
    // Scheduled turns may still read memory while the scheduler drains.
    if (this.closed) {
      throw new Error("Agent runtime is closed");
    }

    return this.dependencies.getMemoryIndex();
  }

  /** Reads only metadata from this runtime's snapshot of installed skills. */
  readSkill = (skill: SkillMeta): Promise<string> => {
    if (this.closed) throw new Error("Agent runtime is closed");
    const installed = this.skills.find(
      (candidate) => candidate.name === skill.name && candidate.path === skill.path,
    );
    if (!installed) throw new Error("Skill is not in the runtime catalogue");
    return this.dependencies.readSkill(installed);
  };

  /**
   * Drains the scheduler and attempts every remaining cleanup in order.
   * The caller must drain interactive turns first. Repeated calls return the
   * same promise, including its rejection; failed cleanup is not retried.
   *
   * @returns Completion of cleanup, rejecting with all collected failures.
   */
  close(): Promise<void> {
    return (this.closing ??= releaseResources(
      this.dependencies,
      this.checkpoints,
      this.mcp,
      this.delegationStore,
      this.delegations,
      this.plans,
    ).finally(() => {
      this.closed = true;
    }));
  }
}

/** Preserves dependency order while collecting failures from every cleanup. */
async function releaseResources(
  dependencies: RuntimeDependencies,
  checkpoints?: CheckpointStore,
  mcp?: McpConnections,
  delegations?: DelegationStore,
  runner?: DelegationRunner,
  plans?: DelegationCoordinator,
): Promise<void> {
  const errors: unknown[] = [];

  // Drain the scheduler before closing services its handlers may still use.
  const cleanupSteps = [
    () => dependencies.stopScheduler(),
    () => plans?.close(),
    () => runner?.close(),
    () => dependencies.closeResults(),
    () => delegations?.close(),
    () => mcp?.close(),
    () => checkpoints?.close(),
    () => dependencies.closeMemory(),
  ];

  for (const close of cleanupSteps) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "Runtime cleanup failed");
  }
}

let sharedRuntime: Promise<CoreRuntime> | undefined;
let closing: Promise<void> | undefined;

/**
 * Initializes one shared runtime per process, deduplicating concurrent callers.
 * Startup failures are retained; restarting requires a new process.
 * Calls after shutdown begins are rejected.
 */
export function initializeRuntime(): Promise<CoreRuntime> {
  if (closing) {
    return Promise.reject(new Error("Agent runtime is shutting down"));
  }

  return (sharedRuntime ??= CoreRuntime.create());
}

/**
 * Waits for pending startup and closes the shared runtime exactly once.
 * Does not initialize an unused runtime. Failed startup already owns cleanup.
 */
export function closeRuntime(): Promise<void> {
  return (closing ??= (async () => {
    // Failed initialization already cleans up its acquired resources.
    const runtime = await sharedRuntime?.catch(() => undefined);
    await runtime?.close();
  })());
}
