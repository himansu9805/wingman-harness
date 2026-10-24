<p align="center">
  <img src="assets/branding/wingman-banner.png" alt="Wingman Harness — a pixel-art fighter plane on radar, with the tagline Always watching you six" width="100%">
</p>

<h1 align="center">Wingman Harness</h1>

<p align="center">
  <strong>A self-hosted AI agent harness for your machine and your models.</strong><br>
  Human-approved shell commands, skills, MCP tools, graph memory and scheduled tasks.<br>
  Available through an interactive CLI and a streaming HTTP API.
</p>

<p align="center">
  <a href="https://github.com/himansu9805/wingman-harness/actions/workflows/ci.yml"><img src="https://github.com/himansu9805/wingman-harness/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&amp;logoColor=white" alt="Node.js 22.12 or newer">
  <img src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript 7">
  <img src="https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&amp;logoColor=white" alt="NestJS 12">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache 2.0"></a>
</p>

<p align="center">
  <a href="https://github.com/himansu9805/wingman-harness/wiki/Getting-Started">Getting started</a> ·
  <a href="https://github.com/himansu9805/wingman-harness/wiki">Documentation</a> ·
  <a href="https://github.com/himansu9805/wingman-harness/wiki/HTTP-API">HTTP API</a> ·
  <a href="https://github.com/himansu9805/wingman-harness/wiki/Roadmap">Roadmap</a> ·
  <a href="https://github.com/himansu9805/wingman-harness/issues">Report an issue</a>
</p>

---

## Features

