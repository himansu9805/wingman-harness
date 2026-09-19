# Wingman Harness

A local, Ollama-backed agent harness with tool calling, an
Agent-Skills-style progressive disclosure system, MCP server support,
and graph-based long-term memory.

## What it does

A CLI chat loop backed by a ReAct-style LangGraph graph: the model
thinks, optionally calls a tool, the tool runs, and the result goes
back to the model — looping until it has a real answer. Four things
feed into what the model can do:

- **Local tools** — a calculator and a (mocked) weather lookup, just
  enough to exercise tool-calling without needing real APIs.
- **Skills** — markdown files under `skills/` that the model can pull
  in on demand for a specific kind of task (writing a haiku, drafting
  a commit message, whatever you add). It only sees a one-line
  description of each skill up front, and loads the full instructions
  only when a task actually needs them.
- **MCP servers** — point `mcp.config.json` at any MCP server and its
  tools show up alongside your local ones automatically.
- **Memory** — long-term facts persist across sessions as a graph of
  entities and relationships (people, projects, preferences) that the
  model can save to and query on demand. See [Memory](#memory) below.

While it's working, the CLI prints an indicator for what it's
doing — 🔧 when a tool gets called, 📘 when a skill gets pulled in,
🧠 when a memory tool runs — so the loop is visible, not just the
final answer.

## Setup

```bash
npm install
```

Make sure Ollama is running locally with a tool-calling-capable model
pulled:

```bash
ollama pull <name_of_model>
```

Create the `.env` file in the root of the project directory with the
following content:

```plaintext
OLLAMA_MODEL=<name_of_model>
OLLAMA_BASE_URL=http://localhost:11434
```

## Run it

```bash
npm run dev
```

Things worth trying:

- `what's 23 * 47?` — the calculator tool
- `what's the weather in Bengaluru?` — the (mocked) weather tool
- `write me a haiku about the monsoon` — watch it load the
  `haiku-writer` skill before answering
- `remember that I work on Wingman Harness` — watch the 🧠 indicator,
  then ask `what do you know about me?` in the same session
- Ask a couple of follow-up questions in the same session — state
  persists across turns via LangGraph's checkpointer

To build a standalone bundle instead of running through `tsx`:

```bash
npm run build
npm start
```

## Memory

**`memory.lbug`** ([LadybugDB](https://ladybugdb.com), an embedded
graph database) — facts the model has explicitly chosen to remember,
stored as entities (people, projects, topics, facts) connected by
relationships. This is global, not thread-scoped: something
remembered in one conversation is visible in every other one. The
model manages this itself via three tools: `remember`,
`recall_memory`, and `log_conversation`.

To inspect `memory.lbug` directly, install the
[Ladybug CLI](https://docs.ladybugdb.com/client-apis/cli)
(`brew install lbug` on macOS) and query it with Cypher:

```bash
lbug memory.lbug -r
```

```cypher
MATCH (e:Entity) RETURN e.name, e.type, e.notes;
MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) RETURN a.name, r.relation, b.name;
```

One thing worth knowing: if the process ever gets killed uncleanly
(not the normal `/exit` or Ctrl+C, but a hard `kill -9` or crash), you
may see `memory.lbug.wal does not match the current database` on next
startup. Delete the `.wal` file and restart — you'll only lose the
last uncommitted write, not the whole graph.
