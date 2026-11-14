import { Controller, Delete, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { AgentService } from "../agent/agent.service";
import { parse, ThreadId } from "../threads/schemas";

/** Manages Wingman-owned sandbox containers. */
@Controller("sandboxes")
export class SandboxesController {
  constructor(private readonly agent: AgentService) {}

  @Get()
  async list() {
    const monitor = this.agent.sandboxMonitor;
    return { enabled: Boolean(monitor), sandboxes: monitor ? await monitor.list() : [] };
  }

  @Post(":threadId/stop")
  async stop(@Param("threadId") rawId: string) {
    const monitor = this.agent.sandboxMonitor;
    if (!monitor || !(await monitor.stop(parse(ThreadId, rawId))))
      throw new NotFoundException("Sandbox not found");
    return { stopped: true };
  }

  @Delete(":threadId")
  async remove(@Param("threadId") rawId: string) {
    const monitor = this.agent.sandboxMonitor;
    if (!monitor) throw new NotFoundException("Sandbox monitoring is unavailable");
    await monitor.release(parse(ThreadId, rawId));
    return { removed: true };
  }
}