- **Bring your own models.** The chat models can be any OpenAI-compatible
  endpoint, such as [Ollama](https://ollama.com) running locally or OpenAI
  itself. A small classifier routes each turn to a fast or a strong model.
- **Shell access with human approval.** Safe commands run immediately,
  dangerous ones are blocked, and everything else pauses until you approve it.
- **Skills.** Markdown instructions the agent loads only when a task needs
  them.
- **MCP servers.** Tools from any
  [Model Context Protocol](https://modelcontextprotocol.io) server appear next
  to the built-in ones.
- **Long-term memory.** Facts about you and your work, kept in an embedded
  graph database and shared across conversations.
- **Scheduled tasks.** Reminders and recurring jobs, backed by Postgres.
- **Durable conversations.** Threads and pending approvals survive restarts.
- **Two ways in.** An interactive CLI, and a NestJS API with replayable
  thread events delivered as Server-Sent Events.

## How it works

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

    Agent --> Models["Chat models"]
    Core --> PG[("Postgres<br/>threads, jobs, runs")]
    Core --> Graph[("LadybugDB<br/>memory graph")]
```

Each turn runs a [LangGraph](https://langchain-ai.github.io/langgraphjs/) agent
loop. Conversation state is saved after every step, so a turn can pause for
your approval and resume later, even after a restart. See
[Architecture](https://github.com/himansu9805/wingman-harness/wiki/Architecture).

## Quick start

You need **Node.js 22.12+**, an **OpenAI-compatible chat endpoint** (such as
Ollama), a **TypeSafe-compatible classifier** for routing, and **PostgreSQL**.

```bash
git clone https://github.com/himansu9805/wingman-harness.git
cd wingman-harness
npm install
```

Create `.env` in the repository root:

```bash
DECISIONS_MODEL_BASE_URL=<classifier-url>
DECISIONS_MODEL_NAME=<classifier-model>
DECISIONS_MODEL_API_KEY=<classifier-api-key>

FAST_MODEL_BASE_URL=http://localhost:11434/v1
FAST_MODEL_NAME=<fast-model>

STRONG_MODEL_BASE_URL=http://localhost:11434/v1
STRONG_MODEL_NAME=<strong-model>

# Required: persist conversations and pending approvals
POSTGRES_CONNECTION_STRING=postgres://user:password@localhost:5432/wingman

# Required by the HTTP server
WINGMAN_API_TOKEN=<long-random-string>
```

Then start the CLI or the API:

```bash
npm run dev:cli
```

```bash
npm run dev:server
```

The full walkthrough, including model choices and Postgres via Docker, is in
[Getting Started](https://github.com/himansu9805/wingman-harness/wiki/Getting-Started).
Every setting is listed in
[Configuration](https://github.com/himansu9805/wingman-harness/wiki/Configuration).

The CLI shows the selected model and each route's probability, for example
`fast — fast: 51.13%, powerful: 48.87%`. The API's `route` event preserves
these probabilities and raw confidence. See [Routing diagnostics](https://github.com/himansu9805/wingman-harness/wiki/Model-Routing)
for the difference between probability, confidence and classifier errors.

## Example

The HTTP API requires PostgreSQL via `POSTGRES_CONNECTION_STRING`, along with
current model/classifier settings and `WINGMAN_API_TOKEN` shown above.
Start by creating a conversation thread:

```bash
curl http://127.0.0.1:3000/threads \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

The response is `201 {"id":"..."}`. Copy the returned ID into this variable:

```bash
export THREAD_ID='<thread-id>'
```

Open a persistent event subscription in one terminal:

```bash
curl -N "http://127.0.0.1:3000/threads/$THREAD_ID/events" \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN"
```

Send a message from another terminal. The request returns `202 {"runId":"..."}`;
execution continues if either client disconnects.

```bash
curl "http://127.0.0.1:3000/threads/$THREAD_ID/messages" \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"run uptime"}'
```

The subscription receives progress and, when approval is required, an event like:

```text
id: <thread-id>:3
event: approval
data: {"type":"approval","approvals":[{"id":"<approval-id>","command":"uptime"}],"runId":"<run-id>"}
```

Approve using that ID. Resume also returns `202` with a new run ID; tool results
and the final `done` event arrive on the same subscription.

```bash
curl "http://127.0.0.1:3000/threads/$THREAD_ID/resume" \
  -H "Authorization: Bearer $WINGMAN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"answers":{"<approval-id>":true}}'
```

Reconnect using `Last-Event-ID: <thread-id>:<last-received-sequence>` to replay
missed events. Without a cursor, the stream replays the thread's full event log.
The subscription stays open across `approval`, `done` and `error` events.

With `SCHEDULER_ENABLED=true`, the server also runs scheduled jobs and publishes
their results through these events. API-created jobs use their originating thread;
standalone jobs appear as new conversations. Run one server and one scheduler owner
per database. Disable scheduling in a CLI running alongside that server.

Event logs survive restarts; active execution does not automatically restart.
Check history and pending approvals before retrying an interrupted action. Events
are retained until thread deletion; there is no automatic retention policy yet.

See [HTTP API](https://github.com/himansu9805/wingman-harness/wiki/HTTP-API) for
streaming events, approvals, thread listing, history and deletion. A
[Bruno](https://www.usebruno.com) collection lives in
[`apps/server/bruno`](apps/server/bruno).

## Documentation

Detailed documentation lives in the [wiki](https://github.com/himansu9805/wingman-harness/wiki)
throughout pre-release development. A detailed `docs/` directory is planned for v1.0.0.

| Topic | Page |
| --- | --- |
| Setup | [Getting Started](https://github.com/himansu9805/wingman-harness/wiki/Getting-Started) · [Configuration](https://github.com/himansu9805/wingman-harness/wiki/Configuration) |
| Using Wingman | [HTTP API](https://github.com/himansu9805/wingman-harness/wiki/HTTP-API) · [Command Approval and Security](https://github.com/himansu9805/wingman-harness/wiki/Command-Approval-and-Security) · [Scheduled Tasks](https://github.com/himansu9805/wingman-harness/wiki/Scheduled-Tasks) |
| Extending | [Writing Skills](https://github.com/himansu9805/wingman-harness/wiki/Writing-Skills) · [MCP Servers](https://github.com/himansu9805/wingman-harness/wiki/MCP-Servers) · [Memory](https://github.com/himansu9805/wingman-harness/wiki/Memory) |
| Internals | [Architecture](https://github.com/himansu9805/wingman-harness/wiki/Architecture) · [Development](https://github.com/himansu9805/wingman-harness/wiki/Development) · [Troubleshooting](https://github.com/himansu9805/wingman-harness/wiki/Troubleshooting) |

## Security

To report a vulnerability, follow the [security policy](SECURITY.md). Keep
vulnerability details out of public issues and pull requests.

Wingman can run commands on the machine it's installed on. The server binds to
`127.0.0.1` and requires a bearer token; don't expose it to a network without
real authentication and TLS. Commands outside the allow list need your
approval, enforced inside the agent graph, but tools from MCP servers run
without it. Declining stops the current command attempt; explicitly asking to
try it again requires fresh approval. Blocked commands remain blocked. Read
[Command Approval and Security](https://github.com/himansu9805/wingman-harness/wiki/Command-Approval-and-Security)
before going further.

## Contributing

Run `npm test` to test command rules, turn helpers, graph approvals and the HTTP
API without external services. See [Automated tests](https://github.com/himansu9805/wingman-harness/wiki/Testing) for suite
details and focused commands. Tests run in the required CI job alongside the
build and type-check.

Run `npm run dev:server` from the repository root to develop the API. It builds
core first, then watches both core and server source files. Saving changes in
either package rebuilds the affected JavaScript and restarts the server. This
keeps the server's compiled copy of core up to date while you work.

Core's watcher rebuilds JavaScript only. After changing core's exported types,
run `npm run build -w @wingman/core` to refresh its type declarations before
type-checking the CLI or server.

Issues and pull requests are welcome. `main` is protected: changes go through a
pull request, and CI must build and type-check them. See
[Development](https://github.com/himansu9805/wingman-harness/wiki/Development)
for the setup and conventions, and the
[issues](https://github.com/himansu9805/wingman-harness/issues) for planned work.

## License

Copyright 2026 Himansu.

Licensed under the [Apache License, Version 2.0](LICENSE). You may not use this
project except in compliance with the License. Unless required by applicable
law or agreed to in writing, software distributed under the License is
distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
either express or implied. See the [LICENSE](LICENSE) and [NOTICE](NOTICE)
files for details.
