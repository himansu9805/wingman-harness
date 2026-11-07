import type { StructuredToolInterface } from "@langchain/core/tools";
import type { CheckpointStore } from "./checkpointer";

/** Infrastructure operations supplied by production adapters or test fixtures. */
export interface RuntimeDependencies {
  loadTools(): Promise<StructuredToolInterface[]>;
  loadSkills(): Promise<string>;
  openCheckpointer(): Promise<CheckpointStore>;
  getMemoryIndex(): Promise<string>;
  stopScheduler(): Promise<void>;
  closeResults(): Promise<void>;
  closeTools(): Promise<void>;
  closeMemory(): Promise<void>;
}

const defaultDependencies: RuntimeDependencies = {
  async loadTools() {
    const { loadMcpTools } = await import("../mcp/mcp");
    return loadMcpTools();
  },
  async loadSkills() {
    const { renderSkillIndex } = await import("../skills/skills");
    return renderSkillIndex();
  },
  async openCheckpointer() {
    const { createCheckpointer } = await import("./checkpointer");
    return createCheckpointer();
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
  async closeTools() {
    const { closeMcpTools } = await import("../mcp/mcp");
    await closeMcpTools();
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

  private constructor(
    private readonly dependencies: RuntimeDependencies,
    readonly mcpTools: StructuredToolInterface[],
    readonly skillIndex: string,
    private readonly checkpoints: CheckpointStore,
  ) {}

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

    try {
      // Acquire sequentially so cleanup cannot race pending initialization.
      const tools = await dependencies.loadTools();
      const skillIndex = await dependencies.loadSkills();
      checkpoints = await dependencies.openCheckpointer();

      return new CoreRuntime(dependencies, tools, skillIndex, checkpoints);
    } catch (error) {
      try {
        await releaseResources(dependencies, checkpoints);
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
    ).finally(() => {
      this.closed = true;
    }));
  }
}

/** Preserves dependency order while collecting failures from every cleanup. */
async function releaseResources(
  dependencies: RuntimeDependencies,
  checkpoints?: CheckpointStore,
): Promise<void> {
  const errors: unknown[] = [];

  // Drain the scheduler before closing services its handlers may still use.
  const cleanupSteps = [
    () => dependencies.stopScheduler(),
    () => dependencies.closeResults(),
    () => dependencies.closeTools(),
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
