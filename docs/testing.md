# Automated tests

Run the default, service-free suites from the repository root:

```bash
npm test
```

The root command builds core (including its exported types), runs the core and
CLI suites, compiles the server with SWC, and runs HTTP integration tests against
that compiled server. No additional dependencies are needed: tests use
Node's built-in `node:test`, assertions, `fetch`, and the existing `tsx` loader.

The default suites do not need `.env`, API keys, model endpoints, Postgres, LadybugDB or MCP
servers. HTTP tests listen on temporary loopback ports; allow localhost socket
access when running them inside a sandbox.

## Suites

| File | Coverage |
| --- | --- |
| `packages/core/tests/bash.test.ts` | Argument parsing, quoted literals, unsupported shell syntax, allow/deny/ask rules, exact and prefix matching |
| `packages/core/tests/turn.test.mjs` | Event mapping, final answers, parallel and repeated interrupts, id-keyed decisions, cleanup, error and cancellation propagation |
| `packages/core/tests/approval.test.mjs` | Real LangChain agent and LangGraph interrupts with `MemorySaver`: no execution before approval, decline, parallel calls, successive pauses and thread isolation |
| `packages/core/tests/history.test.mjs` | User-visible history, stable IDs, matching tool results, bounded previews and checkpoint deletion |
| `apps/server/tests/thread.repository.test.mjs` | Thread metadata, first-message titles, keyset pagination and deletion markers in the test repository |
| `apps/cli/tests/route.test.mjs` | Routing probability percentages, zero confidence, tiny probabilities and older events without scores |
| `apps/server/tests/http.test.mjs` | Actual Nest controllers, dependency injection and token guard over HTTP: validation, SSE, approvals, explicit creation, list/history pagination, deletion retries, concurrency, cleanup, failures and disconnects |

`tests/fixtures/approval-agent.mjs` supplies a deterministic chat model and an
approval tool whose only side effect is appending to an in-memory array. The
actual agent tool loop and checkpointing still run. The fixture never invokes
the production shell tool or starts an external process.

## Running a focused suite

From the repository root:

```bash
node --import tsx --test packages/core/tests/bash.test.ts
node --import tsx --test packages/core/tests/turn.test.mjs
node --import tsx --test packages/core/tests/approval.test.mjs
node --import tsx --test apps/cli/tests/route.test.mjs
```

After building core at least once, run server tests with:

```bash
npm run test -w @wingman/server
```

Server tests import SWC-built files from `apps/server/dist`. Do not run server
TypeScript through `tsx`: Nest needs the decorator metadata emitted by SWC.

## Test isolation

- Turn helpers import tool names without constructing tools or their databases.
- `@wingman/core/turns` exposes turn operations without loading model settings or
  external resources. The server's injectable `AGENT_RUNTIME` owns agent
  creation and shutdown; HTTP tests substitute this runtime and the catalogue repository. Existing scenario fixtures explicitly seed their named threads; tests of the public flow create threads through the API.
- Each graph fixture gets a new in-memory checkpointer and execution log.
- Each HTTP test gets its own Nest app on a port allocated by the operating system.
- Tests restore the token environment variable and close the app after each case.
- Concurrent-request tests use explicit gates rather than sleeps. Requests and
  gates have deadlines, so failures cannot leave the suite waiting indefinitely.

## Regression fixes covered by these tests

The initial failing tests exposed two mismatches with documented behaviour:

1. The command parser preserved bracket globs and some command-substitution
   syntax as literal arguments. It now rejects these forms consistently while
   preserving escaped or single-quoted literal text. Execution still uses
   `execFile`, without a shell.
2. Cleaning up an abandoned approval stopped after one resume, even if the
   model requested another approval. Cleanup now declines successive requests,
   respects cancellation and fails explicitly after 25 rounds rather than
   silently starting a new message on a paused thread.

## Postgres integration

A separate suite exercises a real Postgres repository and checkpointer. Set a
connection string for an accessible test database, then run:

```bash
TEST_POSTGRES_CONNECTION_STRING=postgres://user:password@localhost:5432/database npm run test:postgres
```

The suite creates a uniquely named schema and removes it afterward. It verifies
metadata and pending approvals after closing/reopening connections, resumed
history, SQL pagination, retryable deletion markers and checkpoint cleanup.
The database user needs permission to create schemas. This suite does not read
`.env` or start Docker for you, and fails explicitly if the test URL is absent.

## CI

The existing required **Build and type-check** job runs `npm ci`, builds all
workspaces, type-checks them, runs `npm test`, then runs `npm run test:postgres`
against a disposable Postgres 18 service. Any failing suite fails the
required job. Keep its job name stable because the main-branch ruleset uses it.

These tests cover deterministic application behaviour. Live-model quality, MCP connectivity and future browser flows need
separate evaluation suites; they are not prerequisites for
running this suite locally or in CI.
