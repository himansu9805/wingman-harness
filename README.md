# Wingman Harness

A self-hosted AI agent harness that runs on your own machine and models.
Wingman gives a tool-calling agent a shell (with human approval), on-demand
skills, MCP servers, long-term graph memory and scheduled tasks, and lets you
use it from a terminal or over a streaming HTTP API.

![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white)
![License](https://img.shields.io/badge/license-ISC-blue)

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Using the CLI](#using-the-cli)
- [Using the HTTP API](#using-the-http-api)
- [Command approval](#command-approval)
- [Extending Wingman](#extending-wingman)
- [Project structure](#project-structure)
- [Development](#development)
- [Security](#security)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Bring your own models.** The chat models can be any OpenAI-compatible
  endpoint, such as [Ollama](https://ollama.com) running locally or OpenAI
  itself. A small classifier routes each turn to a fast or a strong model.
- **Shell access with human approval.** The agent can run commands on your
  machine. Safe commands run immediately, dangerous ones are blocked, and
  everything else pauses until you approve it.
- **Skills.** Markdown instructions under `skills/` that the agent loads only
  when a task needs them, so the prompt stays small.
- **MCP servers.** Point `mcp.config.json` at any
  [Model Context Protocol](https://modelcontextprotocol.io) server and its tools
  appear next to the built-in ones.
- **Long-term memory.** Facts about you, your projects and preferences are kept
  in an embedded graph database and shared across conversations.
- **Scheduled tasks.** "Remind me in 10 minutes…" and recurring jobs, backed by
  Postgres.
- **Durable conversations.** Threads and pending approvals are saved in Postgres
  and survive restarts.
- **Two ways in.** An interactive CLI, and a NestJS API that streams each turn
  as Server-Sent Events.

## Architecture

Wingman is an npm workspaces monorepo. All agent logic lives in
`@wingman/core`; the apps are thin front ends over it.

```mermaid
flowchart LR
    CLI["apps/cli<br/>terminal chat"] --> Core
    Server["apps/server<br/>NestJS + SSE"] --> Core
    Web["apps/web<br/>React (planned)"] -.-> Server

    subgraph Core["packages/core (@wingman/core)"]
        Agent["LangGraph agent<br/>+ model router"]
        Tools["Tools: shell, memory,<br/>scheduler, skills"]
        MCP["MCP tools"]
    end

    Agent --> Models["OpenAI-compatible<br/>models"]
    Core --> PG[("Postgres<br/>threads, jobs, runs")]
    Core --> Graph[("LadybugDB<br/>memory graph")]
```

Each turn runs a [LangGraph](https://langchain-ai.github.io/langgraphjs/) agent
loop: the model thinks, calls tools, reads the results, and repeats until it
has an answer. Conversation state is checkpointed after every step, which is
what lets a turn pause for approval and resume later, even after a restart.

## Quick start

### Prerequisites

- **Node.js 22.12 or newer** (developed on Node 25). The server is CommonJS and
  loads the ES module core with `require()`, which needs a recent Node.
- **An OpenAI-compatible model endpoint** for the chat models. For a fully
  local setup, install [Ollama](https://ollama.com) and pull a tool-calling
  model.
- **A TypeSafe-compatible classifier endpoint** for routing. See
  [Models](#models).
- **PostgreSQL** (optional for the CLI, recommended for the server). Without it,
  conversations are kept in memory only and scheduling is unavailable.

### Install

```bash
git clone https://github.com/himansu9805/wingman-harness.git
cd wingman-harness
npm install
```

### Configure

Create a `.env` file in the repository root. A minimal local setup with Ollama:

```bash
# Routes each turn to the fast or strong model (TypeSafe classification API)
DECISIONS_MODEL_BASE_URL=<classifier-url>
DECISIONS_MODEL_NAME=<classifier-model>
DECISIONS_MODEL_API_KEY=<classifier-api-key>

# Simple requests: chat, maths, definitions
FAST_MODEL_BASE_URL=http://localhost:11434/v1
FAST_MODEL_NAME=<fast-model>

# Tool use and multi-step work
STRONG_MODEL_BASE_URL=http://localhost:11434/v1
STRONG_MODEL_NAME=<strong-model>

# Durable threads and scheduling (optional)
POSTGRES_CONNECTION_STRING=postgres://user:password@localhost:5432/wingman
SCHEDULER_ENABLED=false

# Required by the HTTP server
WINGMAN_API_TOKEN=<long-random-string>
```

See [Configuration](#configuration) for every option.

### Run

```bash
npm run dev:cli      # interactive terminal chat
npm run dev:server   # HTTP API on http://127.0.0.1:3000
```

## Configuration

All settings are read from `.env` in the repository root, or from the process
environment.

### Models

The fast and strong models are reached through the OpenAI Chat Completions
API, so any compatible server works; include the `/v1` path in their base URLs
(for Ollama, `http://localhost:11434/v1`). Leave `STRONG_MODEL_BASE_URL` empty
to use OpenAI's own endpoint for the strong model.

The router uses [`@langchain/typesafe`](https://www.npmjs.com/package/@langchain/typesafe),
which calls a TypeSafe classification API at `<DECISIONS_MODEL_BASE_URL>/v1/systemone`.
Its base URL therefore has no `/v1` suffix.

| Variable | Required | Description |
| --- | --- | --- |
| `DECISIONS_MODEL_BASE_URL` | Yes | Base URL of the TypeSafe-compatible classifier, without `/v1`. |
| `DECISIONS_MODEL_NAME` | Yes | Classifier model that picks fast or strong for each turn. |
| `DECISIONS_MODEL_API_KEY` | Yes | API key for the classifier. |
| `FAST_MODEL_BASE_URL` | Yes | Endpoint of the fast model. |
| `FAST_MODEL_NAME` | Yes | Model for simple requests. |
| `FAST_MODEL_API_KEY` | No | API key for the fast model. |
| `STRONG_MODEL_BASE_URL` | No | Endpoint of the strong model. Empty means OpenAI. |
| `STRONG_MODEL_NAME` | Yes | Model for tool use and multi-step tasks. |
| `STRONG_MODEL_API_KEY` | No | API key for the strong model. |

### Storage and scheduling

| Variable | Required | Description |
| --- | --- | --- |
| `POSTGRES_CONNECTION_STRING` | When scheduling | Enables durable threads. Tables are created automatically on first start. |
| `SCHEDULER_ENABLED` | No | `true` to enable scheduled tasks. Requires Postgres. Enable it in only one running app at a time. |
| `WINGMAN_HOME` | No | Directory holding `.env`, `skills/`, `mcp.config.json` and `memory.lbug`. Defaults to the repository root. |

### HTTP server

| Variable | Required | Description |
| --- | --- | --- |
| `WINGMAN_API_TOKEN` | Yes | Bearer token every request must send. The server refuses to start without it. |
| `PORT` | No | Port to listen on. Defaults to `3000`. |
| `WEB_ORIGIN` | No | Origin allowed by CORS. Defaults to `http://localhost:5173`. |

## Using the CLI

```bash
npm run dev:cli
```

Each CLI session starts a new conversation. While the agent works, the CLI
shows what it is doing:

| Indicator | Meaning |
| --- | --- |
| 🧭 | Which model the router picked, and its confidence |
| 🔧 | A tool call, with its arguments |
| 📘 | A skill being loaded |
| 🧠 | A memory tool being used |
| ⏰ | A scheduled task firing |

Things to try:

- `run df -h and tell me how full my disk is`: approve the command when asked
- `write me a haiku about the monsoon`: loads the `haiku-writer` skill
- `remember that I work on Wingman Harness`, then `what do you know about me?`
- `remind me in 2 minutes to stretch` (needs `SCHEDULER_ENABLED=true`)

Press **Ctrl+C** to cancel a running turn, and type `/exit` or press Ctrl+C at
the prompt to quit.

## Using the HTTP API

```bash
npm run dev:server
```

The server listens on `127.0.0.1` only. Every request needs the header
`Authorization: Bearer <WINGMAN_API_TOKEN>`.

### Endpoints

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /threads/:threadId/messages` | `{ "message": string }` | SSE stream of the turn |
| `POST /threads/:threadId/resume` | `{ "answers": { [approvalId]: boolean } }` | SSE stream of the rest of the turn |
| `GET /threads/:threadId/pending` | — | `[{ "id", "command" }]` approvals the thread is waiting on |

Thread ids are chosen by the client: 1–64 characters of letters, digits, `_`
or `-`. A new id starts a new conversation.

### Stream events

| Event | Data | Meaning |
| --- | --- | --- |
| `route` | `{ choice, confidence }` | The router picked `fast` or `powerful`. |
| `tool_call` | `{ name, args }` | The agent called a tool. |
| `skill` | `{ name }` | The agent loaded a skill. |
| `memory` | `{ name, args }` | The agent used a memory tool. |
| `approval` | `{ approvals: [{ id, command }] }` | The turn is paused until you call `resume`. Last event. |
| `done` | `{ text }` | The agent's final reply. Last event. |
| `error` | `{ message }` | The turn failed after streaming started. Last event. |

### Status codes

| Code | When |
| --- | --- |
| `400` | Invalid body or thread id, or `resume` answers that don't match the pending approvals |
| `403` | Missing or wrong token |
| `409` | A turn is already running on the thread, or `resume` was called with nothing pending |

### Example

```bash
curl -N http://127.0.0.1:3000/threads/demo/messages \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "run uptime"}'
```

```text
event: route
data: {"type":"route","choice":"powerful","confidence":0.54}

event: tool_call
data: {"type":"tool_call","name":"exec_bash_command","args":{"command":"uptime"}}

event: approval
data: {"approvals":[{"id":"3f332c5b18d1cacb8391e4722dd64e54","command":"uptime"}]}
```

```bash
curl -N http://127.0.0.1:3000/threads/demo/resume \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"answers": {"3f332c5b18d1cacb8391e4722dd64e54": true}}'
```

```text
event: done
data: {"text":"System uptime: 6 hours 38 minutes. Load averages: 1.80, 11.13, 17.32."}
```

A ready-made [Bruno](https://www.usebruno.com) collection lives in
[`apps/server/bruno`](apps/server/bruno). Open it, choose the `local`
environment and set the `token` secret.

## Command approval

The shell tool, `exec_bash_command`, checks every command before it runs:

| Verdict | Examples | What happens |
| --- | --- | --- |
| Allow | `pwd`, `ls …`, `git status`, `git log …`, `docker ps` | Runs immediately. |
| Deny | `rm …`, `sudo …`, `kill …`, `shutdown …` | Blocked. Never runs. |
| Ask | Everything else | The turn pauses until you approve or decline. |

Commands that use shell syntax (pipes, `;`, `&&`, `$()`, redirects or
wildcards) are rejected, so each command can be checked on its own. The rules
live in [`packages/core/src/tools/bash.ts`](packages/core/src/tools/bash.ts).

When a command needs approval, the tool calls LangGraph's `interrupt()`. The
run stops and its state is saved:

- **CLI:** asks `Execute command: "…"? [y/N]` and resumes with your answer.
- **HTTP API:** ends the stream with an `approval` event. Call `resume` with an
  answer for each approval id, whenever you like.
- **Scheduled tasks:** decline automatically, because nobody may be watching.

If you send a new message while an approval is still waiting, the old command
is declined first, so the conversation stays consistent.

## Extending Wingman

### Skills

A skill is a folder under `skills/` containing a `SKILL.md` file with YAML
frontmatter:

```markdown
---
name: haiku-writer
description: Write a haiku about a given topic in strict 5-7-5 form. Use when the user asks for a haiku.
---

# Haiku Writer

Detailed instructions the agent follows once the skill is loaded...
```

The agent sees only each skill's `name` and `description` up front, and calls
`load_skill` to read the full instructions when a task matches.

### MCP servers

Add servers to `mcp.config.json` in the repository root:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--headless"]
    }
  }
}
```

Their tools are loaded at startup and offered to the agent alongside the
built-in ones.

### Memory

Long-term memory is stored in `memory.lbug`, a
[LadybugDB](https://ladybugdb.com) embedded graph of entities (people,
projects, topics, facts) and the relationships between them. It is global:
something remembered in one conversation is available in all of them. The agent
manages it with the `remember`, `recall_memory` and `log_conversation` tools.

To inspect it, install the
[Ladybug CLI](https://docs.ladybugdb.com/client-apis/cli) and query it with
Cypher:

```bash
lbug memory.lbug -r
```

```cypher
MATCH (e:Entity) RETURN e.name, e.type, e.notes;
MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) RETURN a.name, r.relation, b.name;
```

> **Note:** if the process is killed uncleanly (for example `kill -9`), the
> next start may report `memory.lbug.wal does not match the current database`.
> Delete `memory.lbug.wal` and restart; only the last uncommitted write is lost.

### Scheduled tasks

With `SCHEDULER_ENABLED=true`, the agent gains `schedule_task`,
`schedule_recurring_task`, `list_scheduled_tasks`, `cancel_scheduled_task` and
`show_scheduled_task_runs`. Jobs are stored in Postgres with
[Agenda](https://github.com/agenda/agenda), and every run is recorded in the
`task_runs` table. Scheduled tasks currently run in the CLI.

## Project structure

```text
wingman-harness/
├── packages/
│   └── core/                 @wingman/core: agent, tools, memory, scheduler
│       └── src/
│           ├── core/         agent graph, model router, prompt, turns, checkpointer
│           ├── tools/        shell, memory, scheduler and skill tools
│           ├── mcp/          MCP client
│           ├── memory/       LadybugDB graph memory
│           ├── scheduler/    Agenda jobs and run history
│           └── skills/       skill discovery and loading
├── apps/
│   ├── cli/                  @wingman/cli: terminal chat
│   └── server/               @wingman/server: NestJS streaming API
│       └── bruno/            Bruno API collection
├── skills/                   skill definitions (SKILL.md)
├── mcp.config.json           MCP server configuration
└── .env                      local configuration (not committed)
```

## Development

| Command | Description |
| --- | --- |
| `npm run dev:cli` | Run the CLI from source. |
| `npm run dev:server` | Build and run the server, restarting on changes in `apps/server`. |
| `npm run build` | Build core, CLI and server. |
| `npm run typecheck` | Type-check every workspace. |
| `npm start -w @wingman/cli` | Run the built CLI. |
| `npm start -w @wingman/server` | Run the built server. |

Notes:

- Run `npm install` from the repository root only. Add a dependency to one
  package with `npm install <pkg> -w @wingman/<name>`.
- The server and the CLI type-check against core's built output. After a fresh
  clone, or after changing core, run `npm run build -w @wingman/core`.
- The server is compiled with SWC rather than the Nest CLI, because TypeScript 7
  no longer ships the JavaScript API that the Nest CLI relies on. SWC also
  emits the decorator metadata Nest's dependency injection needs.

## Security

Wingman can run commands on the machine it is installed on. Treat it
accordingly:

- The server binds to `127.0.0.1` and requires a bearer token. Do not expose it
  to a network without adding real authentication and TLS.
- Keep `WINGMAN_API_TOKEN` secret and long. Generate one with
  `node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'`.
- Approval is enforced inside the agent graph, not by the client. A command
  that needs approval cannot run until someone resumes the turn with `true`.
- Saved threads include the output of commands you approved. Keep your
  Postgres database private.

## Roadmap

- [x] Human approval for shell commands via LangGraph interrupts
- [x] Monorepo with a shared core
- [x] NestJS streaming API
- [x] Durable threads in Postgres
- [ ] Thread list and history endpoints
- [ ] Tool output events in the stream
- [ ] Per-thread event stream, with scheduled tasks moved into the server
- [ ] React web app

## Contributing

Issues and pull requests are welcome. Before opening a pull request:

1. Run `npm run typecheck` and `npm run build`.
2. Try your change in the CLI or against the API.
3. Keep changes focused, and describe what changed and why.

## License

Licensed under the ISC License.
