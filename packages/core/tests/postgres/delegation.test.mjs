import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresDelegationStore } from "../../src/delegation/storage/postgres.ts";
import { createDelegationRuntime } from "../../../../tests/fixtures/delegation-runtime.mjs";
import {
  startTurn,
  runTurn,
  getPendingApprovals,
  resumeTurn,
} from "../../src/conversations/turn.ts";
import { deleteThreadState } from "../../src/conversations/history.ts";

const connectionString = process.env.TEST_POSTGRES_CONNECTION_STRING;
if (!connectionString)
  throw new Error("Set TEST_POSTGRES_CONNECTION_STRING for Postgres delegation tests");

test(
  "Postgres survives reconnection, atomically claims work, reuses results and deletes child state",
  { timeout: 30000 },
  async (t) => {
    const schema = `delegation_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
    const resources = [];
    t.after(async () => {
      try {
        for (const close of resources.reverse()) await close();
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(connectionString);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const open = async (child, args, plan) => {
      const pool = new pg.Pool({ connectionString: url.toString() });
      const saver = new PostgresSaver(pool, undefined, { schema });
      await saver.setup();
      const store = new PostgresDelegationStore(url.toString());
      let closed = false;
      const f = await createDelegationRuntime({
        store,
        saver,
        ...(child ? { child } : {}),
        ...(args ? { args } : {}),
        ...(plan ? { plan } : {}),
      });
      const close = async () => {
        if (closed) return;
        closed = true;
        try {
          await f.runtime.close();
        } finally {
          await pool.end();
        }
      };
      resources.push(close);
      return { ...f, close };
    };
    const first = await open();
    await startTurn(first.agent, "delegate", "durable-chat", {
      signal: AbortSignal.timeout(10000),
    });
    const [original] = await first.store.listConversation("durable-chat");
    assert.equal(original.status, "completed");
    assert.equal(original.usage[0].usage.totalTokens, 7);
    await first.close();

    const second = await open(async () => {
      throw new Error("Completed child must not run again");
    });
    assert.deepEqual((await second.store.listConversation("durable-chat"))[0], original);
    let pending;
    for await (const state of second.agent.app.graph.getStateHistory({
      configurable: { thread_id: "durable-chat" },
    })) {
      if (state.next.includes("tools")) {
        pending = state;
        break;
      }
    }
    assert.ok(pending);
    await second.agent.app.graph.updateState(pending.config, {}, "model_request");
    const events = [];
    const usage = [];
    await runTurn(second.agent, null, "durable-chat", {
      signal: AbortSignal.timeout(10000),
      onEvent: async (event) => events.push(event),
      onModelUsage: async (counts) => usage.push(counts),
    });
    assert.deepEqual(
      events.filter((event) => event.type === "delegation").map((event) => event.phase),
      [],
    );
    assert.equal(second.trace.calls.filter((call) => call.child).length, 0);
    assert.equal(usage.length, 1);

    const competitor = new PostgresDelegationStore(url.toString());
    resources.push(() => competitor.close());
    await competitor.init();
    const request = original.request;
    const identity = {
      conversationId: "atomic-chat",
      parentExecutionId: "same-turn",
      parentToolCallId: "same-call",
    };
    const input = {
      ...identity,
      parentAgentId: "orchestrator",
      request,
      requestHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    };
    const claims = await Promise.all([second.store.claim(input), competitor.claim(input)]);
    assert.equal(claims.filter((claim) => claim.created).length, 1);
    assert.equal(claims[0].task.taskId, claims[1].task.taskId);
    await second.store.update(claims[0].task.taskId, (task) => ({
      ...task,
      attempt: 1,
      leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
    }));
    await assert.rejects(
      second.runtime.delegations.run("orchestrator", request, identity, { emit() {} }),
      /owned by another/,
    );
    await assert.rejects(
      second.runtime.delegations.run(
        "orchestrator",
        request,
        { ...identity, parentToolCallId: "another-call" },
        { emit() {} },
      ),
      /Only one/,
    );
    await assert.rejects(
      second.runtime.delegations.run("orchestrator", { ...request, context: "changed" }, identity, {
        emit() {},
      }),
      /different task data/,
    );
    await assert.rejects(
      second.store.update(original.taskId, (task) => ({ ...task, status: "running" })),
      /immutable/,
    );

    await deleteThreadState(second.agent, "durable-chat");
    assert.deepEqual(await second.store.listConversation("durable-chat"), []);
    assert.equal(
      await second.saver.getTuple({ configurable: { thread_id: original.checkpointThreadId } }),
      undefined,
    );
    assert.equal((await competitor.listConversation("atomic-chat")).length, 1);

    const { ToolMessage } = await import("@langchain/core/messages");
    const worker = async (messages) => {
      const result = messages.find(ToolMessage.isInstance);
      return result
        ? result.text
        : [
            {
              id: "worker-uptime",
              name: "exec_bash_command",
              args: { command: "uptime" },
              type: "tool_call",
            },
          ];
    };
    const args = { agentId: "coder", objective: "Check uptime", context: "" };
    const pausedRuntime = await open(worker, args);
    assert.equal(
      (
        await startTurn(pausedRuntime.agent, "delegate", "paused-chat", {
          signal: AbortSignal.timeout(10000),
        })
      ).kind,
      "paused",
    );
    const approvals = await getPendingApprovals(pausedRuntime.agent, "paused-chat");
    const [paused] = await pausedRuntime.store.listConversation("paused-chat");
    await pausedRuntime.close();
    const resumedRuntime = await open(worker, args);
    assert.deepEqual(await getPendingApprovals(resumedRuntime.agent, "paused-chat"), approvals);
    const result = await resumeTurn(
      resumedRuntime.agent,
      { [approvals[0].id]: true },
      "paused-chat",
      { signal: AbortSignal.timeout(10000) },
    );
    assert.equal(result.kind, "done");
    assert.match(result.text, /exit_code/);
    const completed = await resumedRuntime.store.get(paused.taskId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.modelCalls, 2);
    assert.equal(completed.tools[0].status, "completed");
    assert.ok(completed.tools[0].result);
    assert.equal(completed.tools[0].requestedUrl, null);

    // Row locking allows exactly one owner to transition an approval batch.
    const contestInput = {
      ...input,
      conversationId: "resume-race",
      parentExecutionId: "resume-turn",
    };
    const { task: contest } = await competitor.claim(contestInput);
    const waiting = await competitor.update(contest.taskId, (task) => ({
      ...task,
      status: "waiting_approval",
      pendingApprovals: paused.pendingApprovals,
    }));
    const acquire = (store) =>
      store.update(waiting.taskId, (task) => {
        if (task.version !== waiting.version || task.status !== "waiting_approval")
          throw new Error("Already claimed");
        return { ...task, status: "running", ownerToken: randomUUID() };
      });
    const owners = await Promise.allSettled([acquire(competitor), acquire(resumedRuntime.store)]);
    assert.equal(owners.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(owners.filter((result) => result.status === "rejected").length, 1);

    // Existing pre-release records gain ownership/budget fields; old running work
    // is quarantined instead of being treated as a fresh task after migration.
    const legacy = Object.fromEntries(
      [
        "taskId",
        "conversationId",
        "parentExecutionId",
        "parentToolCallId",
        "checkpointThreadId",
        "requestHash",
        "request",
        "status",
        "output",
        "truncated",
        "error",
        "startedAt",
        "finishedAt",
      ].map((key) => [key, original[key]]),
    );
    Object.assign(legacy, {
      taskId: randomUUID(),
      conversationId: "legacy-chat",
      status: "running",
      usage: original.usage.map((entry) => entry.usage),
    });
    await admin.query(
      `INSERT INTO "${schema}".delegated_tasks (id,conversation_id,parent_execution_id,data) VALUES ($1,$2,$3,$4::jsonb)`,
      [legacy.taskId, legacy.conversationId, legacy.parentExecutionId, JSON.stringify(legacy)],
    );
    await competitor.init();
    const migrated = await competitor.get(legacy.taskId);
    assert.equal(migrated.status, "recovery_required");
    // Historical records retain the original role identity after the rename.
    assert.equal(migrated.parentAgentId, "default");
    assert.equal(migrated.modelCalls, 1);
    assert.equal(migrated.usage[0].usage.totalTokens, 7);
    await competitor.init();
    assert.deepEqual(await competitor.get(legacy.taskId), migrated);

    const planRequest = {
      tasks: [
        {
          key: "research",
          agentId: "analyst",
          objective: "Research",
          context: "scoped",
          expectedResult: "Findings",
          dependsOn: [],
        },
        {
          key: "inspect",
          agentId: "coder",
          objective: "Inspect",
          context: "",
          expectedResult: "Command output",
          dependsOn: ["research"],
        },
        {
          key: "review",
          agentId: "analyst",
          objective: "Review",
          context: "",
          expectedResult: "Review",
          dependsOn: ["inspect"],
        },
      ],
    };
    const { HumanMessage } = await import("@langchain/core/messages");
    const plannedWorker = async (messages) => {
      const input = JSON.parse(
        messages.find(HumanMessage.isInstance).text.split("\n").slice(1).join("\n"),
      );
      if (input.agentId === "analyst")
        return input.objective.startsWith("Research") ? "Saved research" : "Saved review";
      const result = messages.find(ToolMessage.isInstance);
      return result
        ? "Command declined"
        : [
            {
              id: "plan-uptime",
              name: "exec_bash_command",
              args: { command: "uptime" },
              type: "tool_call",
            },
          ];
    };
    const planned = await open(plannedWorker, undefined, planRequest);
    const observed = [];
    const pausedPlanResult = await startTurn(planned.agent, "delegate", "durable-plan", {
      onEvent: async (event) => observed.push(event),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(pausedPlanResult.kind, "paused");
    const [pausedPlan] = await planned.store.listPlans("durable-plan");
    assert.deepEqual(
      pausedPlan.results.map((result) => result.status),
      ["completed", "waiting_approval", "pending"],
    );
    await planned.close();
    const reopened = await open(plannedWorker, undefined, planRequest);
    assert.deepEqual(
      await getPendingApprovals(reopened.agent, "durable-plan"),
      pausedPlanResult.approvals,
    );
    const finalPlanResult = await resumeTurn(
      reopened.agent,
      { [pausedPlanResult.approvals[0].id]: false },
      "durable-plan",
      { signal: AbortSignal.timeout(10000), onEvent: async (event) => observed.push(event) },
    );
    const snapshots = observed.filter((event) => event.type === "delegation_plan");
    assert.equal(snapshots.at(-1).planId, pausedPlan.planId);
    assert.equal(snapshots.at(-1).status, "completed");
    assert(snapshots.at(-1).tasks.some((task) => task.observations.length > 0));
    assert.equal(
      snapshots.at(-1).tasks.reduce((sum, task) => sum + task.usage.modelCalls, 0),
      4,
    );
    assert.deepEqual(
      snapshots
        .at(-1)
        .tasks.find((task) => task.key === "inspect")
        .decisions.map((item) => item.approved),
      [false],
    );
    assert.equal(finalPlanResult.kind, "done");
    const finalPlan = await reopened.store.getPlan(pausedPlan.planId);
    assert.equal(finalPlan.status, "completed");
    assert.deepEqual(
      finalPlan.results.map((result) => result.key),
      ["research", "inspect", "review"],
    );
    assert.equal(reopened.trace.calls.filter((call) => call.child).length, 2);
    assert.equal((await reopened.store.listPlanTasks(finalPlan.planId)).length, 3);
    await assert.rejects(
      reopened.store.updatePlan(finalPlan.planId, (plan) => ({ ...plan, status: "running" })),
      /immutable/,
    );
    const planInput = {
      parentAgentId: "orchestrator",
      conversationId: "plan-claim",
      parentExecutionId: "plan-user",
      parentToolCallId: "plan-call",
      request: planRequest,
      requestHash: "hash",
      schedulerThreadId: null,
    };
    const planClaims = await Promise.all([
      competitor.claimPlan(planInput),
      reopened.store.claimPlan(planInput),
    ]);
    assert.equal(planClaims.filter((claim) => claim.created).length, 1);
    assert.equal(planClaims[0].plan.planId, planClaims[1].plan.planId);
    const planSnapshot = planClaims[0].plan;
    const acquirePlan = (store) =>
      store.updatePlan(planSnapshot.planId, (current) => {
        if (current.version !== planSnapshot.version) throw new Error("Plan already claimed");
        return { ...current, ownerToken: randomUUID() };
      });
    const planOwners = await Promise.allSettled([
      acquirePlan(competitor),
      acquirePlan(reopened.store),
    ]);
    assert.equal(planOwners.filter((result) => result.status === "fulfilled").length, 1);
    await deleteThreadState(reopened.agent, "durable-plan");
    assert.deepEqual(await reopened.store.listPlans("durable-plan"), []);
    assert.deepEqual(await reopened.store.listPlanTasks(finalPlan.planId), []);
  },
);
