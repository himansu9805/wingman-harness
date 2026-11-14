import type { SandboxMonitor } from "../capabilities/execution/sandbox/sandbox-monitor";
import { DelegationCoordinator } from "../delegation/coordinator";
import type { McpConnections } from "../integrations/mcp/client";
import type { CheckpointStore } from "../integrations/postgres/checkpointer";
import type { SkillMeta } from "../skills/catalogue";
import type { AgentConfiguration, AgentModels } from "./configuration";
import { AgentToolCatalogue } from "../agents/catalogue";
import { AgentRegistry } from "../agents/registry";
import { DelegationRunner } from "../delegation/runner";
import { createDelegationTool } from "../delegation/tool";
import type { DelegationStore } from "../delegation/storage/store";
import type { ExecutionResources } from "../agents/module";

import { defaultDependencies, type RuntimeDependencies } from "./dependencies";

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
  readonly sandboxMonitor?: SandboxMonitor;
  readonly delegations: DelegationRunner;
  readonly plans: DelegationCoordinator;
  private readonly executionResources: readonly ExecutionResources[];
  private readonly prepareModule?: (id: string) => Promise<void>;

  private constructor(
    private readonly dependencies: RuntimeDependencies,
    readonly mcp: McpConnections,
    readonly skills: readonly SkillMeta[],
    private readonly checkpoints: CheckpointStore,
    configuration: AgentConfiguration,
    private readonly delegationStore: DelegationStore,
  ) {
    this.sandboxMonitor = configuration.sandboxMonitor;
    this.executionResources = configuration.executionResources ?? [];
    this.prepareModule = configuration.prepareAgent;
    const ids = new Set<string>();
    for (const definition of configuration.definitions) {
      if (ids.has(definition.id)) throw new Error(`Agent "${definition.id}" is already registered`);
      ids.add(definition.id);
    }
    const agentTools = { ...configuration.agentTools };
    for (const definition of configuration.definitions) {
      if (!definition.delegation?.agents.length) continue;
      const targets = configuration.definitions
        .filter((target) => definition.delegation.agents.includes(target.id))
        .map((target) => ({
          ...target,
          description: target.capabilities.useGlobalTools?.includes("exec_bash_command")
            ? `${target.description} Sandbox shell scripts, heredocs and redirection are supported with approval.`
            : target.description,
        }));
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
    this.agents.get("orchestrator");
    this.delegations = new DelegationRunner(
      this.agents,
      delegationStore,
      async (id, middleware) => {
        const { Agent } = await import("../agents/agent");
        return Agent.create(this, id, [middleware]);
      },
      async (id) => {
        if (!checkpoints.saver.deleteThread)
          throw new Error("Checkpointer cannot delete delegated state");
        await checkpoints.saver.deleteThread(id);
      },
      (id) => this.releaseExecution(id),
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
    let executionResources: readonly ExecutionResources[] = [];

    try {
      // Acquire sequentially so cleanup cannot race pending initialization.
      mcp = await dependencies.openMcp();
      const skills = Object.freeze(
        (await dependencies.loadSkills()).map((skill) => Object.freeze({ ...skill })),
      );
      const configuration = await dependencies.loadConfiguration(skills, mcp);
      executionResources = configuration.executionResources ?? [];
      checkpoints = await dependencies.openCheckpointer();
      delegations = await dependencies.openDelegations();
      await delegations.init();

      return new CoreRuntime(dependencies, mcp, skills, checkpoints, configuration, delegations);
    } catch (error) {
      try {
        await releaseResources(
          dependencies,
          checkpoints,
          mcp,
          delegations,
          undefined,
          undefined,
          executionResources,
        );
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

  /** Prepare only the requested role's external capabilities before graph execution. */
  async prepareAgent(id: string): Promise<void> {
    this.assertOpen();
    await this.prepareModule?.(id);
    this.assertOpen();
  }

  /** Shared conversation saver; callers must use distinct IDs for isolation. */
  get checkpointer() {
    this.assertOpen();
    return this.checkpoints.saver;
  }

  /** Release only capabilities belonging to this checkpoint execution. */
  async releaseExecution(threadId: string): Promise<void> {
    const outcomes = await Promise.allSettled(
      this.executionResources.map((resource) => resource.release(threadId)),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Execution resource cleanup failed");
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
      this.executionResources,
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
  executionResources: readonly ExecutionResources[] = [],
): Promise<void> {
  const errors: unknown[] = [];

  // Drain the scheduler before closing services its handlers may still use.
  const cleanupSteps = [
    () => dependencies.stopScheduler(),
    () => plans?.close(),
    () => runner?.close(),
    ...executionResources.map((resource) => () => resource.close()),
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
